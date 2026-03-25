#!/bin/bash
# Shares the GPU-accelerated GNOME desktop via VNC.
# If no physical monitor is connected, creates a virtual display using the NVIDIA GPU.

XAUTH="/run/user/$(id -u)/gdm/Xauthority"
export DISPLAY=:0

# Wait for X server to be ready
for i in $(seq 1 30); do
  xdpyinfo -display :0 >/dev/null 2>&1 && break
  sleep 1
done

# Check if any output is connected
CONNECTED=$(xrandr 2>/dev/null | grep " connected " | head -1 | awk '{print $1}')

if [ -n "$CONNECTED" ]; then
  echo "[vnc] Physical monitor detected on $CONNECTED — mirroring"
else
  # No monitor — create a virtual display on the first disconnected output
  OUTPUT=$(xrandr 2>/dev/null | grep " disconnected" | head -1 | awk '{print $1}')
  echo "[vnc] No monitor — creating virtual 1920x1080 display on $OUTPUT"

  # Add 1920x1080 mode if it doesn't exist
  if ! xrandr 2>/dev/null | grep -q "1920x1080"; then
    xrandr --newmode "1920x1080" 173.00 1920 2048 2248 2576 1080 1083 1088 1120 -hsync +vsync 2>/dev/null || true
    xrandr --addmode "$OUTPUT" "1920x1080" 2>/dev/null || true
  fi

  xrandr --output "$OUTPUT" --mode "1920x1080" 2>/dev/null || true
  sleep 1
fi

# Mirror the GPU-rendered display
exec x11vnc -display :0 -auth "$XAUTH" -forever -shared -nopw -localhost -noxdamage
