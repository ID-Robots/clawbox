#!/bin/bash
# =============================================================================
# clawbox-nvme-boot-order -- NVMe first in UEFI BootOrder, network boot off.
# =============================================================================
# The UEFI firmware owns BootOrder, and it rewrites it on its own: when it
# re-creates a boot option (after a firmware/capsule update, an NVRAM reset, or
# a boot where the SSD was not enumerated in time) the new option is appended,
# so the NVMe SSD can end up BELOW the network, USB and shell entries. With a
# LAN cable in, the box then waits out PXE/HTTP or stops in the boot menu and
# never reaches the SSD. Units flashed before the factory added this guard do
# not have it; install.sh (step_uefi_boot_order, also run by every in-app
# update) installs it there. It runs on every boot and fixes BootOrder from
# Linux, so a drifted order is repaired before the next reboot:
#   - every NVMe entry moves to the front of BootOrder (relative order kept)
#   - every PXE/HTTP entry moves to the back and is marked inactive (-A), so
#     the firmware skips it. It is not deleted: UEFI re-creates a deleted
#     network entry on the next boot, but leaves an inactive one alone.
#   - NewDeviceHierarchy (NVIDIA's "Add new devices to top or bottom of boot
#     order") is set to 0, bottom: with 1, the firmware puts every PXE/HTTP
#     option it re-creates at power-on back at the TOP (variable name, GUID
#     and values: NVIDIA edk2-nvidia, gNVIDIAPublicVariableGuid)
#   - nothing is written when the state is already right (idempotent)
#
#   clawbox-nvme-boot-order            # apply
#   clawbox-nvme-boot-order --check    # exit 0 if already right, 1 if not
#
# Apply mode never fails the boot: no efibootmgr, no efivars or no NVMe entry
# exits 0 with a message.
# =============================================================================
set -u
EFIBOOTMGR="${EFIBOOTMGR:-efibootmgr}"
MODE="${1:-apply}"
log() { echo "clawbox-nvme-boot-order: $*"; }
bail() { log "$*"; [ "$MODE" = "--check" ] && exit 2; exit 0; }

# Before efibootmgr is needed: this variable is written through efivarfs.
# efivarfs is 4 bytes of attributes, then the data; this one is a single UINT8.
EFIVARS="${EFIVARS_DIR:-/sys/firmware/efi/efivars}"
NDH="$EFIVARS/NewDeviceHierarchy-781e084c-a330-417c-b678-38e696380cb9"
# Read whole, not with od -j: efivarfs files are not guaranteed to seek.
ndh_value() {
    [ -r "$NDH" ] && od -An -v -tu1 "$NDH" 2>/dev/null |
        awk '{ for (i = 1; i <= NF; i++) b[n++] = $i } END { if (n == 5) print b[4] }'
}
ndh_bottom() {
    local attr
    # Keep the attributes it was created with; UEFI refuses a write that
    # changes them. Absent, it gets NVIDIA's own: BS|NV|RT (07 00 00 00).
    attr="$(od -An -tx1 -N4 "$NDH" 2>/dev/null | tr -d ' \n')"
    [[ "$attr" =~ ^[0-9a-f]{8}$ ]] || attr=07000000
    # efivarfs marks variables immutable; one write() carries attributes + data.
    chattr -i "$NDH" 2>/dev/null
    printf '%b' "$(printf '%s' "$attr" | sed 's/../\\x&/g')\\x00" > "$NDH" 2>/dev/null
    local rc=$?
    chattr +i "$NDH" 2>/dev/null
    return $rc
}
NDH_WAS="$(ndh_value)"
NDH_OK=true
if [ "$NDH_WAS" != "0" ]; then
    NDH_OK=false
    if [ "$MODE" != "--check" ] && [ -d "$EFIVARS" ]; then
        if ndh_bottom && [ "$(ndh_value)" = "0" ]; then
            log "NewDeviceHierarchy ${NDH_WAS:-absent} -> 0: new boot devices go to the bottom of BootOrder"
            NDH_OK=true
        else
            log "WARNING: could not set NewDeviceHierarchy to 0 (bottom); it reads ${NDH_WAS:-absent}"
        fi
    fi
fi

command -v "$EFIBOOTMGR" >/dev/null 2>&1 || bail "efibootmgr not installed; nothing done"
OUT="$("$EFIBOOTMGR" -v 2>&1)" || bail "efibootmgr -v failed (no EFI runtime variables?): $OUT"

ORDER="$(printf '%s\n' "$OUT" | sed -n 's/^BootOrder: *//p' | head -1)"
ORDER="${ORDER^^}"
ORDER="${ORDER//[[:space:]]/}"

classify() { # one Boot#### line -> nvme | net | other
    case "$1" in
        *NVMe\(*) echo nvme ;;
        *PXEv4*|*PXEv6*|*HTTPv4*|*HTTPv6*|*PXE*|*HTTP*) echo net ;;
        */MAC\(*/IPv4\(*|*/MAC\(*/IPv6\(*) echo net ;;
        *[Nn][Vv][Mm][Ee]*) echo nvme ;;
        *) echo other ;;
    esac
}

declare -A KIND=() ACTIVE=()
while IFS= read -r line; do
    [[ "$line" =~ ^Boot([0-9A-Fa-f]{4})(\*?)[[:space:]] ]] || continue
    n="${BASH_REMATCH[1]^^}"
    KIND[$n]="$(classify "$line")"
    [ -n "${BASH_REMATCH[2]}" ] && ACTIVE[$n]=1
done <<< "$OUT"

NVME=(); OTHER=(); NET=(); NET_ACTIVE=()
IFS=',' read -r -a ORD <<< "$ORDER"
for n in "${ORD[@]}"; do
    case "${KIND[$n]:-}" in
        nvme) NVME+=("$n") ;;
        net)  NET+=("$n") ;;
        *)    OTHER+=("$n") ;;   # includes entries efibootmgr did not list
    esac
done
for n in $(printf '%s\n' "${!KIND[@]}" | sort); do
    [ "${KIND[$n]}" = net ] && [ -n "${ACTIVE[$n]:-}" ] && NET_ACTIVE+=("$n")
done

[ "${#NVME[@]}" -gt 0 ] || bail "no NVMe entry in BootOrder ($ORDER); leaving it alone"

WANT="$(IFS=,; echo "${NVME[*]}${OTHER[*]:+,${OTHER[*]}}${NET[*]:+,${NET[*]}}")"
WANT="${WANT// /,}"

if [ "$MODE" = "--check" ]; then
    if [ "$ORDER" = "$WANT" ] && [ "${#NET_ACTIVE[@]}" -eq 0 ] && [ "$NDH_OK" = true ]; then
        log "ok: BootOrder $ORDER, network boot inactive, new devices at the bottom"; exit 0
    fi
    log "BootOrder $ORDER (want $WANT); active network entries: ${NET_ACTIVE[*]:-none};" \
        "NewDeviceHierarchy ${NDH_WAS:-absent} (want 0)"
    exit 1
fi

RC=0
if [ "$ORDER" != "$WANT" ]; then
    log "BootOrder $ORDER -> $WANT"
    "$EFIBOOTMGR" -q -o "$WANT" || RC=1
fi
for n in "${NET_ACTIVE[@]}"; do
    log "deactivating network boot entry Boot$n"
    "$EFIBOOTMGR" -q -b "$n" -A || RC=1
done
[ "$NDH_OK" = true ] || RC=1
if [ "$RC" -eq 0 ]; then
    log "ok: NVMe first (${NVME[*]}), network boot inactive, new devices at the bottom"
else
    log "WARNING: a write failed; see above"
fi
exit 0
