#!/usr/bin/env bash

set -euo pipefail

NETWORK_READINESS_LIB="${CLAWBOX_NETWORK_READINESS_LIB:-/usr/local/libexec/clawbox/network-readiness.sh}"
OPENCLAW_BIN="${CLAWBOX_OPENCLAW_BIN:-/home/clawbox/.npm-global/bin/openclaw}"
LOG_TAG="clawbox-gateway-network-guard"

if [ ! -r "$NETWORK_READINESS_LIB" ]; then
  logger -t "$LOG_TAG" -- \
    "Network readiness helper is unavailable; starting Gateway without the offline guard"
  exec "$OPENCLAW_BIN" gateway "$@"
fi

# shellcheck source=/usr/local/libexec/clawbox/network-readiness.sh
source "$NETWORK_READINESS_LIB"

if ! clawbox_network_ready; then
  # Keep the local control plane alive while preventing network-dependent
  # channels from turning a temporary route outage into a Gateway crash loop.
  export OPENCLAW_SKIP_CHANNELS=1
  logger -t "$LOG_TAG" -- \
    "Public route unavailable at Gateway start; deferring channel auto-start"
fi

exec "$OPENCLAW_BIN" gateway "$@"
