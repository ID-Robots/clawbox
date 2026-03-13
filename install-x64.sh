#!/usr/bin/env bash
# ClawBox x64 Desktop Installer — safe version that skips Jetson/network steps
# Assumes OpenClaw is ALREADY installed on this machine.
# Does NOT modify: hostname, WiFi, DNS, systemd services, NVIDIA drivers, OpenClaw
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: Run this script with sudo" >&2
  exit 1
fi

REPO_URL="https://github.com/ID-Robots/clawbox.git"
REPO_BRANCH="${CLAWBOX_BRANCH:-main}"
CLAWBOX_USER="${CLAWBOX_USER:-$(logname 2>/dev/null || echo $SUDO_USER)}"
CLAWBOX_HOME="$(eval echo ~$CLAWBOX_USER)"
PROJECT_DIR="${CLAWBOX_DIR:-$CLAWBOX_HOME/clawbox}"
PORT="${CLAWBOX_PORT:-3005}"

# Detect bun location
if [ -x "$CLAWBOX_HOME/.bun/bin/bun" ]; then
  BUN="$CLAWBOX_HOME/.bun/bin/bun"
elif command -v bun &>/dev/null; then
  BUN="$(command -v bun)"
else
  BUN=""
fi

TOTAL_STEPS=6
step=0
log() {
  step=$((step + 1))
  echo ""
  echo "[$step/$TOTAL_STEPS] $1"
}

as_user() { sudo -u "$CLAWBOX_USER" "$@"; }

echo "=== ClawBox x64 Desktop Installer ==="
echo "  User: $CLAWBOX_USER"
echo "  Project: $PROJECT_DIR"
echo "  Port: $PORT"
echo "  Skipping: hostname, WiFi AP, JetPack, performance mode, jtop, OpenClaw install"
echo ""

# 1. System packages (minimal)
log "Checking system packages..."
apt-get update -qq
apt-get install -y -qq git curl
if node --version 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])\.'; then
  echo "  Node.js $(node --version) ✓"
else
  echo "  Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

# 2. Install bun if missing
log "Checking bun..."
if [ -n "$BUN" ] && [ -x "$BUN" ]; then
  echo "  Bun already installed at $BUN"
else
  echo "  Installing bun..."
  as_user bash -o pipefail -c 'curl -fsSL https://bun.sh/install | bash'
  BUN="$CLAWBOX_HOME/.bun/bin/bun"
fi

# 3. Clone/pull repo
log "Setting up ClawBox repository..."
if [ ! -d "$PROJECT_DIR/.git" ]; then
  git clone --branch "$REPO_BRANCH" "$REPO_URL" "$PROJECT_DIR"
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR"
else
  echo "  Repository exists, pulling latest..."
  git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" fetch origin
  git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" checkout "$REPO_BRANCH" 2>/dev/null || true
  git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" merge --ff-only "origin/$REPO_BRANCH" || echo "  Warning: merge failed, continuing with current code"
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/.git"
fi

# 4. Build
log "Building ClawBox..."
cd "$PROJECT_DIR"
as_user "$BUN" install
as_user "$BUN" run build
if [ ! -f "$PROJECT_DIR/.next/standalone/server.js" ]; then
  echo "Error: Build failed — .next/standalone/server.js not found"
  exit 1
fi
echo "  Build complete ✓"

# 5. Setup directories & env
log "Setting up directories..."
mkdir -p "$PROJECT_DIR/data"
chown "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/data"
ENV_FILE="$PROJECT_DIR/.env"
if [ ! -f "$ENV_FILE" ] && [ -f "$PROJECT_DIR/.env.example" ]; then
  cp "$PROJECT_DIR/.env.example" "$ENV_FILE"
  chown "$CLAWBOX_USER:$CLAWBOX_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
# Point ClawBox config to project data dir
echo "  Done ✓"

# 6. Start ClawBox UI
log "Starting ClawBox on port $PORT..."
fuser -k "$PORT/tcp" 2>/dev/null || true
sleep 1

as_user bash -c "cd $PROJECT_DIR && CLAWBOX_ROOT=$PROJECT_DIR PORT=$PORT HOSTNAME=0.0.0.0 node .next/standalone/server.js > /tmp/clawbox-ui.log 2>&1 &"
sleep 3

if curl -s "http://localhost:$PORT" > /dev/null 2>&1; then
  echo "  ClawBox UI running! ✓"
else
  echo "  Warning: UI may still be starting, check /tmp/clawbox-ui.log"
fi

LOCAL_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "=== ClawBox x64 Setup Complete ==="
echo ""
echo "  Dashboard:  http://${LOCAL_IP}:${PORT}"
echo "  Logs:       /tmp/clawbox-ui.log"
echo ""
echo "  To stop:    fuser -k ${PORT}/tcp"
echo "  To restart: cd $PROJECT_DIR && PORT=$PORT HOSTNAME=0.0.0.0 node .next/standalone/server.js"
echo ""
