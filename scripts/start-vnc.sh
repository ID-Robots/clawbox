#!/bin/bash
# Mirrors the physical display :0 if accessible,
# otherwise starts a minimal virtual desktop (openbox) for GUI apps.
#
# Override with CLAWBOX_VNC_MODE=virtual to skip :0 mirroring and always
# use the virtual Xvfb display — useful on headless Jetsons where :0 is
# GDM's greeter, which blocks apps launched into it from being visible.
set -uo pipefail

VNC_PORT="${VNC_PORT:-5900}"
VNC_MODE="${CLAWBOX_VNC_MODE:-auto}"
STATE_DIR="${HOME}/.cache/clawbox"
STATE_FILE="${STATE_DIR}/vnc-display.env"
RESOLUTION_FILE="${HOME}/.config/clawbox/vnc-resolution.env"
# Presets the Settings UI offers (src/lib/vnc-resolution.ts). Anything else
# falls back to the default so a hand-edited file cannot reach Xvfb's argv.
VNC_RESOLUTIONS="1280x720 1600x900 1920x1080"
DEFAULT_VNC_RESOLUTION="1280x720"
THEME_SCRIPT="$(cd "$(dirname "$0")" && pwd)/apply-desktop-theme.sh"

display_ready() {
  local display="$1"
  local auth="${2:-}"
  if [ -n "$auth" ]; then
    XAUTHORITY="$auth" xset -display "$display" q >/dev/null 2>&1
  else
    xset -display "$display" q >/dev/null 2>&1
  fi
}

record_vnc_display() {
  local display="$1"
  local auth="${2:-}"
  mkdir -p "$STATE_DIR"
  {
    printf 'CLAWBOX_VNC_DISPLAY=%s\n' "$display"
    if [ -n "${VNC_RESOLUTION:-}" ]; then
      printf 'CLAWBOX_VNC_GEOMETRY=%s\n' "$VNC_RESOLUTION"
    fi
    if [ -n "$auth" ]; then
      printf 'CLAWBOX_VNC_XAUTHORITY=%s\n' "$auth"
    fi
  } > "$STATE_FILE"
}

# Echo the saved resolution if it is one of the presets, else the default.
read_vnc_resolution() {
  local file="$1" value=""
  if [ -f "$file" ]; then
    value=$(sed -n 's/^CLAWBOX_VNC_RESOLUTION=\([0-9x]*\)$/\1/p' "$file" | tail -1)
  fi
  case " $VNC_RESOLUTIONS " in
    *" $value "*) [ -n "$value" ] && { echo "$value"; return 0; } ;;
  esac
  echo "$DEFAULT_VNC_RESOLUTION"
}

# Geometry (WxH) of the running display, empty if unknown. Asks X first
# (xwininfo, from x11-utils, may be absent on a fresh install), then falls back
# to the geometry the previous run recorded in the state file.
running_geometry() {
  local geo=""
  if command -v xwininfo >/dev/null 2>&1; then
    geo=$(xwininfo -display "$1" -root 2>/dev/null | sed -n 's/^ *-geometry \([0-9]*x[0-9]*\).*/\1/p')
  fi
  if [ -z "$geo" ] && [ -f "$STATE_FILE" ] && grep -qx "CLAWBOX_VNC_DISPLAY=$1" "$STATE_FILE"; then
    geo=$(sed -n 's/^CLAWBOX_VNC_GEOMETRY=\([0-9]*x[0-9]*\)$/\1/p' "$STATE_FILE" | tail -1)
  fi
  echo "$geo"
}

# Decide whether a running Xvfb must be replaced: prints "restart" when the
# running geometry is known and differs from the wanted one, else "keep".
xvfb_action() {
  local running="$1" wanted="$2"
  if [ -n "$running" ] && [ "$running" != "$wanted" ]; then
    echo restart
  else
    echo keep
  fi
}

# ─── Try to mirror the physical/GDM display :0 ───────────────────────────────

find_xauth() {
  local xorg_pid
  xorg_pid=$(pgrep -f "Xorg.*-auth" | head -1)
  if [ -n "$xorg_pid" ]; then
    local auth
    auth=$(tr '\0' '\n' < /proc/"$xorg_pid"/cmdline | grep -A1 -- "-auth" | tail -1)
    [ -f "$auth" ] && echo "$auth" && return 0
  fi
  for f in /run/user/*/gdm/Xauthority /var/run/gdm*/auth-for-*/database; do
    [ -f "$f" ] && echo "$f" && return 0
  done
  return 1
}

if [ "$VNC_MODE" != "virtual" ]; then
  XAUTH=$(find_xauth 2>/dev/null)
  if [ -n "$XAUTH" ] && display_ready :0 "$XAUTH"; then
    echo "[vnc] Display :0 found — mirroring"
    record_vnc_display ":0" "$XAUTH"
    exec x11vnc -display :0 -auth "$XAUTH" -rfbport "$VNC_PORT" -forever -shared -nopw -localhost -noxdamage
  fi
fi

# ─── Virtual desktop ─────────────────────────────────────────────────────────

VDISPLAY=99
VNC_RESOLUTION="$(read_vnc_resolution "$RESOLUTION_FILE")"
echo "[vnc] Starting virtual desktop on :${VDISPLAY} at ${VNC_RESOLUTION}"

# An Xvfb that outlived a previous run is reused, unless the saved resolution
# changed since it started — then it is replaced. The :0 mirror path above
# never gets here, so the setting does not apply to it.
if display_ready ":${VDISPLAY}" \
  && [ "$(xvfb_action "$(running_geometry ":${VDISPLAY}")" "$VNC_RESOLUTION")" = restart ]; then
  echo "[vnc] Resolution changed — restarting Xvfb :${VDISPLAY}"
  pkill -f "^Xvfb :${VDISPLAY}( |$)" 2>/dev/null || true
  for _ in $(seq 1 30); do
    display_ready ":${VDISPLAY}" || break
    sleep 0.1
  done
fi

if ! display_ready ":${VDISPLAY}"; then
  Xvfb ":${VDISPLAY}" -screen 0 "${VNC_RESOLUTION}x24" &
  # Poll for Xvfb readiness instead of a fixed sleep
  for _ in $(seq 1 50); do
    if display_ready ":${VDISPLAY}"; then
      break
    fi
    sleep 0.1
  done
  if ! display_ready ":${VDISPLAY}"; then
    echo "[vnc] Error: Xvfb did not become ready on :${VDISPLAY} within 5s" >&2
    exit 1
  fi
fi

export DISPLAY=":${VDISPLAY}"
export DBUS_SESSION_BUS_ADDRESS=""

record_vnc_display ":${VDISPLAY}"

if [ -x "$THEME_SCRIPT" ]; then
  "$THEME_SCRIPT"
else
  xsetroot -solid "#0a0f1a" 2>/dev/null || true
fi

# Minimal WM with right-click menu disabled
if command -v openbox &>/dev/null; then
  OB_CONFIG_DIR="$HOME/.config/openbox"
  mkdir -p "$OB_CONFIG_DIR"

  # Openbox config: disable desktop right-click menu, dark theme.
  # We rely on focus-follows-mouse so client-area left clicks pass through to
  # apps like Chromium instead of being consumed by Openbox focus bindings.
  cat > "$OB_CONFIG_DIR/rc.xml" <<'OBXML'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <theme>
    <name>Clearlooks</name>
    <titleLayout>NLIMC</titleLayout>
  </theme>
  <focus>
    <focusNew>yes</focusNew>
    <followMouse>yes</followMouse>
    <focusDelay>0</focusDelay>
    <underMouse>yes</underMouse>
    <raiseOnFocus>yes</raiseOnFocus>
  </focus>
  <desktops><number>1</number></desktops>
  <mouse>
    <context name="Root">
      <!-- Disabled: no desktop menu on right-click -->
    </context>
    <context name="Titlebar">
      <mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
      <mousebind button="Left" action="Drag"><action name="Move"/></mousebind>
      <mousebind button="Left" action="DoubleClick"><action name="ToggleMaximize"/></mousebind>
    </context>
  </mouse>
</openbox_config>
OBXML

  # Empty menu so even keyboard shortcut shows nothing
  cat > "$OB_CONFIG_DIR/menu.xml" <<'OBMENU'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu"></openbox_menu>
OBMENU

  openbox --config-file "$OB_CONFIG_DIR/rc.xml" &
fi
sleep 1

# autocutsel keeps the X CLIPBOARD and PRIMARY selections alive even after
# the window that produced them closes, so copy/paste between the VNC client
# and guest apps (Chromium, xterm, etc.) survives focus changes.
if command -v autocutsel &>/dev/null; then
  autocutsel -fork -selection CLIPBOARD 2>/dev/null || true
  autocutsel -fork -selection PRIMARY 2>/dev/null || true
fi

exec x11vnc -display ":${VDISPLAY}" -rfbport "${VNC_PORT}" -forever -shared -nopw -localhost -noxdamage
