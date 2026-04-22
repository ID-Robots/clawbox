#!/usr/bin/env bash
# ClawBox Cloudflare Tunnel installer
# Downloads the cloudflared binary for the host architecture so the device
# can expose its local web UI to the portal via a Cloudflare tunnel.
set -euo pipefail

INSTALL_PATH="${CLOUDFLARED_INSTALL_PATH:-/usr/local/bin/cloudflared}"

if [ "$(id -u)" -ne 0 ]; then
  echo "[setup-tunnel] Must be run as root (to write $INSTALL_PATH)" >&2
  exit 1
fi

ARCH=$(uname -m)
case "$ARCH" in
  aarch64|arm64) CF_ARCH="arm64" ;;
  x86_64|amd64)  CF_ARCH="amd64" ;;
  armv7l)        CF_ARCH="arm" ;;
  *) echo "[setup-tunnel] Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

if [ -x "$INSTALL_PATH" ] && [ -z "${CLOUDFLARED_FORCE_REINSTALL:-}" ]; then
  echo "[setup-tunnel] cloudflared already installed at $INSTALL_PATH"
  "$INSTALL_PATH" --version || true
  exit 0
fi

URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "[setup-tunnel] Downloading cloudflared ($CF_ARCH) from $URL"
if ! curl -fL --retry 3 --retry-delay 2 -o "$TMP" "$URL"; then
  echo "[setup-tunnel] Download failed" >&2
  exit 1
fi

chmod 0755 "$TMP"
mv "$TMP" "$INSTALL_PATH"
trap - EXIT

echo "[setup-tunnel] cloudflared installed:"
"$INSTALL_PATH" --version || true
