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
CLAWBOX_TEST_NO_GPU=1
EOF
# CLAWBOX_TEST_NO_GPU=1: this container has no GPU by construction, so the
# only on-device TTS engine (Kokoro, CUDA) declines here on every run. The
# installer records a declined Kokoro as a mute box on real hardware; this
# knob tells it the mute box is the harness's documented state, not a defect,
# so service validation does not fail every run over it. It is a separate
# knob from CLAWBOX_TEST_MODE on purpose: the unit tests run the installer's
# functions under test mode and pin the real-hardware rule.

# The full installer still deploys clawbox-ap.service so upgrade paths can
# verify its unit file, but this container has no WiFi radio and the install
# harness intentionally excludes the service from active-service validation.
# Keep the real root-update/systemd restart path while replacing only the
# impossible hardware boundary; otherwise each settings write waits ~34s for
# start-ap.sh retries that cannot succeed and whose failure is already ignored.
mkdir -p /etc/systemd/system/clawbox-ap.service.d
cat > /etc/systemd/system/clawbox-ap.service.d/e2e-no-radio.conf <<EOF
[Service]
ExecStart=
ExecStart=/bin/true
ExecStop=
ExecStop=/bin/true
EOF

# Docker networking is already configured before PID 1 starts. Ubuntu's
# NetworkManager-wait-online helper cannot classify the synthetic eth0 link
# and burns its full 60-second timeout on every tested reboot before allowing
# clawbox-setup.service to start. Preserve the network-online dependency graph
# but satisfy the impossible hardware probe immediately in this container.
mkdir -p /etc/systemd/system/NetworkManager-wait-online.service.d
cat > /etc/systemd/system/NetworkManager-wait-online.service.d/e2e-docker-network.conf <<EOF
[Service]
ExecStart=
ExecStart=/bin/true
EOF

# Hand off to systemd.
exec "$@"
