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
    chrome_install)
        if command -v google-chrome-stable &>/dev/null; then
            echo "Google Chrome already installed"
        else
            echo "Adding Google Chrome repository..."
            curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
            echo "deb [arch=arm64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
            apt-get update -qq
            apt-get install -y google-chrome-stable
        fi
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
    restart)
        echo "Restarting clawbox-setup.service..."
        systemctl restart clawbox-setup.service
        ;;
    openclaw_install)
        # Fix npm cache/global ownership (may have root-owned files from install.sh)
        chown -R clawbox:clawbox /home/clawbox/.npm /home/clawbox/.npm-global 2>/dev/null || true
        su - clawbox -c "npm install -g openclaw --prefix /home/clawbox/.npm-global"
        ;;
    factory_reset)
        export HOME="/root"
        PROJECT_DIR="/home/clawbox/clawbox"
        echo "Running cleanup..."
        bash "$PROJECT_DIR/cleanup.sh"
        echo "Running installer..."
        bash "$PROJECT_DIR/install.sh"
        ;;
    *)
        echo "Unknown step: ${1:-<empty>}" >&2
        exit 1
        ;;
esac
