#!/usr/bin/env bash
# ClawBox Cloudflare Tunnel installer
# Downloads the cloudflared binary for the host architecture so the device
# can expose its local web UI to the portal via a Cloudflare tunnel.
set -euo pipefail

INSTALL_PATH="${CLOUDFLARED_INSTALL_PATH:-/usr/local/bin/cloudflared}"
CLOUDFLARED_VERSION="${CLOUDFLARED_VERSION:-2026.3.0}"

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

ASSET_NAME="cloudflared-linux-${CF_ARCH}"
URL="https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${ASSET_NAME}"
RELEASE_METADATA_URL="https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${CLOUDFLARED_VERSION}"
TMP="$(mktemp)"
RELEASE_METADATA="$(mktemp)"
CHECKSUM_FILE="$(mktemp)"
trap 'rm -f "$TMP" "$RELEASE_METADATA" "$CHECKSUM_FILE"' EXIT

echo "[setup-tunnel] Downloading cloudflared ($CF_ARCH) from $URL"
if ! curl -fL --retry 3 --retry-delay 2 -o "$TMP" "$URL"; then
  echo "[setup-tunnel] Download failed" >&2
  exit 1
fi

echo "[setup-tunnel] Fetching published SHA256 for ${ASSET_NAME}"
if ! curl -fL --retry 3 --retry-delay 2 \
  -H "Accept: application/vnd.github+json" \
  -o "$RELEASE_METADATA" "$RELEASE_METADATA_URL"; then
  echo "[setup-tunnel] Failed to fetch release metadata for ${CLOUDFLARED_VERSION}" >&2
  exit 1
fi

EXPECTED_SHA256="$(
  grep -F -A 40 "\"name\": \"$ASSET_NAME\"" "$RELEASE_METADATA" \
    | sed -n 's/.*"digest": "sha256:\([0-9a-f][0-9a-f]*\)".*/\1/p' \
    | head -n 1
)"

if [ -z "$EXPECTED_SHA256" ]; then
  echo "[setup-tunnel] No published SHA256 found for ${ASSET_NAME} in ${CLOUDFLARED_VERSION}" >&2
  exit 1
fi

printf '%s  %s\n' "$EXPECTED_SHA256" "$TMP" > "$CHECKSUM_FILE"
if ! sha256sum --check --status "$CHECKSUM_FILE"; then
  echo "[setup-tunnel] SHA256 verification failed for ${ASSET_NAME}" >&2
  exit 1
fi

echo "[setup-tunnel] Verified SHA256 for ${ASSET_NAME}"

chmod 0755 "$TMP"
mv "$TMP" "$INSTALL_PATH"
trap - EXIT

echo "[setup-tunnel] cloudflared installed:"
"$INSTALL_PATH" --version || true
