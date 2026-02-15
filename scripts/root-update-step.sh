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
        if command -v chromium-browser &>/dev/null; then
            echo "Chromium already installed"
        else
            apt-get install -y chromium-browser
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
    rebuild)
        PROJECT_DIR="/home/clawbox/clawbox"
        BUN="/home/clawbox/.bun/bin/bun"
        echo "Stopping clawbox-setup.service for rebuild..."
        systemctl stop clawbox-setup.service 2>/dev/null || true
        echo "Clearing .next cache..."
        rm -rf "$PROJECT_DIR/.next"
        echo "Running bun install..."
        su - clawbox -c "cd $PROJECT_DIR && $BUN install"
        echo "Running bun build..."
        su - clawbox -c "cd $PROJECT_DIR && $BUN run build"
        echo "Starting clawbox-setup.service..."
        systemctl start clawbox-setup.service
        ;;
    restart)
        echo "Restarting clawbox-setup.service..."
        systemctl restart clawbox-setup.service
        ;;
    restart_ap)
        echo "Restarting clawbox-ap.service..."
        systemctl restart clawbox-ap.service
        ;;
    openclaw_install)
        OPENCLAW_BIN="/home/clawbox/.npm-global/bin/openclaw"
        INSTALLED=$("$OPENCLAW_BIN" --version 2>/dev/null || echo "none")
        LATEST=$(npm view openclaw version 2>/dev/null || echo "unknown")
        echo "Installed: $INSTALLED, Latest: $LATEST"
        if [ "$LATEST" = "unknown" ]; then
            echo "Cannot determine latest version (offline?). Skipping update check."
            exit 0
        fi
        if [ "$INSTALLED" = "$LATEST" ]; then
            echo "OpenClaw is already up to date"
        else
            # Fix npm cache/global ownership (may have root-owned files from install.sh)
            chown -R clawbox:clawbox /home/clawbox/.npm /home/clawbox/.npm-global 2>/dev/null || true
            su - clawbox -c "npm install -g openclaw --prefix /home/clawbox/.npm-global"
        fi
        ;;
    gateway_setup)
        cp /home/clawbox/clawbox/config/clawbox-gateway.service /etc/systemd/system/
        systemctl daemon-reload
        systemctl enable clawbox-gateway.service
        systemctl restart clawbox-gateway.service
        ;;
    ffmpeg_install)
        apt-get install -y ffmpeg
        ;;
    voice_install)
        bash /home/clawbox/clawbox/scripts/install-voice.sh
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
