#!/usr/bin/env bash
set -euo pipefail

MARKER="/var/lib/clawbox/ensure-vnc-on-first-boot.pending"

if [ ! -f "$MARKER" ]; then
  exit 0
fi

echo "[firstboot-vnc] Ensuring ClawBox VNC services are enabled and running..."

systemctl reset-failed clawbox-vnc.service clawbox-websockify.service >/dev/null 2>&1 || true
systemctl enable clawbox-vnc.service clawbox-websockify.service >/dev/null 2>&1 || true
# `start`, not `restart`. Every vnc_install arms the marker — every in-app update
# runs it — so by now clawbox-vnc.service has normally been up for seconds, and
# a restart SIGTERMed that healthy x11vnc, which exits 2 on a caught signal: the
# boot after each update logged "Main process exited, code=exited,
# status=2/INVALIDARGUMENT" and dropped the desktop once. `start` leaves a
# running unit alone and still brings up one that is inactive or failed (the
# reset-failed above clears a start limit).
systemctl start clawbox-vnc.service
sleep 2
systemctl start clawbox-websockify.service

rm -f "$MARKER"
systemctl disable clawbox-firstboot-vnc.service >/dev/null 2>&1 || true

echo "[firstboot-vnc] Completed"
