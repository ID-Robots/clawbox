#!/bin/bash
# Launch Chromium with CDP remote debugging on the VNC virtual display.
# Called by clawbox-browser-cdp.service (systemd)

USER="clawbox"
HOME="/home/$USER"
PROFILE="$HOME/.config/clawbox-browser"
CDP_PORT="${CDP_PORT:-18800}"
DISPLAY="${DISPLAY:-:99}"

# Find chromium
CHROMIUM=""
for bin in chromium-browser chromium google-chrome-stable; do
  p=$(which "$bin" 2>/dev/null) && CHROMIUM="$p" && break
done
[ -z "$CHROMIUM" ] && [ -x /snap/bin/chromium ] && CHROMIUM="/snap/bin/chromium"
[ -z "$CHROMIUM" ] && echo "Chromium not found" >&2 && exit 1

# Check if already running
if curl -s "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; then
  echo "Browser already running on CDP port $CDP_PORT"
  exit 0
fi

# Clean lock files
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonSocket" "$PROFILE/SingletonCookie"
mkdir -p "$PROFILE"
chown -R "$USER:$USER" "$PROFILE"

echo "Starting Chromium on DISPLAY=$DISPLAY with CDP port $CDP_PORT"
exec runuser -u "$USER" -- env DISPLAY="$DISPLAY" HOME="$HOME" \
  "$CHROMIUM" \
  --remote-debugging-port="$CDP_PORT" \
  --remote-allow-origins=* \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --start-maximized \
  --disable-gpu \
  --restore-last-session \
  "https://www.google.com"
