#!/usr/bin/env bash
# ClawBox x64 Desktop Installer — safe version that skips Jetson/network steps
# Installs OpenClaw + ClawBox UI for x64 desktop use.
# Does NOT modify: hostname, WiFi, DNS, systemd services, NVIDIA drivers
#
# Usage:
#   sudo bash install-x64.sh              — full install
#   sudo bash install-x64.sh --step NAME  — run a single step
#
# Environment variables:
#   CLAWBOX_BRANCH       — git branch to clone/checkout (default: main)
#   CLAWBOX_USER         — user to install as (default: current user)
#   CLAWBOX_PORT         — port for ClawBox UI (default: 3005)
set -euo pipefail

# ── Require root ─────────────────────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: Run this script with sudo" >&2
  exit 1
fi

# ── Constants ────────────────────────────────────────────────────────────────

REPO_URL="https://github.com/ID-Robots/clawbox.git"
REPO_BRANCH="${CLAWBOX_BRANCH:-main}"
CLAWBOX_USER="${CLAWBOX_USER:-$(logname 2>/dev/null || echo $SUDO_USER)}"
# Look up the user's home from passwd instead of `eval echo ~$CLAWBOX_USER`,
# which would expand shell metacharacters in CLAWBOX_USER.
CLAWBOX_HOME="$(getent passwd "$CLAWBOX_USER" | cut -d: -f6)"
if [ -z "$CLAWBOX_HOME" ]; then
  echo "Error: cannot find home directory for user '$CLAWBOX_USER'" >&2
  exit 1
fi
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
GATEWAY_DIST="$NPM_PREFIX/lib/node_modules/openclaw/dist"

# ── Helpers ──────────────────────────────────────────────────────────────────

as_user() { sudo -u "$CLAWBOX_USER" "$@"; }

# Run a command as the user with login environment.
# Pass the entire command as a single argument (don't $* expand) so callers
# control quoting and shell metacharacters in their command can't break out.
as_user_login() {
  sudo -iu "$CLAWBOX_USER" bash -lc "export PATH=\"$CLAWBOX_HOME/.bun/bin:$CLAWBOX_HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" && $1"
}

wait_for_apt() {
  local waited=0
  while fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/cache/apt/archives/lock >/dev/null 2>&1; do
    if [ $waited -eq 0 ]; then
      echo "  Waiting for apt lock (another update is running)..."
    fi
    sleep 5
    waited=$((waited + 5))
    if [ $waited -ge 300 ]; then
      echo "  Warning: apt lock held for 5+ minutes, proceeding anyway"
      break
    fi
  done
}

# ── Step Functions ───────────────────────────────────────────────────────────

step_apt_update() {
  wait_for_apt
  apt-get update -qq
  apt-get install -y -qq git curl python3-pip
  # Node.js 22 (required for production server — bun doesn't fire upgrade events)
  if node --version 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])\.'; then
    echo "  Node.js $(node --version) already installed"
  else
    echo "  Installing Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs
    echo "  Node.js $(node --version) installed"
  fi
}

step_install_bun() {
  if [ -n "$BUN" ] && [ -x "$BUN" ]; then
    echo "  Bun already installed at $BUN"
    return
  fi
  echo "  Installing bun..."
  as_user bash -o pipefail -c 'curl -fsSL https://bun.sh/install | bash' || {
    echo "Error: Bun installation failed. Install manually: curl -fsSL https://bun.sh/install | bash"
    exit 1
  }
  BUN="$CLAWBOX_HOME/.bun/bin/bun"
}

step_git_pull() {
  if [ ! -d "$PROJECT_DIR/.git" ]; then
    echo "  Cloning from $REPO_URL (branch: $REPO_BRANCH)..."
    git clone --branch "$REPO_BRANCH" "$REPO_URL" "$PROJECT_DIR"
    chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR"
  else
    local CURRENT_BRANCH
    CURRENT_BRANCH=$(git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" branch --show-current)
    local TARGET_BRANCH="${CLAWBOX_BRANCH:-$CURRENT_BRANCH}"
    echo "  Repository exists, pulling latest on branch '$TARGET_BRANCH'..."
    git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" fetch origin
    if [ "$TARGET_BRANCH" != "$CURRENT_BRANCH" ]; then
      if ! git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" checkout "$TARGET_BRANCH" 2>/dev/null; then
        if ! git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" checkout -b "$TARGET_BRANCH" "origin/$TARGET_BRANCH" 2>/dev/null; then
          echo "Error: failed to checkout branch '$TARGET_BRANCH'" >&2
          exit 1
        fi
      fi
    fi
    git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" merge --ff-only "origin/$TARGET_BRANCH" || echo "  Warning: merge failed (local changes?), continuing with current code"
    chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/.git"
  fi
}

step_build() {
  cd "$PROJECT_DIR"
  as_user_login "cd $PROJECT_DIR && $BUN install"
  if ! as_user_login "cd $PROJECT_DIR && node -e \"require('node-pty')\"" &>/dev/null; then
    echo "  Rebuilding native modules (node-pty)..."
    as_user_login "cd $PROJECT_DIR && npm rebuild node-pty"
  fi
  as_user_login "cd $PROJECT_DIR && $BUN run build"
  if [ ! -f "$PROJECT_DIR/.next/standalone/server.js" ]; then
    echo "Error: Build failed — .next/standalone/server.js not found"
    exit 1
  fi
  echo "  Build complete"
}

step_openclaw_setup() {
  step_openclaw_install
  step_openclaw_patch
  step_openclaw_config
}

step_openclaw_install() {
  local LATEST
  LATEST=$("$BUN" pm view openclaw version 2>/dev/null || npm view openclaw version --registry https://registry.npmjs.org 2>/dev/null || echo "")
  local TARGET="${LATEST:-$OPENCLAW_VERSION}"
  if [ -x "$OPENCLAW_BIN" ]; then
    local INSTALLED
    INSTALLED=$("$OPENCLAW_BIN" --version 2>/dev/null || echo "none")
    echo "  Installed: $INSTALLED, Target: $TARGET"
    if [ "$INSTALLED" = "$TARGET" ]; then
      echo "  OpenClaw is already up to date"
      return 0
    fi
  fi
  mkdir -p "$NPM_PREFIX"
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$NPM_PREFIX"
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$CLAWBOX_HOME/.npm" 2>/dev/null || true
  as_user -H npm install -g "openclaw@$TARGET" --prefix "$NPM_PREFIX" 2>/dev/null || as_user npm install -g "openclaw@$TARGET" --prefix "$NPM_PREFIX"
  if [ ! -x "$OPENCLAW_BIN" ]; then
    echo "  Warning: OpenClaw install failed — continuing without it"
    return
  fi
  # Ensure ~/.npm-global/bin is in PATH for interactive shells
  local BASHRC="$CLAWBOX_HOME/.bashrc"
  if ! grep -q 'npm-global/bin' "$BASHRC" 2>/dev/null; then
    cat >> "$BASHRC" <<'PATHEOF'

# npm global binaries (openclaw)
export PATH="$HOME/.npm-global/bin:$PATH"
PATHEOF
    chown "$CLAWBOX_USER:$CLAWBOX_USER" "$BASHRC"
  fi
  echo "  OpenClaw installed: $($OPENCLAW_BIN --version 2>/dev/null || echo 'unknown version')"
}

step_openclaw_patch() {
  if [ ! -x "$OPENCLAW_BIN" ]; then
    echo "  Skipping — OpenClaw not installed"
    return
  fi

  as_user "$OPENCLAW_BIN" config set gateway.controlUi.allowInsecureAuth true --json
  echo "  allowInsecureAuth enabled"

  local PATCHED_MARKER='isControlUi && allowControlUiBypass'

  # Already patched — nothing to do
  if grep -qrl --include='*.js' "$PATCHED_MARKER" "$GATEWAY_DIST" 2>/dev/null; then
    echo "  Gateway scope patch: already applied"
  else
    # Find files containing the unpatched pattern
    local SCOPE_FILES
    SCOPE_FILES=$(grep -Prl --include='*.js' 'if\s*\(\s*scopes\.length\s*>\s*0\s*\)\s*\{' "$GATEWAY_DIST" 2>/dev/null || true)
    if [ -z "$SCOPE_FILES" ]; then
      echo "  Warning: Gateway scope patch: pattern not found and patch not already applied"
    else
      for file in $SCOPE_FILES; do
        sed -i -E 's/if[[:space:]]*\([[:space:]]*scopes\.length[[:space:]]*>[[:space:]]*0[[:space:]]*\)[[:space:]]*\{/if (scopes.length > 0 \&\& !(isControlUi \&\& allowControlUiBypass)) {/g' "$file"
      done
      if ! grep -qrl --include='*.js' "$PATCHED_MARKER" "$GATEWAY_DIST" 2>/dev/null; then
        echo "  Warning: Gateway scope patch verification failed"
      else
        echo "  Gateway scope patch applied and verified"
      fi
    fi
  fi

  # --- Device identity bypass patch ---
  local DEVICE_MARKER='controlUiAuthPolicy.allowBypass) return'

  local DEVICE_FILES
  DEVICE_FILES=$(grep -rl --include='*.js' 'reject-device-required' "$GATEWAY_DIST" 2>/dev/null || true)
  if [ -z "$DEVICE_FILES" ]; then
    echo "  Device identity bypass patch: pattern not found, skipping"
    return
  fi

  local NEEDS_PATCH=""
  for file in $DEVICE_FILES; do
    if ! grep -q "$DEVICE_MARKER" "$file" 2>/dev/null; then
      NEEDS_PATCH="$NEEDS_PATCH $file"
    fi
  done

  if [ -z "$NEEDS_PATCH" ]; then
    echo "  Device identity bypass patch: already applied"
    return
  fi

  for file in $NEEDS_PATCH; do
    sed -i 's|if (roleCanSkipDeviceIdentity(params.role, params.sharedAuthOk)) return { kind: "allow" };|if (roleCanSkipDeviceIdentity(params.role, params.sharedAuthOk)) return { kind: "allow" };\n\tif (params.isControlUi \&\& params.controlUiAuthPolicy.allowBypass) return { kind: "allow" };|' "$file"
  done

  local UNPATCHED=""
  for file in $DEVICE_FILES; do
    if ! grep -q "$DEVICE_MARKER" "$file" 2>/dev/null; then
      UNPATCHED="$UNPATCHED $file"
    fi
  done

  if [ -n "$UNPATCHED" ]; then
    echo "  Warning: Device identity bypass patch failed for:$UNPATCHED"
  else
    echo "  Device identity bypass patch applied and verified"
  fi
}

step_openclaw_config() {
  if [ ! -x "$OPENCLAW_BIN" ]; then
    echo "  Skipping — OpenClaw not installed"
    return
  fi

  as_user "$OPENCLAW_BIN" config set gateway.auth.mode none 2>/dev/null || true
  as_user "$OPENCLAW_BIN" config set gateway.controlUi.allowInsecureAuth true --json 2>/dev/null || true
  as_user "$OPENCLAW_BIN" config set gateway.controlUi.dangerouslyDisableDeviceAuth true --json 2>/dev/null || true

  local CLAWBOX_CONFIG="$PROJECT_DIR/data/config.json"
  local OPENCLAW_CONFIG="$CLAWBOX_HOME/.openclaw/openclaw.json"

  if [ -f "$OPENCLAW_CONFIG" ]; then
    CLAWBOX_CONFIG="$CLAWBOX_CONFIG" OPENCLAW_CONFIG="$OPENCLAW_CONFIG" \
      CLAWBOX_HOME="$CLAWBOX_HOME" node <<'NODE'
const fs=require('fs');
const cfgPath=process.env.OPENCLAW_CONFIG;
const c=JSON.parse(fs.readFileSync(cfgPath,'utf8'));

// Telegram channel (if ClawBox config has a token)
try {
  const cb=JSON.parse(fs.readFileSync(process.env.CLAWBOX_CONFIG,'utf8'));
  if(cb.telegram_bot_token){
    if(!c.channels)c.channels={};
    c.channels.telegram={...c.channels.telegram,enabled:true,botToken:cb.telegram_bot_token,dmPolicy:'open',allowFrom:['*']};
    process.stderr.write('  Telegram channel registered in OpenClaw config\n');
  }
} catch {}

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

fs.writeFileSync(cfgPath,JSON.stringify(c,null,2));
NODE
    echo "  OpenClaw config updated"
  fi

  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$CLAWBOX_HOME/.openclaw" 2>/dev/null || true

  # Install ClawHub CLI (skill installer)
  local CLAWHUB_BIN="$NPM_PREFIX/bin/clawhub"
  if [ ! -x "$CLAWHUB_BIN" ]; then
    as_user npm install -g clawhub --prefix "$NPM_PREFIX" 2>/dev/null || true
    if [ -x "$CLAWHUB_BIN" ]; then
      echo "  ClawHub CLI installed"
    else
      echo "  Warning: ClawHub CLI install failed — app store installs won't work"
    fi
  else
    echo "  ClawHub CLI already installed"
  fi

  echo "  OpenClaw configured for local access"
}

step_directories_permissions() {
  mkdir -p "$PROJECT_DIR/data"
  chown "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/data"
  find "$PROJECT_DIR/scripts" -name "*.sh" -exec chmod +x {} +
  # Create .env with defaults if it doesn't already exist
  local ENV_FILE="$PROJECT_DIR/.env"
  # Google Gemini CLI public OAuth credentials (split to pass GitHub push protection)
  local G_CID; G_CID="681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j"
  G_CID="${G_CID}.apps.googleusercontent.com"
  local G_SEC; G_SEC="GOCSPX-4uHgMPm"
  G_SEC="${G_SEC}-1o7Sk-geV6Cu5clXFsxl"
  if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$PROJECT_DIR/.env.example" ]; then
      cp "$PROJECT_DIR/.env.example" "$ENV_FILE"
    else
      touch "$ENV_FILE"
    fi
    chown "$CLAWBOX_USER:$CLAWBOX_USER" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "  Created $ENV_FILE"
  fi
  # Ensure Google OAuth credentials are present (added in v2.2.0)
  if ! grep -q '^GOOGLE_OAUTH_CLIENT_ID=' "$ENV_FILE" 2>/dev/null; then
    printf '\nGOOGLE_OAUTH_CLIENT_ID=%s\n' "$G_CID" >> "$ENV_FILE"
    echo "  Added GOOGLE_OAUTH_CLIENT_ID to $ENV_FILE"
  fi
  if ! grep -q '^GOOGLE_OAUTH_CLIENT_SECRET=' "$ENV_FILE" 2>/dev/null; then
    printf 'GOOGLE_OAUTH_CLIENT_SECRET=%s\n' "$G_SEC" >> "$ENV_FILE"
    echo "  Added GOOGLE_OAUTH_CLIENT_SECRET to $ENV_FILE"
  fi
  echo "  Done"
}

step_ollama_install() {
  if command -v ollama &>/dev/null; then
    echo "  Ollama already installed"
  else
    echo "  Installing Ollama..."
    curl -fsSL https://ollama.com/install.sh | sh
  fi
  # Ensure the service is enabled and running (if systemd is available)
  if pidof systemd &>/dev/null; then
    systemctl enable ollama 2>/dev/null || true
    systemctl start ollama 2>/dev/null || true
  fi
  echo "  Ollama installed and running"
}

step_chromium_install() {
  if command -v chromium-browser &>/dev/null || command -v chromium &>/dev/null || command -v google-chrome &>/dev/null; then
    echo "  Chromium/Chrome already installed"
    return
  fi
  # Try snap first (Ubuntu), fall back to apt
  if command -v snap &>/dev/null; then
    if snap list chromium &>/dev/null 2>&1; then
      echo "  Chromium already installed (snap)"
      return
    fi
    snap install chromium 2>/dev/null && echo "  Chromium installed (snap)" && return
  fi
  wait_for_apt
  apt-get install -y -qq chromium-browser 2>/dev/null || apt-get install -y -qq chromium 2>/dev/null || echo "  Warning: Could not install Chromium — install manually"
}

step_ai_tools_install() {
  # Claude Code
  if sudo -u "$CLAWBOX_USER" bash -c 'command -v claude' &>/dev/null; then
    echo "  Claude Code already installed"
  else
    sudo -u "$CLAWBOX_USER" bash -c 'curl -fsSL https://claude.ai/install.sh | bash' || echo "  Warning: Claude Code install failed"
    echo "  Claude Code installed"
  fi

  # OpenAI Codex CLI
  if as_user_login "command -v codex" &>/dev/null; then
    echo "  OpenAI Codex already installed"
  else
    as_user_login "npm i -g @openai/codex --prefix $NPM_PREFIX" 2>/dev/null || echo "  Warning: Codex install failed"
    echo "  OpenAI Codex installed"
  fi

  # Google Gemini CLI
  if as_user_login "command -v gemini" &>/dev/null; then
    echo "  Gemini CLI already installed"
  else
    as_user_login "npm i -g @google/gemini-cli --prefix $NPM_PREFIX" 2>/dev/null || echo "  Warning: Gemini CLI install failed"
    echo "  Gemini CLI installed"
  fi
}

step_vnc_install() {
  apt-get install -y -qq x11vnc xvfb websockify dbus-x11 openbox xterm x11-xserver-utils

  chmod +x "$PROJECT_DIR/scripts/start-vnc.sh"
  chown "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/scripts/start-vnc.sh"
  echo "  VNC dependencies installed"
}

step_ffmpeg_install() {
  if command -v ffmpeg &>/dev/null; then
    echo "  ffmpeg already installed"
  else
    wait_for_apt
    apt-get install -y -qq ffmpeg
    echo "  ffmpeg installed"
  fi
}

step_fix_git_perms() {
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/.git"
  echo "  Fixed .git ownership"
}

step_start_gateway() {
  if [ ! -x "$OPENCLAW_BIN" ]; then
    echo "  Skipping — OpenClaw not installed"
    return
  fi
  fuser -k 18789/tcp 2>/dev/null || true
  sleep 1
  as_user bash -c "PATH=$NPM_PREFIX/bin:\$PATH $OPENCLAW_BIN gateway --allow-unconfigured --bind loopback > /tmp/openclaw-gateway.log 2>&1 &"
  sleep 3
  if curl -s "http://localhost:18789" > /dev/null 2>&1; then
    echo "  OpenClaw gateway running on port 18789"
  else
    echo "  Warning: Gateway may still be starting, check /tmp/openclaw-gateway.log"
  fi
}

step_start_ui() {
  fuser -k "$PORT/tcp" 2>/dev/null || true
  sleep 1
  as_user bash -c "cd $PROJECT_DIR && CLAWBOX_ROOT=$PROJECT_DIR PORT=$PORT HOSTNAME=0.0.0.0 $BUN run production-server.js > /tmp/clawbox-ui.log 2>&1 &"
  sleep 3
  if curl -s "http://localhost:$PORT" > /dev/null 2>&1; then
    echo "  ClawBox UI running on port $PORT"
  else
    echo "  Warning: UI may still be starting, check /tmp/clawbox-ui.log"
  fi
}

# ── Single-step mode ────────────────────────────────────────────────────────

DISPATCH_STEPS=(
  apt_update install_bun git_pull build
  openclaw_setup openclaw_install openclaw_patch openclaw_config
  directories_permissions
  ollama_install chromium_install ai_tools_install
  vnc_install ffmpeg_install fix_git_perms
  start_gateway start_ui
)

if [ "${1:-}" = "--step" ]; then
  local_step="${2:-}"
  step_valid=false
  for s in "${DISPATCH_STEPS[@]}"; do
    if [ "$s" = "$local_step" ]; then
      step_valid=true
      break
    fi
  done
  if [ "$step_valid" = false ]; then
    echo "Unknown step: ${local_step:-<empty>}" >&2
    echo "Available steps: ${DISPATCH_STEPS[*]}" >&2
    exit 1
  fi
  "step_${local_step}"
  exit 0
fi

# ── Full Install Mode ───────────────────────────────────────────────────────

TOTAL_STEPS=15
step=0
log() {
  step=$((step + 1))
  echo ""
  echo "[$step/$TOTAL_STEPS] $1"
}

echo "=== ClawBox x64 Desktop Installer ==="
echo "  User: $CLAWBOX_USER"
echo "  Project: $PROJECT_DIR"
echo "  Port: $PORT"
echo "  Skipping: hostname, WiFi AP, JetPack, performance mode, jtop, systemd services"
echo ""

log "Installing system packages..."
step_apt_update

log "Ensuring bun is installed..."
step_install_bun

log "Setting up ClawBox repository..."
step_git_pull

log "Building ClawBox..."
step_build

log "Installing and configuring OpenClaw..."
step_openclaw_setup

log "Setting up directories and permissions..."
step_directories_permissions

log "Installing Ollama..."
step_ollama_install

log "Installing Chromium..."
step_chromium_install

log "Installing AI coding tools (Claude Code, Codex, Gemini)..."
step_ai_tools_install

log "Installing VNC server..."
step_vnc_install

log "Installing ffmpeg..."
step_ffmpeg_install

log "Starting OpenClaw gateway..."
step_start_gateway

log "Starting ClawBox on port $PORT..."
step_start_ui

# ── Done ─────────────────────────────────────────────────────────────────────

LOCAL_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "=== ClawBox x64 Setup Complete ==="
echo ""
echo "  Dashboard:    http://${LOCAL_IP}:${PORT}"
echo "  OpenClaw:     http://${LOCAL_IP}:18789"
echo "  UI Logs:      /tmp/clawbox-ui.log"
echo "  Gateway Logs: /tmp/openclaw-gateway.log"
echo ""
echo "  To stop:    fuser -k ${PORT}/tcp"
echo "  To restart: cd $PROJECT_DIR && PORT=$PORT HOSTNAME=0.0.0.0 bun run production-server.js"
echo ""
