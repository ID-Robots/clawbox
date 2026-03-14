#!/usr/bin/env bash
# ClawBox x64 Desktop Installer — safe version that skips Jetson/network steps
# Installs OpenClaw + ClawBox UI for x64 desktop use.
# Does NOT modify: hostname, WiFi, DNS, systemd services, NVIDIA drivers
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

OPENCLAW_VERSION="2026.2.14"
NPM_PREFIX="$CLAWBOX_HOME/.npm-global"
OPENCLAW_BIN="$NPM_PREFIX/bin/openclaw"
CODE_SERVER_PORT="${CODE_SERVER_PORT:-8080}"
TOTAL_STEPS=9
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
echo "  Skipping: hostname, WiFi AP, JetPack, performance mode, jtop"
echo ""

# 1. System packages (minimal)
log "Checking system packages..."
apt-get update -qq
apt-get install -y -qq git curl
# Node.js still needed for terminal server (node-pty incompatible with bun)
NODE_VER="22.14.0"
NODE_OK=false
if node --version 2>/dev/null | grep -qE '^v(2[0-9]|[3-9][0-9])\.'; then
  NODE_OK=true
  echo "  Node.js $(node --version) ✓"
fi
if [ "$NODE_OK" = false ]; then
  echo "  Installing Node.js $NODE_VER (current: $(node --version 2>/dev/null || echo 'none'))..."
  ARCH=$(dpkg --print-architecture)
  case "$ARCH" in
    amd64) NODE_ARCH="x64" ;;
    arm64) NODE_ARCH="arm64" ;;
    *) echo "Error: unsupported architecture $ARCH" >&2; exit 1 ;;
  esac
  curl -fsSL "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-${NODE_ARCH}.tar.xz" | tar -xJ -C /usr/local --strip-components=1
  hash -r
  echo "  Node.js $(node --version) ✓"
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

# 5. Install/update OpenClaw
log "Installing OpenClaw..."
LATEST=$("$BUN" pm view openclaw version 2>/dev/null || npm view openclaw version --registry https://registry.npmjs.org 2>/dev/null || echo "")
TARGET="${LATEST:-$OPENCLAW_VERSION}"
NEED_INSTALL=true
if [ -x "$OPENCLAW_BIN" ]; then
  INSTALLED=$("$OPENCLAW_BIN" --version 2>/dev/null || echo "none")
  echo "  Installed: $INSTALLED, Target: $TARGET"
  if [ "$INSTALLED" = "$TARGET" ]; then
    NEED_INSTALL=false
    echo "  OpenClaw up to date ✓"
  fi
fi
if [ "$NEED_INSTALL" = true ]; then
  mkdir -p "$NPM_PREFIX"
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$NPM_PREFIX"
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$CLAWBOX_HOME/.npm" 2>/dev/null || true
  as_user "$BUN" install -g "openclaw@$TARGET" --prefix "$NPM_PREFIX" 2>/dev/null || as_user npm install -g "openclaw@$TARGET" --prefix "$NPM_PREFIX"
  if [ ! -x "$OPENCLAW_BIN" ]; then
    echo "  Warning: OpenClaw install failed — continuing without it"
  else
    echo "  OpenClaw installed: $("$OPENCLAW_BIN" --version 2>/dev/null) ✓"
  fi
fi
# Configure OpenClaw for local access (no auth)
if [ -x "$OPENCLAW_BIN" ]; then
  as_user "$OPENCLAW_BIN" config set gateway.auth.mode none 2>/dev/null || true
  as_user "$OPENCLAW_BIN" config set gateway.controlUi.allowInsecureAuth true --json 2>/dev/null || true
  as_user "$OPENCLAW_BIN" config set gateway.controlUi.dangerouslyDisableDeviceAuth true --json 2>/dev/null || true
  echo "  OpenClaw configured for local access ✓"
fi

# 6. Setup directories & env
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

# 7. Start OpenClaw gateway
log "Starting OpenClaw gateway..."
if [ -x "$OPENCLAW_BIN" ]; then
  fuser -k 18789/tcp 2>/dev/null || true
  sleep 1
  as_user bash -c "PATH=$NPM_PREFIX/bin:\$PATH $OPENCLAW_BIN gateway --allow-unconfigured --bind loopback > /tmp/openclaw-gateway.log 2>&1 &"
  sleep 3
  if curl -s "http://localhost:18789" > /dev/null 2>&1; then
    echo "  OpenClaw gateway running on port 18789 ✓"
  else
    echo "  Warning: Gateway may still be starting, check /tmp/openclaw-gateway.log"
  fi
else
  echo "  Skipping — OpenClaw not installed"
fi

# 8. Install & start code-server (VS Code in browser)
log "Installing code-server..."
if command -v code-server &>/dev/null; then
  echo "  code-server already installed: $(code-server --version 2>/dev/null | head -1)"
else
  echo "  Installing code-server..."
  as_user bash -o pipefail -c 'curl -fsSL https://code-server.dev/install.sh | sh'
  echo "  code-server installed ✓"
fi
# Configure code-server for local use (no auth)
CODE_SERVER_CONFIG="$CLAWBOX_HOME/.config/code-server/config.yaml"
mkdir -p "$(dirname "$CODE_SERVER_CONFIG")"
cat > "$CODE_SERVER_CONFIG" <<CSEOF
bind-addr: 0.0.0.0:${CODE_SERVER_PORT}
auth: none
cert: false
CSEOF
chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$CLAWBOX_HOME/.config/code-server"
echo "  Configured for port $CODE_SERVER_PORT (no auth) ✓"
# Start code-server
fuser -k "$CODE_SERVER_PORT/tcp" 2>/dev/null || true
sleep 1
as_user bash -c "code-server --bind-addr 0.0.0.0:${CODE_SERVER_PORT} --auth none > /tmp/code-server.log 2>&1 &"
sleep 2
if curl -s "http://localhost:$CODE_SERVER_PORT" > /dev/null 2>&1; then
  echo "  code-server running on port $CODE_SERVER_PORT ✓"
else
  echo "  Warning: code-server may still be starting, check /tmp/code-server.log"
fi

# 9. Start ClawBox UI
log "Starting ClawBox on port $PORT..."
fuser -k "$PORT/tcp" 2>/dev/null || true
sleep 1

as_user bash -c "cd $PROJECT_DIR && CLAWBOX_ROOT=$PROJECT_DIR PORT=$PORT HOSTNAME=0.0.0.0 $BUN run production-server.js > /tmp/clawbox-ui.log 2>&1 &"
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
echo "  Dashboard:    http://${LOCAL_IP}:${PORT}"
echo "  VS Code:      http://${LOCAL_IP}:${CODE_SERVER_PORT}"
echo "  OpenClaw:     http://${LOCAL_IP}:18789"
echo "  UI Logs:      /tmp/clawbox-ui.log"
echo "  Gateway Logs: /tmp/openclaw-gateway.log"
echo "  VS Code Logs: /tmp/code-server.log"
echo ""
echo "  To stop:    fuser -k ${PORT}/tcp"
echo "  To restart: cd $PROJECT_DIR && PORT=$PORT HOSTNAME=0.0.0.0 bun run production-server.js"
echo ""
