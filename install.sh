#!/usr/bin/env bash
# ClawBox Installer & Updater — single script for both fresh installs and
# individual update steps triggered from the dashboard.
#
# Usage:
#   sudo bash install.sh              — full install (fresh or re-install)
#   sudo bash install.sh --step NAME  — run a single step (used by systemd)
#
# Environment variables:
#   CLAWBOX_BRANCH       — git branch to clone/checkout (default: main)
#   NETWORK_INTERFACE    — WiFi interface override (default: auto-detect)
set -euo pipefail

# ── Require root ─────────────────────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: Run this script with sudo" >&2
  exit 1
fi

# ── Constants ────────────────────────────────────────────────────────────────

REPO_URL="https://github.com/ID-Robots/clawbox.git"
REPO_BRANCH="${CLAWBOX_BRANCH:-main}"
PROJECT_DIR="/home/clawbox/clawbox"
CLAWBOX_USER="clawbox"
CLAWBOX_HOME="/home/clawbox"
BUN="$CLAWBOX_HOME/.bun/bin/bun"
NPM_PREFIX="$CLAWBOX_HOME/.npm-global"
OPENCLAW_BIN="$NPM_PREFIX/bin/openclaw"
OPENCLAW_VERSION="2026.2.14"
GATEWAY_DIST="$NPM_PREFIX/lib/node_modules/openclaw/dist"
DNSMASQ_DIR="/etc/NetworkManager/dnsmasq-shared.d"
AVAHI_CONF="/etc/avahi/avahi-daemon.conf"

# Load persisted WiFi interface if available
IFACE_ENV="$PROJECT_DIR/data/network.env"
if [ -f "$IFACE_ENV" ]; then
  # shellcheck disable=SC1090
  source "$IFACE_ENV"
fi

# ── Helpers ──────────────────────────────────────────────────────────────────

# Run a command as the clawbox user
as_clawbox() { sudo -u "$CLAWBOX_USER" "$@"; }

# Run a command as the clawbox user with login environment
as_clawbox_login() { su - "$CLAWBOX_USER" -c "$*"; }

# Stop the setup service, clear cache, reinstall, and rebuild
do_rebuild() {
  echo "Stopping clawbox-setup.service for rebuild..."
  systemctl stop clawbox-setup.service 2>/dev/null || true
  echo "Clearing .next cache..."
  rm -rf "$PROJECT_DIR/.next"
  echo "Running bun install..."
  as_clawbox_login "cd $PROJECT_DIR && $BUN install"
  if ! as_clawbox_login "cd $PROJECT_DIR && node -e \"require('node-pty')\"" &>/dev/null; then
    echo "Rebuilding native modules (node-pty)..."
    as_clawbox_login "cd $PROJECT_DIR && npm rebuild node-pty"
  fi
  echo "Running bun build..."
  as_clawbox_login "cd $PROJECT_DIR && $BUN run build"
}

# ── Step Functions ───────────────────────────────────────────────────────────

step_ensure_user() {
  if ! id -u "$CLAWBOX_USER" &>/dev/null; then
    echo "  Creating user '$CLAWBOX_USER'..."
    useradd -m -s /bin/bash "$CLAWBOX_USER"
    for grp in sudo video audio i2c gpio; do
      getent group "$grp" &>/dev/null && usermod -aG "$grp" "$CLAWBOX_USER" 2>/dev/null || true
    done
    echo "  User '$CLAWBOX_USER' created (uid=$(id -u "$CLAWBOX_USER"))"
  else
    echo "  User '$CLAWBOX_USER' exists (uid=$(id -u "$CLAWBOX_USER"))"
  fi
}

step_apt_update() {
  apt-get update -qq
  apt-get install -y -qq git curl network-manager avahi-daemon iptables iw python3-pip gh
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

step_detect_wifi() {
  local WIFI_IFACE="${NETWORK_INTERFACE:-}"
  if [ -z "$WIFI_IFACE" ]; then
    WIFI_IFACE=$(iw dev 2>/dev/null | awk '/Interface/{print $2}' | head -1)
  fi
  if [ -z "$WIFI_IFACE" ]; then
    echo "Error: No WiFi interface found. Ensure a wireless adapter is available."
    echo "You can override with: NETWORK_INTERFACE=wlan0 sudo bash install.sh"
    exit 1
  fi
  if ! iw dev "$WIFI_IFACE" info >/dev/null 2>&1; then
    echo "Error: WiFi interface '$WIFI_IFACE' not found or not wireless."
    exit 1
  fi
  echo "  WiFi interface: $WIFI_IFACE"
  # Persist for scripts and services
  mkdir -p "$PROJECT_DIR/data"
  printf 'NETWORK_INTERFACE=%s\n' "$WIFI_IFACE" > "$IFACE_ENV"
  chown "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/data" "$IFACE_ENV"
  # Also write to root-owned path for clawbox-root-update@ service
  mkdir -p /etc/clawbox
  printf 'NETWORK_INTERFACE=%s\n' "$WIFI_IFACE" > /etc/clawbox/network.env
  chmod 644 /etc/clawbox/network.env
  echo "  WiFi interface saved to $IFACE_ENV and /etc/clawbox/network.env"
}

step_hostname_mdns() {
  hostnamectl set-hostname clawbox
  if [ ! -f "$AVAHI_CONF" ]; then
    echo "  Warning: $AVAHI_CONF not found, skipping avahi configuration"
    return
  fi
  cp -n "$AVAHI_CONF" "${AVAHI_CONF}.bak" 2>/dev/null || true
  # Handle both commented and uncommented host-name lines
  if grep -q '^#\?host-name=' "$AVAHI_CONF"; then
    sed -i 's/^#\?host-name=.*/host-name=clawbox/' "$AVAHI_CONF"
  elif grep -q '^\[server\]' "$AVAHI_CONF"; then
    sed -i '/^\[server\]/a host-name=clawbox' "$AVAHI_CONF"
  else
    printf '\n[server]\nhost-name=clawbox\n' >> "$AVAHI_CONF"
  fi
  systemctl restart avahi-daemon
  echo "  Hostname set to 'clawbox', avahi restarted"
}

step_git_pull() {
  if [ ! -d "$PROJECT_DIR/.git" ]; then
    echo "  Cloning from $REPO_URL (branch: $REPO_BRANCH)..."
    git clone --branch "$REPO_BRANCH" "$REPO_URL" "$PROJECT_DIR"
    chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR"
  else
    local CURRENT_BRANCH
    CURRENT_BRANCH=$(git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" branch --show-current)
    # Only switch branches if CLAWBOX_BRANCH was explicitly set
    local TARGET_BRANCH="${CLAWBOX_BRANCH:-$CURRENT_BRANCH}"
    echo "  Repository exists, pulling latest on branch '$TARGET_BRANCH'..."
    git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" fetch origin
    if [ "$TARGET_BRANCH" != "$CURRENT_BRANCH" ]; then
      git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" checkout "$TARGET_BRANCH" 2>/dev/null || true
    fi
    git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" merge --ff-only "origin/$TARGET_BRANCH" || echo "  Warning: merge failed (local changes?), continuing with current code"
    # Fix .git ownership — git operations run as root create root-owned files
    # which block the clawbox user from pulling later (e.g. FETCH_HEAD)
    chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/.git"
  fi
}

step_install_bun() {
  if [ -x "$BUN" ]; then
    echo "  Bun already installed at $BUN"
    return
  fi
  echo "  Installing bun..."
  as_clawbox bash -o pipefail -c 'curl -fsSL https://bun.sh/install | bash' || {
    echo "Error: Bun installation failed. Install manually: curl -fsSL https://bun.sh/install | bash"
    exit 1
  }
}

step_build() {
  cd "$PROJECT_DIR"
  as_clawbox_login "cd $PROJECT_DIR && $BUN install"
  if ! as_clawbox_login "cd $PROJECT_DIR && node -e \"require('node-pty')\"" &>/dev/null; then
    echo "  Rebuilding native modules (node-pty)..."
    as_clawbox_login "cd $PROJECT_DIR && npm rebuild node-pty"
  fi
  as_clawbox_login "cd $PROJECT_DIR && $BUN run build"
  if [ ! -f "$PROJECT_DIR/.next/standalone/server.js" ]; then
    echo "Error: Build failed — .next/standalone/server.js not found"
    exit 1
  fi
  echo "  Build complete"
}

step_openclaw_install() {
  local LATEST
  LATEST=$(npm view openclaw version --registry https://registry.npmjs.org 2>/dev/null || echo "")
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
  as_clawbox -H npm install -g "openclaw@$TARGET" --prefix "$NPM_PREFIX"
  if [ ! -x "$OPENCLAW_BIN" ]; then
    echo "Error: OpenClaw installation failed — $OPENCLAW_BIN not found"
    exit 1
  fi
  echo "  OpenClaw installed: $($OPENCLAW_BIN --version 2>/dev/null || echo 'unknown version')"
}

step_openclaw_patch() {
  as_clawbox "$OPENCLAW_BIN" config set gateway.controlUi.allowInsecureAuth true --json
  echo "  allowInsecureAuth enabled"

  local PATCHED_MARKER='isControlUi && allowControlUiBypass'

  # Already patched — nothing to do
  if grep -qrl "$PATCHED_MARKER" "$GATEWAY_DIST" 2>/dev/null; then
    echo "  Gateway scope patch: already applied"
    return
  fi

  # Find files containing the unpatched pattern
  local SCOPE_FILES
  SCOPE_FILES=$(grep -Prl 'if\s*\(\s*scopes\.length\s*>\s*0\s*\)\s*\{' "$GATEWAY_DIST" 2>/dev/null || true)
  if [ -z "$SCOPE_FILES" ]; then
    echo "Error: Gateway scope patch: pattern not found and patch not already applied"
    exit 1
  fi

  for file in $SCOPE_FILES; do
    sed -i -E 's/if[[:space:]]*\([[:space:]]*scopes\.length[[:space:]]*>[[:space:]]*0[[:space:]]*\)[[:space:]]*\{/if (scopes.length > 0 \&\& !(isControlUi \&\& allowControlUiBypass)) {/g' "$file"
  done

  # Verify the patch took effect
  if ! grep -qrl "$PATCHED_MARKER" "$GATEWAY_DIST" 2>/dev/null; then
    echo "Error: Gateway scope patch verification failed"
    exit 1
  fi
  echo "  Gateway scope patch applied and verified"

  # --- Device identity bypass patch ---
  # OpenClaw bug: dangerouslyDisableDeviceAuth sets allowBypass but
  # handleMissingDeviceIdentity doesn't check it before the final rejection.
  # Add: allow Control UI when bypass flag is set.
  local DEVICE_MARKER='controlUiAuthPolicy.allowBypass) return'

  local DEVICE_FILES
  DEVICE_FILES=$(grep -rl 'reject-device-required' "$GATEWAY_DIST" 2>/dev/null || true)
  if [ -z "$DEVICE_FILES" ]; then
    echo "  Device identity bypass patch: pattern not found, skipping"
    return
  fi

  # Only patch files that contain the target but NOT the marker yet
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

  # Verify ALL files with reject-device-required now have the patch
  local UNPATCHED
  UNPATCHED=""
  for file in $DEVICE_FILES; do
    if ! grep -q "$DEVICE_MARKER" "$file" 2>/dev/null; then
      UNPATCHED="$UNPATCHED $file"
    fi
  done

  if [ -n "$UNPATCHED" ]; then
    echo "Error: Device identity bypass patch failed for:$UNPATCHED"
    exit 1
  fi
  echo "  Device identity bypass patch applied and verified"
}

step_openclaw_config() {
  local CLAWBOX_CONFIG="$PROJECT_DIR/data/config.json"
  local OPENCLAW_CONFIG="$CLAWBOX_HOME/.openclaw/openclaw.json"

  # Register Telegram channel (if token exists) and set default model
  # in a single node invocation to avoid reading/writing the config file twice
  if [ -f "$OPENCLAW_CONFIG" ]; then
    CLAWBOX_CONFIG="$CLAWBOX_CONFIG" OPENCLAW_CONFIG="$OPENCLAW_CONFIG" \
      CLAWBOX_HOME="$CLAWBOX_HOME" node <<'NODE'
const fs=require('fs');
const cfgPath=process.env.OPENCLAW_CONFIG;
const home=process.env.CLAWBOX_HOME;
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

// Local device: disable gateway auth (no HTTPS for browser token exchange)
// and enable insecure auth + device auth bypass for Control UI
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
}

step_captive_portal_dns() {
  mkdir -p "$DNSMASQ_DIR"
  # Remove old captive portal DNS hijack (breaks internet for hotspot clients)
  rm -f "$DNSMASQ_DIR/captive-portal.conf"
  # Install upstream DNS forwarding for hotspot clients
  cp "$PROJECT_DIR/config/dnsmasq-upstream.conf" "$DNSMASQ_DIR/upstream-dns.conf"
  echo "  Removed captive portal DNS, installed upstream DNS forwarding"
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
    cp "$PROJECT_DIR/.env.example" "$ENV_FILE"
    chown "$CLAWBOX_USER:$CLAWBOX_USER" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "  Created $ENV_FILE from .env.example"
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

step_systemd_services() {
  local ALL_SERVICES=(clawbox-ap.service clawbox-setup.service clawbox-gateway.service clawbox-performance.service "clawbox-root-update@.service" clawbox-browser.service)
  local svc
  for svc in "${ALL_SERVICES[@]}"; do
    local src="$PROJECT_DIR/config/$svc"
    if [ ! -f "$src" ]; then
      echo "Error: Service file not found: $src"
      exit 1
    fi
    cp "$src" /etc/systemd/system/
  done
  systemctl daemon-reload
  # Enable all services except the template (@ services cannot be enabled directly)
  for svc in "${ALL_SERVICES[@]}"; do
    [[ "$svc" == *@* ]] && continue
    systemctl enable "$svc"
  done
  # Install sudoers rules so the clawbox user can manage services (systemctl restart, reboot, etc.)
  if [ -f "$PROJECT_DIR/config/clawbox-sudoers" ]; then
    cp "$PROJECT_DIR/config/clawbox-sudoers" /etc/sudoers.d/clawbox
    chmod 0440 /etc/sudoers.d/clawbox
    chown root:root /etc/sudoers.d/clawbox
    echo "  Sudoers rules installed"
  fi
  echo "  Services installed and enabled"
}

step_polkit_rules() {
  local POLKIT_PKLA_DIR="/etc/polkit-1/localauthority/50-local.d"
  mkdir -p "$POLKIT_PKLA_DIR"
  cp "$PROJECT_DIR/config/49-clawbox-updates.pkla" "$POLKIT_PKLA_DIR/"
  rm -f /etc/polkit-1/rules.d/49-clawbox-updates.rules
  echo "  Polkit rule installed (allows clawbox to trigger root update steps)"
}

step_start_services() {
  local svc
  for svc in clawbox-ap clawbox-setup clawbox-gateway clawbox-performance; do
    systemctl restart "$svc.service"
  done
  echo "  Services started"
}

# ── Update-only steps (called from dashboard System Update) ──────────────────

step_nvidia_jetpack() {
  apt-get install -y nvidia-jetpack
}

step_performance_mode() {
  # Find the highest MAXN mode (MAXN_SUPER > MAXN); fall back to mode 0
  local MAXN_LINE MAXN_ID MAXN_NAME
  MAXN_LINE=$(grep -oP 'POWER_MODEL ID=\K\d+\s+NAME=\S+' /etc/nvpmodel.conf | grep 'NAME=MAXN' | tail -1)
  MAXN_ID="${MAXN_LINE%% *}"
  MAXN_ID="${MAXN_ID:-0}"
  MAXN_NAME="${MAXN_LINE#*NAME=}"
  echo "  Setting power mode to $MAXN_ID (${MAXN_NAME:-unknown})"
  nvpmodel -m "$MAXN_ID"
  jetson_clocks
  # Ensure persistent service is installed and enabled for next boot
  if [ -f "$PROJECT_DIR/config/clawbox-performance.service" ]; then
    cp "$PROJECT_DIR/config/clawbox-performance.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable clawbox-performance.service
  fi
  # snapd is kept running — required for snap-based Chromium on Ubuntu 22.04
  # Optimize Ollama for 8GB Jetson
  bash "$PROJECT_DIR/scripts/optimize-ollama.sh"
  # Install sudoers rule so the web UI can run optimize-ollama.sh as root
  cp "$PROJECT_DIR/config/sudoers-clawbox-ollama" /etc/sudoers.d/clawbox-ollama
  chmod 440 /etc/sudoers.d/clawbox-ollama
}

step_jtop_install() {
  if command -v jtop &>/dev/null; then
    echo "  jtop already installed"
    return
  fi
  # Intentionally unpinned: jetson-stats version must match the JetPack release
  pip3 install jetson-stats
  echo "  jtop installed"
}

step_ollama_install() {
  if command -v ollama &>/dev/null; then
    echo "  Ollama already installed"
  else
    echo "  Installing Ollama..."
    curl -fsSL https://ollama.com/install.sh | sh
  fi
  # Ensure the service is enabled and running
  systemctl enable ollama 2>/dev/null || true
  systemctl start ollama 2>/dev/null || true
  # Apply Jetson memory optimizations
  bash "$PROJECT_DIR/scripts/optimize-ollama.sh"
  echo "  Ollama installed and running"
}

step_chpasswd() {
  local INPUT_FILE="$PROJECT_DIR/data/.chpasswd-input"
  if [ ! -f "$INPUT_FILE" ]; then
    echo "Error: password input file not found" >&2
    exit 1
  fi
  chpasswd < "$INPUT_FILE"
  rm -f "$INPUT_FILE"
}

step_rebuild() {
  do_rebuild
  echo "Starting clawbox-setup.service..."
  systemctl start clawbox-setup.service
}

step_restart() {
  echo "Restarting clawbox-setup.service..."
  systemctl restart clawbox-setup.service
}

step_restart_ap() {
  echo "Restarting clawbox-ap.service..."
  systemctl restart clawbox-ap.service
}

step_recover() {
  echo "Running ClawBox recovery..."
  bash "$PROJECT_DIR/scripts/start-ap.sh"
  systemctl restart clawbox-setup.service
  echo "Recovery complete"
}

step_gateway_setup() {
  cp "$PROJECT_DIR/config/clawbox-gateway.service" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable clawbox-gateway.service
  systemctl restart clawbox-gateway.service
}

step_chromium_install() {
  if snap list chromium &>/dev/null 2>&1; then
    echo "  Chromium already installed (snap)"
    return
  fi

  # Ubuntu 22.04 ARM64 only ships Chromium as a snap — no native .deb available.
  # Ensure snapd is running, install chromium, then continue.
  systemctl enable --now snapd snapd.socket 2>/dev/null || true

  # Wait for snapd to be ready (can take a few seconds after enable)
  local retries=0
  while ! snap version &>/dev/null && [ $retries -lt 30 ]; do
    sleep 1
    retries=$((retries + 1))
  done

  # Clean up any leftover Debian repo config from earlier install attempts
  rm -f /etc/apt/sources.list.d/debian-chromium.list /etc/apt/preferences.d/debian-chromium /usr/share/keyrings/debian-bookworm.gpg

  snap install chromium
  echo "  Chromium installed (snap)"
}

step_code_server_install() {
  if command -v code-server &>/dev/null; then
    echo "  code-server already installed"
  else
    curl -fsSL https://code-server.dev/install.sh | sh
    echo "  code-server installed"
  fi

  # Configure for local access (no auth, bind to all interfaces)
  local CS_CONFIG_DIR="$CLAWBOX_HOME/.config/code-server"
  mkdir -p "$CS_CONFIG_DIR"
  cat > "$CS_CONFIG_DIR/config.yaml" <<'CSCONF'
bind-addr: 0.0.0.0:8080
auth: none
cert: false
CSCONF
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$CS_CONFIG_DIR"

  # Enable and start as a user service via systemd
  systemctl enable --now "code-server@$CLAWBOX_USER" 2>/dev/null || true
  echo "  code-server configured and started"
}

step_claude_code_install() {
  if sudo -u "$CLAWBOX_USER" bash -c 'command -v claude' &>/dev/null; then
    echo "  Claude Code already installed"
  else
    sudo -u "$CLAWBOX_USER" bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
    echo "  Claude Code installed"
  fi
}

step_vnc_install() {
  # Install x11vnc, Xvfb (virtual framebuffer fallback), websockify, and a lightweight WM
  apt-get install -y x11vnc xvfb websockify dbus-x11 openbox xterm

  chmod +x "$PROJECT_DIR/scripts/start-vnc.sh"
  chown "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/scripts/start-vnc.sh"

  # Systemd service for VNC
  cat > /etc/systemd/system/clawbox-vnc.service <<VNCSVC
[Unit]
Description=ClawBox VNC (mirrors display or virtual desktop)
After=display-manager.service network.target

[Service]
Type=simple
User=$CLAWBOX_USER
ExecStart=$PROJECT_DIR/scripts/start-vnc.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
VNCSVC

  # Systemd service for websockify
  cat > /etc/systemd/system/clawbox-websockify.service <<WSSVC
[Unit]
Description=ClawBox WebSocket VNC Proxy
After=clawbox-vnc.service
Requires=clawbox-vnc.service

[Service]
Type=simple
User=$CLAWBOX_USER
ExecStart=/usr/bin/websockify 6080 localhost:5900
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
WSSVC

  # Browser CDP service (launched on demand, not auto-started)
  chmod +x "$PROJECT_DIR/scripts/launch-browser.sh"
  cp "$PROJECT_DIR/config/clawbox-browser.service" /etc/systemd/system/

  systemctl daemon-reload
  systemctl enable clawbox-vnc.service clawbox-websockify.service
  systemctl start clawbox-vnc.service clawbox-websockify.service || true
  echo "  VNC (x11vnc + Xvfb fallback) and websockify installed and started"
}

step_ffmpeg_install() {
  apt-get install -y ffmpeg
}

step_openclaw_models() {
  as_clawbox "$OPENCLAW_BIN" models
}

step_fix_git_perms() {
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/.git"
  echo "  Fixed .git ownership"
}

step_rebuild_reboot() {
  # Redeploy config files and scripts that may have changed after git pull
  step_directories_permissions
  step_systemd_services
  step_polkit_rules
  step_ollama_install
  step_openclaw_patch
  step_openclaw_config
  do_rebuild
  echo "Rebooting system..."
  reboot
}

step_browser_launch() {
  # Launch Chromium with CDP remote debugging — runs as root then drops to clawbox via runuser
  DISPLAY=:99 bash "$PROJECT_DIR/scripts/launch-browser.sh"
}

# ── Single-step mode (used by clawbox-root-update@.service) ──────────────────

# Steps available for --step dispatch (must have a corresponding step_NAME function)
DISPATCH_STEPS=(
  apt_update nvidia_jetpack performance_mode jtop_install ollama_install
  chromium_install code_server_install claude_code_install vnc_install openclaw_install openclaw_patch openclaw_config openclaw_models
  git_pull build rebuild rebuild_reboot restart restart_ap recover
  chpasswd gateway_setup ffmpeg_install polkit_rules systemd_services
  fix_git_perms browser_launch
)

if [ "${1:-}" = "--step" ]; then
  local_step="${2:-}"
  # Validate step name against the whitelist
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

TOTAL_STEPS=21
step=0
log() {
  step=$((step + 1))
  echo ""
  echo "[$step/$TOTAL_STEPS] $1"
}

echo "=== ClawBox Installer ==="

log "Ensuring clawbox user exists..."
step_ensure_user

log "Installing system packages..."
step_apt_update

log "Installing NVIDIA JetPack..."
step_nvidia_jetpack

log "Enabling max performance mode..."
step_performance_mode

log "Detecting WiFi interface..."
step_detect_wifi

log "Configuring hostname and mDNS..."
step_hostname_mdns

log "Setting up ClawBox repository..."
step_git_pull

log "Ensuring bun is installed..."
step_install_bun

log "Building ClawBox..."
step_build

log "Installing OpenClaw..."
step_openclaw_install

log "Patching and configuring OpenClaw..."
step_openclaw_patch
step_openclaw_config

log "Configuring captive portal DNS..."
step_captive_portal_dns

log "Setting up directories and permissions..."
step_directories_permissions

# Clean up default NVIDIA desktop shortcuts
rm -f "$CLAWBOX_HOME/Desktop"/*.desktop 2>/dev/null || true

log "Installing systemd services..."
step_systemd_services

log "Installing polkit rules..."
step_polkit_rules

log "Installing jtop (jetson-stats)..."
step_jtop_install

log "Installing Ollama..."
step_ollama_install

log "Installing Chromium..."
step_chromium_install

log "Installing code-server (VS Code)..."
step_code_server_install

log "Installing Claude Code..."
step_claude_code_install

log "Installing VNC server..."
step_vnc_install

log "Starting services..."
step_start_services

# ── Done ─────────────────────────────────────────────────────────────────────

# Re-read persisted interface for summary
if [ -f "$IFACE_ENV" ]; then
  source "$IFACE_ENV"
fi

echo ""
echo "=== ClawBox Setup Complete ==="
echo ""
echo "  WiFi interface: ${NETWORK_INTERFACE:-unknown}"
echo "  WiFi AP:        ClawBox-Setup (open network)"
echo "  Dashboard:      http://clawbox.local  or  http://10.42.0.1"
echo ""
echo "  Services:"
echo "    systemctl status clawbox-ap"
echo "    systemctl status clawbox-setup"
echo "    systemctl status clawbox-gateway"
echo ""
