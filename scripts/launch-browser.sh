#!/usr/bin/env bash
set -euo pipefail

# Launch Chromium with CDP remote debugging on the VNC virtual display.
# Called by clawbox-browser-cdp.service (systemd)

CURRENT_USER="$(id -un)"
HOME="${HOME:-$(getent passwd "$CURRENT_USER" | cut -d: -f6)}"
PROFILE="$HOME/.config/clawbox-browser"
CDP_PORT="${CDP_PORT:-18800}"
VNC_STATE_FILE="${HOME}/.cache/clawbox/vnc-display.env"
DEFAULT_DISPLAY="${DISPLAY:-:99}"

display_ready() {
  local display="$1"
  local auth="${2:-${XAUTHORITY:-}}"
  if [ -n "$auth" ] && [ -f "$auth" ]; then
    XAUTHORITY="$auth" xset -display "$display" q >/dev/null 2>&1
  else
    xset -display "$display" q >/dev/null 2>&1
  fi
}

wait_for_display() {
  local display="$1"
  local auth="${2:-${XAUTHORITY:-}}"
  local attempts="${3:-100}"
  local i
  for i in $(seq 1 "$attempts"); do
    if display_ready "$display" "$auth"; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

is_snap_chromium_wrapper() {
  local bin="$1"
  [[ "$bin" == /snap/* ]] && return 0
  [ -f "$bin" ] || return 1
  grep -qE '(/snap/bin/chromium|snap run chromium)' "$bin" 2>/dev/null
}

find_playwright_chromium() {
  # Playwright 1.50+ ships Chrome-for-Testing at chrome-linux64/chrome on
  # amd64 and chrome-linux-arm64/chrome on arm64; older builds used
  # chrome-linux/. Accept any of the three.
  find "$HOME/.cache/ms-playwright" -type f \
    \( -path "*/chrome-linux/chrome" \
       -o -path "*/chrome-linux64/chrome" \
       -o -path "*/chrome-linux-arm64/chrome" \) \
    2>/dev/null | sort -V | tail -1 || true
}

if [ -f "$VNC_STATE_FILE" ]; then
  # shellcheck disable=SC1090
  source "$VNC_STATE_FILE"
fi

DISPLAY="${CLAWBOX_VNC_DISPLAY:-$DEFAULT_DISPLAY}"
[ -n "${CLAWBOX_VNC_XAUTHORITY:-}" ] && export XAUTHORITY="$CLAWBOX_VNC_XAUTHORITY"

# Find chromium — prefer non-snap binaries (snap fails in system services due to cgroup confinement)
CHROMIUM=""

# 1. Playwright-managed Chromium (no snap restrictions, preferred)
PW_CHROME="$(find_playwright_chromium)"
[ -n "$PW_CHROME" ] && [ -x "$PW_CHROME" ] && CHROMIUM="$PW_CHROME"

# 2. Non-snap system binaries
if [ -z "$CHROMIUM" ]; then
  for bin in chromium-browser google-chrome-stable google-chrome chromium; do
    p=$(command -v "$bin" 2>/dev/null) || true
    if [ -n "$p" ] && ! is_snap_chromium_wrapper "$p"; then
      CHROMIUM="$p"
      break
    fi
  done
fi

[ -z "$CHROMIUM" ] && {
  if command -v chromium-browser >/dev/null 2>&1 || [ -x /snap/bin/chromium ]; then
    echo "No service-safe Chromium binary found. Install the Playwright Chromium runtime or a non-snap Chromium build." >&2
  else
    echo "Chromium not found" >&2
  fi
  exit 1
}

# Check if already running
if curl -s "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; then
  echo "Browser already running on CDP port $CDP_PORT"
  exit 0
fi

if ! wait_for_display "$DISPLAY" "${XAUTHORITY:-}"; then
  echo "Display $DISPLAY is not ready for Chromium" >&2
  exit 1
fi

mkdir -p "$PROFILE"

# In the e2e test container Chromium's namespace sandbox can't initialize
# because AppArmor disables unprivileged user namespaces. The sandbox is
# fine on real Jetson — so we only pass --no-sandbox when explicitly in
# test mode, never in production.
SANDBOX_FLAGS=()
if [ "${CLAWBOX_TEST_MODE:-0}" = "1" ]; then
  SANDBOX_FLAGS=(--no-sandbox --disable-setuid-sandbox)
fi

echo "Starting Chromium from $CHROMIUM on DISPLAY=$DISPLAY with CDP port $CDP_PORT"
exec env DISPLAY="$DISPLAY" HOME="$HOME" DBUS_SESSION_BUS_ADDRESS="disabled:" \
  "$CHROMIUM" \
  "${SANDBOX_FLAGS[@]}" \
  --remote-debugging-port="$CDP_PORT" \
  --remote-allow-origins=* \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --start-maximized \
  --disable-gpu \
  --disable-dev-shm-usage \
  --disable-background-networking \
  --password-store=basic \
  --metrics-recording-only \
  "https://www.google.com"
