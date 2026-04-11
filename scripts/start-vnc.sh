#!/bin/bash
# Mirrors the physical display :0 if accessible,
# otherwise starts a minimal virtual desktop (openbox) for GUI apps.
set -uo pipefail

VNC_PORT="${VNC_PORT:-5900}"
STATE_DIR="${HOME}/.cache/clawbox"
STATE_FILE="${STATE_DIR}/vnc-display.env"
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
    if [ -n "$auth" ]; then
      printf 'CLAWBOX_VNC_XAUTHORITY=%s\n' "$auth"
    fi
  } > "$STATE_FILE"
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

XAUTH=$(find_xauth 2>/dev/null)
if [ -n "$XAUTH" ] && display_ready :0 "$XAUTH"; then
  echo "[vnc] Display :0 found — mirroring"
  record_vnc_display ":0" "$XAUTH"
  exec x11vnc -display :0 -auth "$XAUTH" -rfbport "$VNC_PORT" -forever -shared -nopw -localhost -noxdamage
fi

# ─── Virtual desktop ─────────────────────────────────────────────────────────

VDISPLAY=99
echo "[vnc] Starting virtual desktop on :${VDISPLAY}"

if ! display_ready ":${VDISPLAY}"; then
  Xvfb ":${VDISPLAY}" -screen 0 1280x720x24 &
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

exec x11vnc -display ":${VDISPLAY}" -rfbport "${VNC_PORT}" -forever -shared -nopw -localhost -noxdamage
