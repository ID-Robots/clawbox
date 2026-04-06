#!/bin/bash
# Launch Chromium with CDP remote debugging on the VNC virtual display.
# Called by clawbox-browser-cdp.service (systemd)

USER="clawbox"
HOME="/home/$USER"
PROFILE="$HOME/.config/clawbox-browser"
CDP_PORT="${CDP_PORT:-18800}"
DISPLAY="${DISPLAY:-:99}"

# Find chromium — prefer non-snap binaries (snap fails in system services due to cgroup confinement)
CHROMIUM=""

# 1. Playwright-managed Chromium (no snap restrictions, preferred)
PW_CHROME=$(find "$HOME/.cache/ms-playwright" -name "chrome" -path "*/chrome-linux/chrome" 2>/dev/null | sort -V | tail -1)
[ -n "$PW_CHROME" ] && [ -x "$PW_CHROME" ] && CHROMIUM="$PW_CHROME"

# 2. Non-snap system binaries
if [ -z "$CHROMIUM" ]; then
  for bin in chromium-browser google-chrome-stable google-chrome chromium; do
    p=$(which "$bin" 2>/dev/null) || true
    if [ -n "$p" ] && [[ "$p" != /snap/* ]]; then
      CHROMIUM="$p" && break
    fi
  done
fi

# 3. Snap fallback (may fail in system services — last resort)
[ -z "$CHROMIUM" ] && [ -x /snap/bin/chromium ] && CHROMIUM="/snap/bin/chromium"

[ -z "$CHROMIUM" ] && echo "Chromium not found" >&2 && exit 1

# Check if already running
if curl -s "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; then
  echo "Browser already running on CDP port $CDP_PORT"
  exit 0
fi

# Reset profile on each start to avoid corruption from version changes
# (This is a CDP automation browser, not a persistent user browser)
rm -rf "$PROFILE"
mkdir -p "$PROFILE"

echo "Starting Chromium on DISPLAY=$DISPLAY with CDP port $CDP_PORT"
exec env DISPLAY="$DISPLAY" HOME="$HOME" DBUS_SESSION_BUS_ADDRESS="disabled:" \
  "$CHROMIUM" \
  --remote-debugging-port="$CDP_PORT" \
  --remote-allow-origins=* \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --start-maximized \
  --disable-gpu \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-features=Crashpad \
  --enable-crash-reporter="" \
  --no-zygote \
  --disable-background-networking \
  --password-store=basic \
  --metrics-recording-only \
  "https://www.google.com"
