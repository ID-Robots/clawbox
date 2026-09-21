#!/usr/bin/env bash
# Optimize Ollama systemd service for the 8GB Jetson:
# - Q8_0 KV cache (halves KV memory vs FP16 default)
# - Flash attention (required for KV cache quantization)
# - Single model loaded at a time (prevents OOM)
# - Two parallel slots, so the agent and the human don't queue behind each other
# - An explicit context length, so the cost of those slots is predictable
#
# The two numbers on the last two lines come from
# config/clawbox-resource-limits.env, which is also where the reasoning for them
# is written down. The MEMORY guard for this unit is NOT here — it is a separate
# drop-in (50-clawbox-memory.conf) written by clawbox-resource-limits.sh, so the
# two concerns never fight over the same file.
#
# Must be run as root. Called from install.sh and from the configure route
# via sudoers.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Same strict parser as clawbox-resource-limits.sh, and deliberately NOT
# `source`: the repo fallback below lives in the clawbox-writable tree while
# this script runs as root under a NOPASSWD grant. Only integer values of the
# exact keys we ask for are ever read.
read_limit() {
  local key="$1" fallback="$2" f value
  for f in \
    "${CLAWBOX_RESOURCE_LIMITS_FILE:-}" \
    /etc/clawbox/resource-limits.env \
    "$SCRIPT_DIR/../config/clawbox-resource-limits.env"
  do
    [ -n "$f" ] && [ -f "$f" ] || continue
    value="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p" "$f" | tail -1)"
    if [ -n "$value" ]; then
      echo "$value"
      return 0
    fi
  done
  echo "$fallback"
}

NUM_PARALLEL="$(read_limit CLAWBOX_OLLAMA_NUM_PARALLEL 2)"
CONTEXT_LENGTH="$(read_limit CLAWBOX_OLLAMA_CONTEXT_LENGTH 4096)"

if [ "${1:-}" = "--check" ]; then
  echo "OLLAMA_NUM_PARALLEL=$NUM_PARALLEL"
  echo "OLLAMA_CONTEXT_LENGTH=$CONTEXT_LENGTH"
  echo "result: no changes made (--check)"
  exit 0
fi

if ! systemctl list-unit-files ollama.service &>/dev/null; then
  echo "Ollama service not found, skipping"
  exit 0
fi

mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf << EOF
[Service]
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_NUM_PARALLEL=${NUM_PARALLEL}"
Environment="OLLAMA_CONTEXT_LENGTH=${CONTEXT_LENGTH}"
EOF

systemctl daemon-reload
systemctl restart ollama 2>/dev/null || true
echo "Ollama optimized (q8_0 KV cache, flash attention, single model, ${NUM_PARALLEL} parallel slots, ctx ${CONTEXT_LENGTH})"
