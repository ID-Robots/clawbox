#!/bin/bash
# Mirrors the physical display :0 if accessible,
# otherwise starts a minimal virtual desktop (openbox) for GUI apps.

VNC_PORT="${VNC_PORT:-5900}"

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
HAS_MONITOR=false
if [ -n "$XAUTH" ] && XAUTHORITY="$XAUTH" xdpyinfo -display :0 >/dev/null 2>&1; then
  # Check if a physical monitor is actually connected
  if XAUTHORITY="$XAUTH" xrandr -display :0 --query 2>/dev/null | grep -q " connected"; then
    HAS_MONITOR=true
  fi
fi

if [ "$HAS_MONITOR" = true ]; then
  echo "[vnc] Physical display :0 found — mirroring"
  XAUTHORITY="$XAUTH" xset -display :0 s 0 0 2>/dev/null
  XAUTHORITY="$XAUTH" xset -display :0 s noblank 2>/dev/null
  # -noxdamage required: GNOME's Mutter compositor breaks X DAMAGE updates
  exec x11vnc -display :0 -auth "$XAUTH" -rfbport "$VNC_PORT" -forever -shared -nopw -localhost -noxdamage
fi

echo "[vnc] No physical monitor — using virtual desktop"

# ─── Virtual desktop ─────────────────────────────────────────────────────────

VDISPLAY=99
echo "[vnc] Starting virtual desktop on :${VDISPLAY}"

if ! xdpyinfo -display ":${VDISPLAY}" >/dev/null 2>&1; then
  Xvfb ":${VDISPLAY}" -screen 0 1280x720x24 &
  sleep 1
fi

export DISPLAY=":${VDISPLAY}"
export DBUS_SESSION_BUS_ADDRESS=""

# Minimal WM — just enough to render and manage app windows
if command -v openbox &>/dev/null && ! pgrep -x openbox &>/dev/null; then
  openbox &
elif command -v xterm &>/dev/null && ! pgrep -x xterm &>/dev/null; then
  xterm -geometry 100x30+0+0 &
fi
sleep 1

# Taskbar panel so minimized windows can be restored
if command -v tint2 &>/dev/null && ! pgrep -x tint2 &>/dev/null; then
  tint2 &
fi

exec x11vnc -display ":${VDISPLAY}" -rfbport "${VNC_PORT}" -forever -shared -nopw -localhost
