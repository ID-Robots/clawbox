#!/usr/bin/env bash
# Optimize Ollama systemd service for 8GB Jetson:
# - Q8_0 KV cache (halves KV memory vs FP16 default)
# - Flash attention (required for KV cache quantization)
# - Single model loaded at a time (prevents OOM)
# - Single parallel request (prevents KV cache duplication)
#
# Must be run as root. Called from install.sh and from the configure route
# via sudoers.

set -euo pipefail

if ! systemctl list-unit-files ollama.service &>/dev/null; then
  echo "Ollama service not found, skipping"
  exit 0
fi

mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf << 'EOF'
[Service]
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_NUM_PARALLEL=1"
EOF

systemctl daemon-reload
systemctl restart ollama 2>/dev/null || true
echo "Ollama optimized (q8_0 KV cache, flash attention, single model)"
