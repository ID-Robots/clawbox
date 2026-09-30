#!/usr/bin/env bash
# Give the x64 laptop kiosk browser a Chrome DevTools (CDP) port, the same way
# the VNC browser (scripts/launch-browser.sh, port 18800) already has one, so
# the OpenClaw agent can screenshot and drive the ClawBox UI the owner is
# looking at on the physical display.
#
# Idempotent: adds the two --remote-debugging flags to
# /usr/local/bin/clawbox-kiosk-browser right after --start-maximized, keeps a
# backup beside it, and (unless --no-restart) reboots so the kiosk session
# picks the flags up (the running launcher loop holds the old flag list). Loopback only: nothing off the laptop can reach it.
#
# Run as root:  sudo scripts/x64-migration/kiosk/enable-kiosk-remote-debugging.sh
set -euo pipefail

LAUNCHER=/usr/local/bin/clawbox-kiosk-browser
PORT="${CLAWBOX_KIOSK_CDP_PORT:-18801}"
RESTART=1
[ "${1:-}" = "--no-restart" ] && RESTART=0

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
[ -f "$LAUNCHER" ] || { echo "$LAUNCHER not found; is this the kiosk laptop?" >&2; exit 1; }

if grep -q -- '--remote-debugging-port=' "$LAUNCHER"; then
  echo "already enabled: $(grep -o -- '--remote-debugging-port=[0-9]*' "$LAUNCHER")"
else
  grep -q '^  --start-maximized$' "$LAUNCHER" || { echo "launcher layout unexpected; not touching it" >&2; exit 1; }
  cp -a "$LAUNCHER" "$LAUNCHER.bak"
  sed -i "s|^  --start-maximized\$|  --start-maximized\n  --remote-debugging-address=127.0.0.1\n  --remote-debugging-port=$PORT|" "$LAUNCHER"
  bash -n "$LAUNCHER"
  echo "enabled CDP on 127.0.0.1:$PORT (backup: $LAUNCHER.bak)"
fi

if [ "$RESTART" -eq 1 ]; then
  # The launcher is a long-running bash loop that evaluated its FLAGS array
  # when the session started; killing only Chromium relaunches it with the
  # OLD flags. The whole kiosk session has to restart: GDM autologin brings
  # it straight back on a reboot, so that is the default.
  if pgrep -f 'bash /usr/local/bin/clawbox-kiosk-browser' >/dev/null; then
    echo "kiosk session is running with the old flags; rebooting in 5s (Ctrl+C to skip; then reboot later)"
    sleep 5
    systemctl reboot
  else
    echo "kiosk session not running; flags apply at next session start"
  fi
fi
