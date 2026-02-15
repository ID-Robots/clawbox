#!/bin/bash
# Runs a root-privileged update step by step ID.
# Called by clawbox-root-update@.service (runs as root).
set -euo pipefail

case "${1:-}" in
    apt_update)
        apt-get update
        ;;
    nvidia_jetpack)
        apt-get install -y nvidia-jetpack
        ;;
    performance_mode)
        nvpmodel -m 0
        jetson_clocks
        ;;
    chpasswd)
        INPUT_FILE="/home/clawbox/clawbox/data/.chpasswd-input"
        if [ ! -f "$INPUT_FILE" ]; then
            echo "Error: password input file not found" >&2
            exit 1
        fi
        chpasswd < "$INPUT_FILE"
        rm -f "$INPUT_FILE"
        ;;
    *)
        echo "Unknown step: ${1:-<empty>}" >&2
        exit 1
        ;;
esac
