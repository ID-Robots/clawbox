#!/usr/bin/env bash
# One-time provisioning of a freshly flashed ClawBox for stock, run as root by
# the factory station. Reads the box's 64-hex device secret on stdin (the same
# secret the station prints on the sticker's Wi-Fi QR code) and installs it
# with scripts/device-secret.sh, which binds it to this board's serial.
#
#   provision-device.sh [--dry-run] < secret-hex
#
# --dry-run validates the secret and the board, prints the plan and writes
# nothing. Nothing secret is ever printed: not the secret, not the PSK.
set -euo pipefail

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
if [ "$DRY_RUN" -eq 1 ]; then
  echo "provision: dry run — nothing written"
  exit 0
fi

printf '%s' "$secret" | "$DEVICE_SECRET_SH" install
unset secret
echo "provision: done — the hotspot uses the sticker credentials from its next start"
