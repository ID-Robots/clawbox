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
if [ -n "$XAUTH" ] && XAUTHORITY="$XAUTH" xdpyinfo -display :0 >/dev/null 2>&1; then
  echo "[vnc] Display :0 found — mirroring"
  exec x11vnc -display :0 -auth "$XAUTH" -rfbport "$VNC_PORT" -forever -shared -nopw -localhost -noxdamage
fi

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
if command -v openbox &>/dev/null; then
  openbox &
elif command -v xterm &>/dev/null; then
  xterm -geometry 100x30+0+0 &
fi
sleep 1

exec x11vnc -display ":${VDISPLAY}" -rfbport "${VNC_PORT}" -forever -shared -nopw -localhost -noxdamage
