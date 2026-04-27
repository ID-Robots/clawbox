#!/usr/bin/env bash
# Entrypoint for the ClawBox e2e-install container.
#
# systemd runs as PID 1 once we exec /sbin/init. Before that, seed
# /home/clawbox/clawbox from the baked-in source if the volume is empty,
# so first-boot and persistent-volume runs both work without extra setup.
set -euo pipefail

PROJECT_DIR="/home/clawbox/clawbox"
SRC_DIR="/opt/clawbox-src"

# Seed the project tree when install.sh is missing. We can't just check
# "is the dir empty" because the compose harness bind-mounts .env.test
# into the project dir *before* the entrypoint runs; a plain emptiness
# check would see that file and skip seeding.
if [ ! -f "$PROJECT_DIR/install.sh" ]; then
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
  chown clawbox:clawbox "$PROJECT_DIR/.needs-install"
fi

# Seed a small marker file so install.sh knows it's in test mode even before
# it has had a chance to write its own .env. install.sh itself handles
# propagation into clawbox-setup.service's environment (via .env) and the
# root-update service's environment (via /etc/clawbox/network.env).
mkdir -p /etc/clawbox
cat > /etc/clawbox/test-mode.env <<EOF
CLAWBOX_TEST_MODE=1
NETWORK_INTERFACE=${NETWORK_INTERFACE:-eth0}
EOF

# Hand off to systemd.
exec "$@"
