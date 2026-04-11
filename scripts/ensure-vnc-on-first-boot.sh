#!/usr/bin/env bash
set -euo pipefail

MARKER="/var/lib/clawbox/ensure-vnc-on-first-boot.pending"

if [ ! -f "$MARKER" ]; then
  exit 0
fi

echo "[firstboot-vnc] Ensuring ClawBox VNC services are enabled and running..."

systemctl reset-failed clawbox-vnc.service clawbox-websockify.service >/dev/null 2>&1 || true
systemctl enable clawbox-vnc.service clawbox-websockify.service >/dev/null 2>&1 || true
systemctl restart clawbox-vnc.service
sleep 2
systemctl restart clawbox-websockify.service

rm -f "$MARKER"
systemctl disable clawbox-firstboot-vnc.service >/dev/null 2>&1 || true

echo "[firstboot-vnc] Completed"
