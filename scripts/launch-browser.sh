#!/usr/bin/env bash
set -euo pipefail

# Launch Chromium with CDP remote debugging on the VNC virtual display.
# Called by clawbox-browser.service (systemd)
#
# `launch-browser.sh --print-config` prints the profile, port and executable
# this would use and exits — the test that keeps these rules and
# src/lib/desktop-browser-config.ts in step runs it.

CURRENT_USER="$(id -un)"
HOME="${HOME:-$(getent passwd "$CURRENT_USER" | cut -d: -f6)}"
DEFAULT_PROFILE="$HOME/.config/clawbox-browser"
DEFAULT_CDP_PORT=18800
VNC_STATE_FILE="${HOME}/.cache/clawbox/vnc-display.env"
# The owner's start page, written by the web server (src/lib/browser-setup.ts)
# because systemd is what starts this browser — the setting cannot be passed as
# an argument from the page that changed it. The same file names the owner's
# own browser, when they have one: CLAWBOX_BROWSER_PROFILE_DIR,
# CLAWBOX_BROWSER_CDP_PORT and CLAWBOX_BROWSER_EXECUTABLE (the rules are
# src/lib/desktop-browser-config.ts's, which the web server reads).
BROWSER_STATE_FILE="${CLAWBOX_BROWSER_ENV_FILE:-${HOME}/.cache/clawbox/browser.env}"
DEFAULT_DISPLAY="${DISPLAY:-:99}"
DEFAULT_START_URL="about:blank"

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

trim() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}

# `~`, `$HOME` and `${HOME}` at the start of a value the file kept literal
# (single-quoted), the way the web server expands them.
expand_home() {
  local v="$1"
  case "$v" in
    "~"|'$HOME'|'${HOME}') v="$HOME" ;;
    "~/"*) v="$HOME/${v#"~/"}" ;;
    '$HOME/'*) v="$HOME/${v#'$HOME/'}" ;;
    '${HOME}/'*) v="$HOME/${v#'${HOME}/'}" ;;
  esac
  printf '%s' "$v"
}

# Absolute, no whitespace, quote or backslash, no `.`/`..` segment, not `/`.
# Prints the path with its trailing slashes removed; fails when unusable.
normalize_profile_dir() {
  local v
  v="$(expand_home "$1")"
  [[ "$v" == /* ]] || return 1
  local unsafe="[[:space:]'\"\\\\]"
  [[ "$v" =~ $unsafe ]] && return 1
  while [[ "$v" == */ ]]; do v="${v%/}"; done
  [ -n "$v" ] || return 1
  [[ "/$v/" == */./* || "/$v/" == */../* ]] && return 1
  printf '%s' "$v"
}

# 1024-65535, digits only. Prints it without leading zeros.
normalize_cdp_port() {
  local v="$1"
  # Length by ${#v}, not a bounded repeat (src/tests/unit/shell-regex-hygiene.test.ts).
  [[ "$v" =~ ^[0-9]+$ ]] && (( ${#v} <= 5 )) || return 1
  v=$((10#$v))
  (( v >= 1024 && v <= 65535 )) || return 1
  printf '%s' "$v"
}

# Absolute. Whether it is there and runnable is decided at launch, below.
normalize_executable() {
  local v
  v="$(expand_home "$1")"
  [[ "$v" == /* ]] || return 1
  printf '%s' "$v"
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

# The environment outranks the file, key by key: remember what it set before
# sourcing the file can overwrite it. (The unit's own CDP_PORT=18800 is the
# old knob the web server never read; it no longer decides anything.)
ENV_PROFILE_DIR="$(trim "${CLAWBOX_BROWSER_PROFILE_DIR:-}")"
ENV_CDP_PORT="$(trim "${CLAWBOX_BROWSER_CDP_PORT:-}")"
ENV_EXECUTABLE="$(trim "${CLAWBOX_BROWSER_EXECUTABLE:-}")"
unset CLAWBOX_BROWSER_PROFILE_DIR CLAWBOX_BROWSER_CDP_PORT CLAWBOX_BROWSER_EXECUTABLE

if [ -f "$BROWSER_STATE_FILE" ]; then
  # shellcheck disable=SC1090
  source "$BROWSER_STATE_FILE"
fi

START_URL="${CLAWBOX_BROWSER_START_URL:-$DEFAULT_START_URL}"

[ -n "$ENV_PROFILE_DIR" ] && CLAWBOX_BROWSER_PROFILE_DIR="$ENV_PROFILE_DIR"
[ -n "$ENV_CDP_PORT" ] && CLAWBOX_BROWSER_CDP_PORT="$ENV_CDP_PORT"
[ -n "$ENV_EXECUTABLE" ] && CLAWBOX_BROWSER_EXECUTABLE="$ENV_EXECUTABLE"

# A value that is set but unusable is a warning and the default, never a guess
# — the web server applies the same rule, so both always name the same profile
# and port.
PROFILE="$DEFAULT_PROFILE"
if [[ -n "${CLAWBOX_BROWSER_PROFILE_DIR:-}" && ! "$CLAWBOX_BROWSER_PROFILE_DIR" =~ ^[[:space:]]*$ ]]; then
  if p="$(normalize_profile_dir "$(trim "$CLAWBOX_BROWSER_PROFILE_DIR")")"; then
    PROFILE="$p"
  else
    echo "CLAWBOX_BROWSER_PROFILE_DIR must be an absolute path without spaces or quotes; using $DEFAULT_PROFILE" >&2
  fi
fi
CDP_PORT="$DEFAULT_CDP_PORT"
if [[ -n "${CLAWBOX_BROWSER_CDP_PORT:-}" && ! "$CLAWBOX_BROWSER_CDP_PORT" =~ ^[[:space:]]*$ ]]; then
  if p="$(normalize_cdp_port "$(trim "$CLAWBOX_BROWSER_CDP_PORT")")"; then
    CDP_PORT="$p"
  else
    echo "CLAWBOX_BROWSER_CDP_PORT must be a port from 1024 to 65535; using $DEFAULT_CDP_PORT" >&2
  fi
fi
CONFIGURED_EXECUTABLE=""
if [[ -n "${CLAWBOX_BROWSER_EXECUTABLE:-}" && ! "$CLAWBOX_BROWSER_EXECUTABLE" =~ ^[[:space:]]*$ ]]; then
  if p="$(normalize_executable "$(trim "$CLAWBOX_BROWSER_EXECUTABLE")")"; then
    CONFIGURED_EXECUTABLE="$p"
  else
    echo "CLAWBOX_BROWSER_EXECUTABLE must be an absolute path; finding Chromium automatically" >&2
  fi
fi

if [ "${1:-}" = "--print-config" ]; then
  printf 'PROFILE=%s\nCDP_PORT=%s\nEXECUTABLE=%s\n' "$PROFILE" "$CDP_PORT" "$CONFIGURED_EXECUTABLE"
  exit 0
fi

DISPLAY="${CLAWBOX_VNC_DISPLAY:-$DEFAULT_DISPLAY}"
[ -n "${CLAWBOX_VNC_XAUTHORITY:-}" ] && export XAUTHORITY="$CLAWBOX_VNC_XAUTHORITY"

# Find chromium — prefer non-snap binaries (snap fails in system services due to cgroup confinement)
CHROMIUM=""

# 0. The owner's own browser, when they named one. Never swapped for another
# build: a different browser on the owner's profile could migrate it or fail
# to read its sign-ins, which is worse than not starting.
if [ -n "$CONFIGURED_EXECUTABLE" ]; then
  if [ ! -f "$CONFIGURED_EXECUTABLE" ] || [ ! -x "$CONFIGURED_EXECUTABLE" ]; then
    echo "The configured browser $CONFIGURED_EXECUTABLE (CLAWBOX_BROWSER_EXECUTABLE) is not an executable file" >&2
    exit 1
  fi
  if is_snap_chromium_wrapper "$CONFIGURED_EXECUTABLE"; then
    echo "The configured browser $CONFIGURED_EXECUTABLE is the snap build, which a system service cannot start" >&2
    exit 1
  fi
  CHROMIUM="$CONFIGURED_EXECUTABLE"
fi

# 1. Playwright-managed Chromium (no snap restrictions, preferred)
if [ -z "$CHROMIUM" ]; then
  PW_CHROME="$(find_playwright_chromium)"
  [ -n "$PW_CHROME" ] && [ -x "$PW_CHROME" ] && CHROMIUM="$PW_CHROME"
fi

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

# The owner's own profile (not ClawBox's), open in a browser that does not
# answer on the port: a second Chromium on it would only hand the start page
# to that one as a stray tab and exit. Chromium's SingletonLock names the
# holder as <hostname>-<pid>. ClawBox's own profile keeps its old recovery
# (the web server clears that one's stale locks before starting it).
if [ "$PROFILE" != "$DEFAULT_PROFILE" ] && [ -L "$PROFILE/SingletonLock" ]; then
  lock_holder="$(readlink "$PROFILE/SingletonLock" 2>/dev/null || true)"
  lock_pid="${lock_holder##*-}"
  if [[ "$lock_pid" =~ ^[0-9]+$ ]] && [ -d "/proc/$lock_pid" ]; then
    echo "The browser profile $PROFILE is already open (pid $lock_pid) without remote debugging on port $CDP_PORT; not starting a second browser on it" >&2
    exit 1
  fi
fi

if ! wait_for_display "$DISPLAY" "${XAUTHORITY:-}"; then
  echo "Display $DISPLAY is not ready for Chromium" >&2
  exit 1
fi

mkdir -p "$PROFILE"

# Chromium's namespace sandbox can't initialize when the kernel restricts
# unprivileged user namespaces — this is the default on Ubuntu 23.10+ via
# AppArmor (`kernel.apparmor_restrict_unprivileged_userns=1`), and also
# how the e2e test container is configured. In both cases there's no
# meaningful additional security from the sandbox here (single-user
# AI-controlled browser on an isolated profile, not a multi-tenant
# browsing session), so disable it. Real Jetson keeps the sandbox.
SANDBOX_FLAGS=()
if [ "${CLAWBOX_TEST_MODE:-0}" = "1" ] \
   || [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
  SANDBOX_FLAGS=(--no-sandbox --disable-setuid-sandbox)
fi

# WebGL without a GPU. Over VNC there is no usable GL, and `--disable-gpu`
# used to switch the whole GPU process off — which also switched off WebGL,
# because Chromium's software WebGL (SwiftShader, via ANGLE) runs INSIDE the
# GPU process. A page with a <canvas> WebGL context (the coding agent's own
# Three.js games, any WebGL site) then failed with "WebGL not supported".
# So: keep compositing in software (--disable-gpu-compositing, the cheap part
# of what --disable-gpu did) but let the GPU process run SwiftShader for
# WebGL. --enable-unsafe-swiftshader is the switch recent Chromium requires
# before it will hand a page a software WebGL context.
echo "Starting Chromium from $CHROMIUM on DISPLAY=$DISPLAY with CDP port $CDP_PORT"
exec env DISPLAY="$DISPLAY" HOME="$HOME" DBUS_SESSION_BUS_ADDRESS="disabled:" \
  "$CHROMIUM" \
  "${SANDBOX_FLAGS[@]}" \
  --remote-debugging-port="$CDP_PORT" \
  --remote-allow-origins="http://127.0.0.1:${CDP_PORT}" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --start-maximized \
  --disable-gpu-compositing \
  --use-gl=angle \
  --use-angle=swiftshader \
  --enable-unsafe-swiftshader \
  --disable-dev-shm-usage \
  --disable-background-networking \
  --password-store=basic \
  --metrics-recording-only \
  "$START_URL"
