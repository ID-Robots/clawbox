#!/bin/bash
# =============================================================================
# clawbox-nvme-boot-order -- NVMe first in UEFI BootOrder, network boot last.
# =============================================================================
# The UEFI firmware owns BootOrder, and it rewrites it on its own: when it
# re-creates a boot option (after a firmware/capsule update, an NVRAM reset, or
# a boot where the SSD was not enumerated in time) the new option goes to the
# top or the bottom of BootOrder, and at the bottom the NVMe SSD sits BELOW the
# "UEFI Shell" entry. That entry is active, the firmware boots it as soon as
# everything before it failed, and the Shell switches the boot watchdog off: the
# box waits at its prompt until someone pulls the plug, on every boot after.
# Units flashed before the factory added this guard do not have it; install.sh
# (step_uefi_boot_order, also run by every in-app update) installs it there. It
# runs on every boot and fixes BootOrder from Linux, so a drifted order is
# repaired before the next reboot:
#   - every NVMe entry moves to the front of BootOrder (relative order kept)
#   - every PXE/HTTP entry moves to the back and stays ACTIVE. Neither an
#     inactive (-A) nor a deleted (-B) network entry lasts a boot: the L4T
#     firmware (Quick Boot off) enumerates every device at each power-on, deletes
#     each auto-created entry that no longer matches what it found (an inactive
#     one does not: the attributes are compared too) and creates it again,
#     active. Measured on Orin Nano boards (TASK-2175): deactivated, deleted, or
#     dropped from BootOrder, they were all back and active on the next boot.
#     Left active, they match, and the firmware leaves them where they are.
#   - NewDeviceHierarchy (NVIDIA's "Add new devices to top or bottom of boot
#     order") is set to 1, top, NVIDIA's own default: an NVMe entry the firmware
#     has to create again goes to the TOP and boots, not under the Shell. (With 0
#     it went to the bottom. Network entries that are not deactivated are never
#     created again, so they no longer come back on top.) Variable name, GUID
#     and values: NVIDIA edk2-nvidia, gNVIDIAPublicVariableGuid.
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

# This variable is written through efivarfs, not efibootmgr. efivarfs is 4
# bytes of attributes, then the data; this one is a single UINT8.
EFIVARS="${EFIVARS_DIR:-/sys/firmware/efi/efivars}"
NDH="$EFIVARS/NewDeviceHierarchy-781e084c-a330-417c-b678-38e696380cb9"
# Read whole, not with od -j: efivarfs files are not guaranteed to seek.
ndh_value() {
    [ -r "$NDH" ] && od -An -v -tu1 "$NDH" 2>/dev/null |
        awk '{ for (i = 1; i <= NF; i++) b[n++] = $i } END { if (n == 5) print b[4] }'
}
ndh_top() {
    local attr
    # Keep the attributes it was created with; UEFI refuses a write that
    # changes them. Absent, it gets NVIDIA's own: BS|NV|RT (07 00 00 00).
    attr="$(od -An -tx1 -N4 "$NDH" 2>/dev/null | tr -d ' \n')"
    [[ ${#attr} -eq 8 && "$attr" =~ ^[0-9a-f]+$ ]] || attr=07000000
    # efivarfs marks variables immutable; one write() carries attributes + data.
    chattr -i "$NDH" 2>/dev/null
    printf '%b' "$(printf '%s' "$attr" | sed 's/../\\x&/g')\\x01" > "$NDH" 2>/dev/null
    local rc=$?
    chattr +i "$NDH" 2>/dev/null
    return $rc
}
NDH_WAS="$(ndh_value)"

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
    [[ "$line" =~ ^Boot([0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f])(\*?)[[:space:]] ]] || continue
    n="${BASH_REMATCH[1]^^}"
    KIND[$n]="$(classify "$line")"
    [ -n "${BASH_REMATCH[2]}" ] && ACTIVE[$n]=1
done <<< "$OUT"

NVME=(); OTHER=(); NET=(); NET_INACTIVE=()
IFS=',' read -r -a ORD <<< "$ORDER"
for n in "${ORD[@]}"; do
    case "${KIND[$n]:-}" in
        nvme) NVME+=("$n") ;;
        net)  NET+=("$n")
              [ -n "${ACTIVE[$n]:-}" ] || NET_INACTIVE+=("$n") ;;
        *)    OTHER+=("$n") ;;   # includes entries efibootmgr did not list
    esac
done

[ "${#NVME[@]}" -gt 0 ] || bail "no NVMe entry in BootOrder ($ORDER); leaving it alone"

WANT="$(IFS=,; echo "${NVME[*]}${OTHER[*]:+,${OTHER[*]}}${NET[*]:+,${NET[*]}}")"
WANT="${WANT// /,}"

if [ "$MODE" = "--check" ]; then
    if [ "$ORDER" = "$WANT" ] && [ "${#NET_INACTIVE[@]}" -eq 0 ] && [ "$NDH_WAS" = "1" ]; then
        log "ok: BootOrder $ORDER, network boot last and left to the firmware, new devices on top"; exit 0
    fi
    log "BootOrder $ORDER (want $WANT); inactive network entries: ${NET_INACTIVE[*]:-none};" \
        "NewDeviceHierarchy ${NDH_WAS:-absent} (want 1)"
    exit 1
fi

RC=0
if [ "$ORDER" != "$WANT" ]; then
    log "BootOrder $ORDER -> $WANT"
    "$EFIBOOTMGR" -q -o "$WANT" || RC=1
fi
# An entry an older guard deactivated: active again, so the firmware finds it
# matching and leaves it at the bottom instead of creating it anew.
for n in "${NET_INACTIVE[@]}"; do
    log "reactivating network boot entry Boot$n (the firmware would re-create it)"
    "$EFIBOOTMGR" -q -b "$n" -a || RC=1
done
# Last, once the network entries are active: with them still inactive, the
# next boot would re-create them, and with 1 put them on top.
if [ "$NDH_WAS" != "1" ]; then
    if [ "$RC" -eq 0 ] && [ -d "$EFIVARS" ] && ndh_top && [ "$(ndh_value)" = "1" ]; then
        log "NewDeviceHierarchy ${NDH_WAS:-absent} -> 1: a boot device the firmware creates again goes to the top"
    else
        log "WARNING: did not set NewDeviceHierarchy to 1 (top); it reads ${NDH_WAS:-absent}"
        RC=1
    fi
fi
if [ "$RC" -eq 0 ]; then
    log "ok: NVMe first (${NVME[*]}), network boot last, new devices on top"
else
    log "WARNING: a write failed; see above"
fi
exit 0
