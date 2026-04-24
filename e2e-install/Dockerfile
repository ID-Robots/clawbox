# ClawBox E2E test image — simulates a fresh JetPack 6.2 system closely enough
# to exercise install.sh + setup wizard + updater end-to-end without needing
# physical Jetson hardware.
#
# Builds for the host architecture. Production runs on arm64 (Jetson);
# CI uses `ubuntu-24.04-arm` to match, while dev laptops build amd64 for
# speed. The install.sh paths we care about (bun, next build, apt packages,
# systemd) are arch-agnostic — the Jetson-specific bits all sit behind
# CLAWBOX_TEST_MODE=1 and get skipped anyway.
FROM ubuntu:22.04 AS base

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

# Core packages install.sh expects. We install them up-front so the apt_update
# step inside install.sh is a no-op (fast) — this matches what `sudo apt-get
# install nvidia-jetpack` would have already pulled in on a real JetPack image.
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus \
      ca-certificates curl wget gnupg2 lsb-release unzip \
      git sudo locales tzdata procps less \
      network-manager avahi-daemon iptables iw \
      python3 python3-pip python-is-python3 \
      build-essential pkg-config cmake ninja-build \
      iproute2 iputils-ping dnsutils \
      polkitd \
      openssh-client \
 && rm -rf /var/lib/apt/lists/*

# Node.js 22 — matches what install.sh installs at runtime.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# node-gyp is needed when `bun install` runs — node-pty doesn't ship a
# prebuild for every combination of arch/Node ABI, and without a global
# node-gyp bun's build-from-source path fails with "node-gyp: command not
# found" before install.sh's own `ensure_node_pty` fallback can kick in.
RUN npm install -g node-gyp

# systemd-in-container housekeeping: mask units that require hardware we
# don't have (console-getty), enable the ones we do want (NM, dbus, avahi).
RUN systemctl mask \
      systemd-udevd.service \
      systemd-udevd-kernel.socket \
      systemd-udevd-control.socket \
      systemd-modules-load.service \
      sys-kernel-debug.mount \
      sys-kernel-tracing.mount \
      dev-hugepages.mount \
      dev-mqueue.mount \
      console-getty.service \
      getty.target

# Enable services install.sh will need.
RUN systemctl enable NetworkManager avahi-daemon dbus

# Create the clawbox user — install.sh does this too, but pre-creating it lets
# us bake volume permissions correctly on first boot.
RUN useradd -m -s /bin/bash -u 1000 clawbox && \
    usermod -aG sudo clawbox && \
    echo 'clawbox ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/clawbox-nopasswd && \
    chmod 0440 /etc/sudoers.d/clawbox-nopasswd

# Pre-create project dir so volume mounts land on the right owner.
RUN mkdir -p /home/clawbox/clawbox && chown -R clawbox:clawbox /home/clawbox

# Expose the setup web server. install.sh binds :80, so that's what we map.
EXPOSE 80

# Pre-install bun for the clawbox user to skip one network round-trip during
# install. install.sh re-checks and no-ops if present.
USER clawbox
RUN curl -fsSL https://bun.sh/install | bash
USER root

# Config-file stage: copy the project tree into the image. The entrypoint
# bootstraps install.sh from here when the volume is empty (first boot),
# otherwise runs from the volume (persistent across container restarts).
COPY --chown=clawbox:clawbox . /opt/clawbox-src/

# Entrypoint + bootstrap scripts.
COPY e2e-install/entrypoint.sh /usr/local/sbin/clawbox-entrypoint.sh
COPY e2e-install/clawbox-bootstrap.service /etc/systemd/system/clawbox-bootstrap.service
RUN chmod +x /usr/local/sbin/clawbox-entrypoint.sh && \
    systemctl enable clawbox-bootstrap.service

# systemd needs to be PID 1 — that's what drives install.sh's systemctl calls.
STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/usr/local/sbin/clawbox-entrypoint.sh"]
CMD ["/sbin/init"]
