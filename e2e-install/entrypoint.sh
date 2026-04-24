#!/usr/bin/env bash
# Entrypoint for the ClawBox e2e-install container.
#
# systemd runs as PID 1 once we exec /sbin/init. Before that, seed
# /home/clawbox/clawbox from the baked-in source if the volume is empty,
# so first-boot and persistent-volume runs both work without extra setup.
set -euo pipefail

PROJECT_DIR="/home/clawbox/clawbox"
SRC_DIR="/opt/clawbox-src"

# If the volume-backed project dir is empty, seed it from the baked image.
if [ -z "$(ls -A "$PROJECT_DIR" 2>/dev/null || true)" ]; then
  echo "[entrypoint] Seeding $PROJECT_DIR from $SRC_DIR"
  # cp -a preserves ownership/mode; SRC_DIR was chowned to clawbox at build time.
  # We skip node_modules / .next to keep the initial copy small; install.sh
  # will recreate them.
  (
    cd "$SRC_DIR"
    # Using tar avoids rsync as a dependency and handles dotfiles cleanly.
    tar --exclude=node_modules --exclude=.next --exclude=.git/logs -cf - . \
      | (cd "$PROJECT_DIR" && tar -xf -)
  )
  chown -R clawbox:clawbox "$PROJECT_DIR"
  # Mark that install.sh has not yet run on this volume.
  touch "$PROJECT_DIR/.needs-install"
fi

# Ensure env file exists with test-mode flag before any service picks it up.
mkdir -p /etc/clawbox
cat > /etc/clawbox/test-mode.env <<EOF
CLAWBOX_TEST_MODE=1
NETWORK_INTERFACE=${NETWORK_INTERFACE:-eth0}
EOF

# Hand off to systemd.
exec "$@"
