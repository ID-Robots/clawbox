#!/bin/bash
# Mirrors the physical GNOME desktop if a monitor is connected,
# otherwise starts a virtual GNOME session on a framebuffer.

DISPLAY_NUM=0
XAUTH="/run/user/$(id -u)/gdm/Xauthority"

# Check if physical display :0 is available
if xdpyinfo -display :0 >/dev/null 2>&1; then
  echo "[vnc] Physical display :0 detected — mirroring"
  exec x11vnc -display :0 -auth "$XAUTH" -forever -shared -nopw -localhost -noxdamage
fi

# No physical display — start a virtual framebuffer + GNOME session
echo "[vnc] No physical display — starting virtual desktop on :99"
DISPLAY_NUM=99

# Start Xvfb if not already running
if ! xdpyinfo -display :${DISPLAY_NUM} >/dev/null 2>&1; then
  Xvfb :${DISPLAY_NUM} -screen 0 1920x1080x24 &
  sleep 1
fi

export DISPLAY=:${DISPLAY_NUM}
export DBUS_SESSION_BUS_ADDRESS=""

# Start a GNOME session (or fallback to xfce/openbox)
if command -v gnome-session &>/dev/null; then
  gnome-session --session=ubuntu &
elif command -v startxfce4 &>/dev/null; then
  startxfce4 &
fi
sleep 2

# Mirror the virtual display
exec x11vnc -display :${DISPLAY_NUM} -forever -shared -nopw -localhost -noxdamage
