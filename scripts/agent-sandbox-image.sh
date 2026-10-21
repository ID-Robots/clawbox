#!/usr/bin/env bash
#
# Build the agent tool sandbox image into the CALLING user's rootless Podman
# store. install.sh and install-x64.sh run it as the clawbox user, so the image
# lands where the gateway's own `podman` looks, and no root and no daemon are
# involved.
#
#   agent-sandbox-image.sh [image]     default: openclaw-sandbox:bookworm-slim
#
# The image is the one OpenClaw's docs give for an npm install (there is no
# source checkout on a box to run its sandbox-setup.sh from): Debian bookworm
# slim with bash, git, curl, jq, python3 and ripgrep, and a non-root `sandbox`
# user. OpenClaw refuses to run a sandbox whose image is missing rather than
# substituting plain Debian, because its file-write helpers need python3.
#
# The base is named in full (docker.io/library/...): a short name makes Podman
# ask which registry to use, or refuse outright, depending on the distro's
# registries.conf.
#
# Exit 0 when the image is present (built now or already there); 3 when podman
# is not installed; Podman's own status when the build fails.

set -euo pipefail

IMAGE="${1:-openclaw-sandbox:bookworm-slim}"
BASE="docker.io/library/debian:bookworm-slim"

# Rootless Podman keeps its runtime state under XDG_RUNTIME_DIR; `sudo -u`
# starts with an empty environment, and a lingering user has the directory.
if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi

if ! command -v podman >/dev/null 2>&1; then
  echo "agent-sandbox-image: podman is not installed" >&2
  exit 3
fi

if podman image exists "$IMAGE"; then
  echo "  Sandbox image $IMAGE already present"
  exit 0
fi

ctx="$(mktemp -d "${TMPDIR:-/tmp}/clawbox-sandbox-image-XXXXXX")"
trap 'rm -rf "$ctx"' EXIT

# The image's own unprivileged user and its home, inside the container only.
SANDBOX_HOME="/home/sandbox" # public-hygiene: allow the container's own user, not an account on any host

cat > "$ctx/Containerfile" <<CONTAINERFILE
FROM $BASE
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \\
      bash ca-certificates curl git jq python3 ripgrep \\
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash sandbox
USER sandbox
WORKDIR $SANDBOX_HOME
CMD ["sleep", "infinity"]
CONTAINERFILE

echo "  Building the sandbox image $IMAGE (rootless Podman, as $(id -un))..."
podman build -t "$IMAGE" -f "$ctx/Containerfile" "$ctx"

size="$(podman image inspect --format '{{.Size}}' "$IMAGE" 2>/dev/null || true)"
echo "  Sandbox image $IMAGE built (${size:-unknown} bytes)"
