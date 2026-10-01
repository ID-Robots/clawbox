#!/usr/bin/env bash
# Turn the x64 laptop's kiosk browser into a real kiosk, with the tabs managed
# by the ClawBox desktop instead of Chrome's own tab strip.
#
# Adds to /usr/local/bin/clawbox-kiosk-browser, idempotently, right after
# --start-maximized:
#   --remote-debugging-address=127.0.0.1 --remote-debugging-port=$PORT
#       (the loopback CDP port src/lib/kiosk-tabs.ts lists and switches tabs
#        on)
#   --kiosk
#       (no tab strip, no address bar: the desktop's shelf is the tab strip)
#   --load-extension=$EXT --disable-extensions-except=$EXT
#       (kiosk/extension from this checkout: the ClawBox bar on every page
#        the desktop opens, so a page has a way back without the shelf)
#   --force-dark-mode --enable-features=WebUIDarkMode
#       (Chrome's own dialogs, error pages and scrollbars in dark, so they
#        sit with the ClawBox desktop rather than flashing white)
#   --remote-allow-origins=chrome-extension://<id>
#       (the extension's DevTools button, F12 and Ctrl+Shift+I: its worker
#        asks the CDP port above to open DevTools on a tab, and the port
#        refuses a WebSocket from any origin it was not told to allow. <id> is
#        the one Chrome gives an unpacked extension: the first 32 hex digits
#        of the SHA-256 of its path, each written as a..p)
#
# Keeps a backup beside the launcher, checks the result with `bash -n`, and
# (unless --no-restart) reboots so the kiosk session picks the flags up — the
# running launcher loop holds the old FLAGS array. Run it again after any
# update that rewrites the launcher.
#
# Run as root:  sudo scripts/x64-migration/kiosk/install-kiosk-tabs.sh
set -euo pipefail

LAUNCHER=/usr/local/bin/clawbox-kiosk-browser
PORT="${CLAWBOX_KIOSK_CDP_PORT:-18801}"
# The checkout this script is run from, so the extension path follows it.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="${CLAWBOX_KIOSK_EXTENSION:-$(cd "$HERE/../../.." && pwd)/kiosk/extension}"
RESTART=1
[ "${1:-}" = "--no-restart" ] && RESTART=0

# Chrome's id for the unpacked extension at $EXT (see above).
EXT_ID="$(printf '%s' "$EXT" | sha256sum | cut -c1-32 | tr '0-9a-f' 'a-p')"

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
[ -f "$LAUNCHER" ] || { echo "$LAUNCHER not found; is this the kiosk laptop?" >&2; exit 1; }
[ -f "$EXT/manifest.json" ] || { echo "$EXT/manifest.json not found; run from the clawbox checkout" >&2; exit 1; }
grep -q '^  --start-maximized$' "$LAUNCHER" || { echo "launcher layout unexpected; not touching it" >&2; exit 1; }

changed=0
# add_flag LINE — one flag on its own line after --start-maximized, once.
add_flag() {
  local flag="$1"
  if grep -qxF "  $flag" "$LAUNCHER"; then return; fi
  [ "$changed" -eq 1 ] || cp -a "$LAUNCHER" "$LAUNCHER.bak"
  changed=1
  # Appended after the last flag this script owns, so the order in the file
  # is the order above; sed's `a` needs the line, not a pattern, escaped.
  local anchor
  anchor="$(grep -n -- '^  --start-maximized$\|^  --remote-debugging-\|^  --kiosk$\|^  --load-extension=\|^  --disable-extensions-except=\|^  --force-dark-mode$\|^  --enable-features=WebUIDarkMode$\|^  --remote-allow-origins=' "$LAUNCHER" | tail -1 | cut -d: -f1)"
  sed -i "${anchor}a\\  ${flag//\\/\\\\}" "$LAUNCHER"
  echo "added $flag"
}

# A stale remote-debugging line for another port or an old extension path
# would otherwise sit beside the new one; Chrome takes the last, but the file
# should say one thing. Removed from a copy first, so the backup is the
# launcher as it was before ANY edit, and a removal alone still counts as a
# change (the reboot below is what makes the session drop the old flag).
orig="$(mktemp)"
cp -a "$LAUNCHER" "$orig"
sed -i "/^  --remote-debugging-port=/{/=$PORT\$/!d}" "$LAUNCHER"
sed -i "/^  --load-extension=/{\|=$EXT\$|!d}" "$LAUNCHER"
sed -i "/^  --disable-extensions-except=/{\|=$EXT\$|!d}" "$LAUNCHER"
sed -i "/^  --remote-allow-origins=/{\|=chrome-extension://$EXT_ID\$|!d}" "$LAUNCHER"
if ! cmp -s "$orig" "$LAUNCHER"; then
  cp -a "$orig" "$LAUNCHER.bak"
  changed=1
  echo "removed stale kiosk flags"
fi
rm -f "$orig"

add_flag "--remote-debugging-address=127.0.0.1"
add_flag "--remote-debugging-port=$PORT"
add_flag "--kiosk"
add_flag "--load-extension=$EXT"
add_flag "--disable-extensions-except=$EXT"
add_flag "--force-dark-mode"
add_flag "--enable-features=WebUIDarkMode"
add_flag "--remote-allow-origins=chrome-extension://$EXT_ID"

bash -n "$LAUNCHER"
if [ "$changed" -eq 1 ]; then
  echo "launcher updated (backup: $LAUNCHER.bak)"
else
  echo "already installed: CDP on 127.0.0.1:$PORT (DevTools for extension $EXT_ID), --kiosk, dark mode, extension $EXT"
fi

if [ "$RESTART" -eq 1 ] && [ "$changed" -eq 1 ]; then
  if pgrep -f 'bash /usr/local/bin/clawbox-kiosk-browser' >/dev/null; then
    echo "kiosk session is running with the old flags; rebooting in 5s (Ctrl+C to skip; then reboot later)"
    sleep 5
    systemctl reboot
  else
    echo "kiosk session not running; flags apply at next session start"
  fi
fi
