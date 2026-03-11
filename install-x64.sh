#!/usr/bin/env bash
# ClawBox x64 Desktop Installer — safe version that skips Jetson/network steps
# Does NOT modify: hostname, WiFi, DNS, systemd services, NVIDIA drivers
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: Run this script with sudo" >&2
  exit 1
fi

REPO_URL="https://github.com/ID-Robots/clawbox.git"
REPO_BRANCH="${CLAWBOX_BRANCH:-main}"
CLAWBOX_USER="clawbox"
CLAWBOX_HOME="/home/clawbox"
PROJECT_DIR="$CLAWBOX_HOME/clawbox"
BUN="$CLAWBOX_HOME/.bun/bin/bun"
NPM_PREFIX="$CLAWBOX_HOME/.npm-global"
OPENCLAW_BIN="$NPM_PREFIX/bin/openclaw"
PORT="${CLAWBOX_PORT:-3005}"

TOTAL_STEPS=10
step=0
log() {
  step=$((step + 1))
  echo ""
  echo "[$step/$TOTAL_STEPS] $1"
}

as_clawbox() { sudo -u "$CLAWBOX_USER" "$@"; }
as_clawbox_login() { su - "$CLAWBOX_USER" -c "$*"; }

echo "=== ClawBox x64 Desktop Installer ==="
echo "  Skipping: hostname, WiFi AP, JetPack, performance mode, jtop, systemd services"
echo ""

# 1. Create user
log "Ensuring clawbox user exists..."
if ! id -u "$CLAWBOX_USER" &>/dev/null; then
  useradd -m -s /bin/bash "$CLAWBOX_USER"
  for grp in sudo video audio; do
    getent group "$grp" &>/dev/null && usermod -aG "$grp" "$CLAWBOX_USER" 2>/dev/null || true
  done
  echo "  User '$CLAWBOX_USER' created"
else
  echo "  User '$CLAWBOX_USER' exists"
fi

# 2. System packages
log "Installing system packages..."
apt-get update -qq
apt-get install -y -qq git curl avahi-daemon python3-pip
if node --version 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])\.'; then
  echo "  Node.js $(node --version) already installed"
else
  echo "  Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

# 3. Clone/pull repo
log "Setting up ClawBox repository..."
if [ ! -d "$PROJECT_DIR/.git" ]; then
  git clone --branch "$REPO_BRANCH" "$REPO_URL" "$PROJECT_DIR"
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR"
else
  git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" fetch origin
  git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" checkout "$REPO_BRANCH" 2>/dev/null || true
  git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" merge --ff-only "origin/$REPO_BRANCH" || echo "  Warning: merge failed, continuing"
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/.git"
fi

# 4. Install bun
log "Installing bun..."
if [ -x "$BUN" ]; then
  echo "  Bun already installed"
else
  as_clawbox bash -o pipefail -c 'curl -fsSL https://bun.sh/install | bash'
fi

# 5. Build
log "Building ClawBox..."
cd "$PROJECT_DIR"
as_clawbox "$BUN" install
as_clawbox "$BUN" run build
if [ ! -f "$PROJECT_DIR/.next/standalone/server.js" ]; then
  echo "Error: Build failed"
  exit 1
fi
echo "  Build complete"

# 6. Install OpenClaw
log "Installing OpenClaw..."
LATEST=$(npm view openclaw version --registry https://registry.npmjs.org 2>/dev/null || echo "2026.2.14")
mkdir -p "$NPM_PREFIX"
chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$NPM_PREFIX"
chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$CLAWBOX_HOME/.npm" 2>/dev/null || true
if [ -x "$OPENCLAW_BIN" ]; then
  INSTALLED=$("$OPENCLAW_BIN" --version 2>/dev/null || echo "none")
  if [ "$INSTALLED" = "$LATEST" ]; then
    echo "  OpenClaw already up to date ($INSTALLED)"
  else
    as_clawbox -H npm install -g "openclaw@$LATEST" --prefix "$NPM_PREFIX"
  fi
else
  as_clawbox -H npm install -g "openclaw@$LATEST" --prefix "$NPM_PREFIX"
fi

# 7. Patch OpenClaw
log "Patching OpenClaw..."
GATEWAY_DIST="$NPM_PREFIX/lib/node_modules/openclaw/dist"
as_clawbox "$OPENCLAW_BIN" config set gateway.controlUi.allowInsecureAuth true --json 2>/dev/null || true

PATCHED_MARKER='isControlUi && allowControlUiBypass'
if grep -qrl "$PATCHED_MARKER" "$GATEWAY_DIST" 2>/dev/null; then
  echo "  Gateway scope patch: already applied"
else
  SCOPE_FILES=$(grep -Prl 'if\s*\(\s*scopes\.length\s*>\s*0\s*\)\s*\{' "$GATEWAY_DIST" 2>/dev/null || true)
  if [ -n "$SCOPE_FILES" ]; then
    for file in $SCOPE_FILES; do
      sed -i -E 's/if[[:space:]]*\([[:space:]]*scopes\.length[[:space:]]*>[[:space:]]*0[[:space:]]*\)[[:space:]]*\{/if (scopes.length > 0 \&\& !(isControlUi \&\& allowControlUiBypass)) {/g' "$file"
    done
    echo "  Gateway scope patch applied"
  fi
fi

# 8. Configure OpenClaw
log "Configuring OpenClaw..."
OPENCLAW_CONFIG="$CLAWBOX_HOME/.openclaw/openclaw.json"
mkdir -p "$CLAWBOX_HOME/.openclaw"
chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$CLAWBOX_HOME/.openclaw"
if [ -f "$OPENCLAW_CONFIG" ]; then
  node -e "
const fs=require('fs');
const c=JSON.parse(fs.readFileSync('$OPENCLAW_CONFIG','utf8'));
if(!c.agents)c.agents={};
if(!c.agents.defaults)c.agents.defaults={};
if(!c.agents.defaults.model)c.agents.defaults.model={};
c.agents.defaults.model.primary='anthropic/claude-sonnet-4-20250514';
if(!c.gateway)c.gateway={};
if(!c.gateway.auth)c.gateway.auth={};
c.gateway.auth.mode='none';
if(!c.gateway.controlUi)c.gateway.controlUi={};
c.gateway.controlUi.allowInsecureAuth=true;
c.gateway.controlUi.dangerouslyDisableDeviceAuth=true;
fs.writeFileSync('$OPENCLAW_CONFIG',JSON.stringify(c,null,2));
console.log('  Config updated');
"
fi

# 9. Setup directories & env
log "Setting up directories..."
mkdir -p "$PROJECT_DIR/data"
chown "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/data"
ENV_FILE="$PROJECT_DIR/.env"
if [ ! -f "$ENV_FILE" ] && [ -f "$PROJECT_DIR/.env.example" ]; then
  cp "$PROJECT_DIR/.env.example" "$ENV_FILE"
  chown "$CLAWBOX_USER:$CLAWBOX_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
echo "  Done"

# 10. Start ClawBox UI
log "Starting ClawBox on port $PORT..."
# Kill any existing instance on this port
fuser -k "$PORT/tcp" 2>/dev/null || true
sleep 1

# Start as clawbox user
as_clawbox bash -c "cd $PROJECT_DIR && PORT=$PORT HOSTNAME=0.0.0.0 node .next/standalone/server.js > /tmp/clawbox-ui.log 2>&1 &"
sleep 3

if curl -s "http://localhost:$PORT" > /dev/null 2>&1; then
  echo "  ClawBox UI running!"
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
echo "  To restart: sudo -u clawbox bash -c 'cd $PROJECT_DIR && PORT=$PORT HOSTNAME=0.0.0.0 node .next/standalone/server.js &'"
echo ""
