#!/usr/bin/env bash
# One-time provisioning of a freshly flashed ClawBox for stock, run as root by
# the factory station. Reads the box's 64-hex device secret on stdin (the same
# secret the station prints on the sticker's Wi-Fi QR code) and installs it
# with scripts/device-secret.sh, which binds it to this board's serial, and
# writes /etc/clawbox/provisioned: the marker that puts the box on the
# per-device flow (src/lib/device-provisioning.ts). Boxes without it — every
# box set up before this flow — keep their behaviour exactly as it was.
#
# It also sets the account's initial system/SSH password to the sticker's Wi-Fi
# password (device-secret.sh set-password), replacing the image's universal
# one. SSH stays on as the image ships it; the setup wizard replaces the
# password with the owner's own, and a factory reset puts the sticker one back.
#
# Stock boxes ONLY. A box that shows ANY sign of an owner (setup completed,
# owner password flag, own hotspot settings, an owner password in /etc/shadow)
# is refused, and so is a box whose state cannot be read: provisioning an
# existing customer's box would change its hotspot under them.
#
#   provision-device.sh [--dry-run] < secret-hex
#
# --dry-run validates the secret and the board, prints the plan and writes
# nothing. Nothing secret is ever printed: not the secret, not the PSK.
set -euo pipefail

ETC_DIR="${CLAWBOX_ETC:-/etc/clawbox}"
ACCOUNT="${CLAWBOX_USER:-clawbox}"
DATA_DIR="${CLAWBOX_ROOT:-/home/$ACCOUNT/clawbox}/data"
LEGACY_IMAGE_PASSWORD="clawbox"
DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "") ;;
  *) echo "usage: provision-device.sh [--dry-run] < secret-hex" >&2; exit 64 ;;
esac

HERE="$(dirname "${BASH_SOURCE[0]}")"
DEVICE_SECRET_SH="$HERE/device-secret.sh"
[ -x "$DEVICE_SECRET_SH" ] || { echo "provision: $DEVICE_SECRET_SH missing" >&2; exit 1; }

if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  echo "provision: must run as root" >&2
  exit 1
fi

secret="$(head -c 256 | tr -d ' \t\r\n' | tr 'A-F' 'a-f')"
if [ "${#secret}" -ne 64 ] || ! [[ "$secret" =~ ^[0-9a-f]+$ ]]; then
  echo "provision: expected 64 hex characters on stdin" >&2
  exit 2
fi
# The derived SSID is printed on the sticker too, so it may be shown here; the
# passphrase never is.
ssid="$(printf '%s' "$secret" | "$DEVICE_SECRET_SH" derive | sed -n 's/^SSID=//p')"

echo "provision: plan"
echo "  - install the device secret for this board (hotspot SSID $ssid, WPA2)"
echo "  - mark the box provisioned ($ETC_DIR/provisioned)"
echo "  - set the initial system/SSH password to the sticker Wi-Fi password (SSH stays on)"

# owned | unowned | unknown. Several independent signals; any one of them, or
# any doubt, means "not a stock box".
owner_state() {
  local cfg="$DATA_DIR/config.json" st rc=0
  if [ -f "$cfg" ] && grep -E -q '"(setup_complete|password_configured)":[[:space:]]*true' "$cfg" 2>/dev/null; then
    echo owned; return
  fi
  if [ -e "$DATA_DIR/hotspot.env" ]; then echo owned; return; fi
  st="$(passwd -S "$ACCOUNT" 2>/dev/null | awk 'NR==1 {print $2}')" || true
  case "$st" in
    NP|L) echo unowned; return ;;
    P) ;;
    *) echo unknown; return ;;
  esac
  printf '%s\0' "$LEGACY_IMAGE_PASSWORD" \
    | runuser -u "$ACCOUNT" -- /usr/sbin/unix_chkpwd "$ACCOUNT" nonull >/dev/null 2>&1 || rc=$?
  case "$rc" in 0) echo unowned ;; 7) echo owned ;; *) echo unknown ;; esac
}
state="$(owner_state)"
if [ "$state" != unowned ]; then
  echo "provision: refusing — this box is not an unowned stock box (state: $state); an already set-up box keeps its current behaviour" >&2
  exit 3
fi
if [ "$DRY_RUN" -eq 1 ]; then
  echo "provision: dry run — nothing written"
  exit 0
fi

printf '%s' "$secret" | "$DEVICE_SECRET_SH" install
unset secret
install -d -m 0755 "$ETC_DIR"
marker_tmp="$(mktemp "$ETC_DIR/.provisioned.XXXXXX")"
printf 'provisioned\n' >"$marker_tmp"
chmod 0644 "$marker_tmp"
mv -f "$marker_tmp" "$ETC_DIR/provisioned"
CLAWBOX_USER="$ACCOUNT" "$DEVICE_SECRET_SH" set-password
echo "provision: done — sticker hotspot from its next start; system/SSH password = sticker password"
