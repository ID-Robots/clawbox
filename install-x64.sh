#!/usr/bin/env bash
# ClawBox x64 Desktop Installer
# Installs OpenClaw + ClawBox UI for desktop use.
#
# Root mode:
#   - installs missing system packages
#   - can write systemd units / sudoers for service-backed operation
#
# User mode:
#   - reuses existing system packages
#   - installs everything under the current user's home
#   - runs gateway/UI as background user processes
#
# Usage:
#   bash install-x64.sh
#   bash install-x64.sh --step NAME
#
# Environment variables:
#   CLAWBOX_REPO_URL      — git repo to clone (default: upstream GitHub repo)
#   CLAWBOX_BRANCH        — git branch to clone/checkout (default: main/current branch)
#   CLAWBOX_USER          — install as this user (default: current login user)
#   CLAWBOX_DIR           — target directory (default: <home>/clawbox)
#   CLAWBOX_PORT          — UI port (default: 3005)
#   OPENCLAW_PRIMARY_MODEL — optional OpenClaw primary model override
set -euo pipefail

RUN_AS_ROOT=0
if [ "$(id -u)" -eq 0 ]; then
  RUN_AS_ROOT=1
fi

DEFAULT_USER="${USER:-$(id -un)}"
if [ "$RUN_AS_ROOT" -eq 1 ]; then
  DEFAULT_USER="$(logname 2>/dev/null || echo "${SUDO_USER:-$DEFAULT_USER}")"
fi

CLAWBOX_USER="${CLAWBOX_USER:-$DEFAULT_USER}"
if [ "$RUN_AS_ROOT" -eq 0 ] && [ "$CLAWBOX_USER" != "${USER:-$(id -un)}" ]; then
  echo "Error: non-root installs must target the current user ('$USER'), not '$CLAWBOX_USER'" >&2
  exit 1
fi

CLAWBOX_HOME="$(getent passwd "$CLAWBOX_USER" | cut -d: -f6)"
if [ -z "${CLAWBOX_HOME:-}" ] && [ "$RUN_AS_ROOT" -eq 0 ]; then
  CLAWBOX_HOME="$HOME"
fi
if [ -z "${CLAWBOX_HOME:-}" ]; then
  echo "Error: cannot find home directory for user '$CLAWBOX_USER'" >&2
  exit 1
fi

REPO_URL="${CLAWBOX_REPO_URL:-https://github.com/ID-Robots/clawbox.git}"
REPO_BRANCH="${CLAWBOX_BRANCH:-main}"
PROJECT_DIR="${CLAWBOX_DIR:-$CLAWBOX_HOME/clawbox}"
PORT="${CLAWBOX_PORT:-3005}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$CLAWBOX_HOME/.openclaw}"
NPM_PREFIX="${NPM_PREFIX:-$CLAWBOX_HOME/.npm-global}"
HF_BIN="${HF_BIN:-$CLAWBOX_HOME/.local/bin/hf}"
USE_SYSTEMD=0
if [ "$RUN_AS_ROOT" -eq 1 ] && pidof systemd >/dev/null 2>&1; then
  USE_SYSTEMD=1
fi
GATEWAY_BIND="loopback"
if [ "$USE_SYSTEMD" -eq 1 ]; then
  GATEWAY_BIND="lan"
fi
DEPLOYMENT_MODE="${CLAWBOX_DEPLOYMENT_MODE:-${NODE_ENV:-development}}"
DEPLOYMENT_MODE="${DEPLOYMENT_MODE,,}"

if [ -x "$CLAWBOX_HOME/.bun/bin/bun" ]; then
  BUN="$CLAWBOX_HOME/.bun/bin/bun"
elif command -v bun >/dev/null 2>&1; then
  BUN="$(command -v bun)"
else
  BUN=""
fi

OPENCLAW_VERSION="2026.2.14"
OPENCLAW_BIN="$NPM_PREFIX/bin/openclaw"
GATEWAY_DIST="$NPM_PREFIX/lib/node_modules/openclaw/dist"
GATEWAY_LOG="/tmp/openclaw-gateway.log"
UI_LOG="/tmp/clawbox-ui.log"
ROOT_UPDATE_TEMPLATE="clawbox-root-update@.service"
SUDOERS_FILE="/etc/sudoers.d/clawbox-${CLAWBOX_USER}"
MIN_NODE_VERSION="22.19.0"

warn() {
  echo "  Warning: $*" >&2
}

print_node_requirement_error() {
  local found="${1:-missing}"
  echo "Error: ClawBox x64 requires Node.js ${MIN_NODE_VERSION}+ for OpenClaw compatibility." >&2
  echo "  Found: ${found}" >&2
  echo "  Reason: OpenClaw dependencies require a newer Node 22 release (for example undici >= 22.19)." >&2
}

maybe_chown() {
  if [ "$RUN_AS_ROOT" -eq 1 ]; then
    chown "$CLAWBOX_USER:$CLAWBOX_USER" "$@" 2>/dev/null || true
  fi
}

maybe_chown_recursive() {
  if [ "$RUN_AS_ROOT" -eq 1 ]; then
    chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$@" 2>/dev/null || true
  fi
}

runtime_env_export_snippet() {
  cat <<EOF
export HOME="$CLAWBOX_HOME"
export CLAWBOX_HOME="$CLAWBOX_HOME"
export CLAWBOX_ROOT="$PROJECT_DIR"
export OPENCLAW_HOME="$OPENCLAW_HOME"
export FILES_ROOT="$CLAWBOX_HOME"
export HF_BIN="$HF_BIN"
export CLAWBOX_INSTALL_MODE="x64"
export CLAWBOX_INSTALL_SCRIPT="$PROJECT_DIR/install-x64.sh"
export CLAWBOX_USE_SYSTEMD="$USE_SYSTEMD"
export CLAWBOX_GATEWAY_BIND="$GATEWAY_BIND"
export PATH="$CLAWBOX_HOME/.local/bin:$CLAWBOX_HOME/.bun/bin:$CLAWBOX_HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:\$PATH"
EOF
}

as_user() {
  if [ "$RUN_AS_ROOT" -eq 1 ] && [ "$(id -un)" != "$CLAWBOX_USER" ]; then
    sudo -u "$CLAWBOX_USER" "$@"
  else
    "$@"
  fi
}

as_user_login() {
  local cmd="$1"
  local env_snippet
  env_snippet="$(runtime_env_export_snippet)"
  if [ "$RUN_AS_ROOT" -eq 1 ] && [ "$(id -un)" != "$CLAWBOX_USER" ]; then
    sudo -iu "$CLAWBOX_USER" bash -lc "$env_snippet && $cmd"
  else
    HOME="$CLAWBOX_HOME" bash -lc "$env_snippet && $cmd"
  fi
}

upsert_env_setting() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  local tmp_file="${env_file}.tmp.$$"

  if [ -f "$env_file" ]; then
    awk -v key="$key" -v value="$value" '
      BEGIN { updated = 0 }
      index($0, key "=") == 1 {
        if (!updated) {
          print key "=" value
          updated = 1
        }
        next
      }
      { print }
      END {
        if (!updated) print key "=" value
      }
    ' "$env_file" > "$tmp_file"
  else
    printf '%s=%s\n' "$key" "$value" > "$tmp_file"
  fi

  mv "$tmp_file" "$env_file"
}

get_env_setting_or_default() {
  local env_file="$1"
  local key="$2"
  local default_value="$3"
  local current_value=""
  if [ -f "$env_file" ]; then
    current_value=$(grep "^${key}=" "$env_file" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  fi
  if [ -n "$current_value" ]; then
    printf '%s' "$current_value"
  else
    printf '%s' "$default_value"
  fi
}

has_playwright_chromium() {
  find "$CLAWBOX_HOME/.cache/ms-playwright" -type f \( -path "*/chrome-linux/chrome" -o -path "*/chrome-linux-arm64/chrome" \) -print -quit 2>/dev/null | grep -q .
}

ensure_playwright_chromium() {
  if has_playwright_chromium; then
    echo "  Playwright Chromium runtime already installed"
    return 0
  fi

  local playwright_bin="$PROJECT_DIR/node_modules/.bin/playwright"
  local playwright_path="$CLAWBOX_HOME/.cache/ms-playwright"

  echo "  Installing Playwright Chromium runtime..."
  if [ -x "$playwright_bin" ]; then
    as_user_login "cd \"$PROJECT_DIR\" && PLAYWRIGHT_BROWSERS_PATH=\"$playwright_path\" \"$playwright_bin\" install chromium"
  else
    as_user_login "cd \"$PROJECT_DIR\" && PLAYWRIGHT_BROWSERS_PATH=\"$playwright_path\" \"$BUN\" x playwright install chromium"
  fi

  if ! has_playwright_chromium; then
    echo "Error: Playwright Chromium install completed but no browser binary was found" >&2
    exit 1
  fi

  echo "  Playwright Chromium runtime ready"
}

wait_for_apt() {
  if [ "$RUN_AS_ROOT" -eq 0 ]; then
    return 0
  fi

  local waited=0
  while fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/cache/apt/archives/lock >/dev/null 2>&1; do
    if [ $waited -eq 0 ]; then
      echo "  Waiting for apt lock (another update is running)..."
    fi
    sleep 5
    waited=$((waited + 5))
    if [ $waited -ge 300 ]; then
      warn "apt lock held for 5+ minutes, continuing anyway"
      break
    fi
  done
}

get_node_version() {
  node --version 2>/dev/null | sed 's/^v//' | sed 's/[-+].*$//'
}

version_ge() {
  local current="$1"
  local minimum="$2"
  local current_major current_minor current_patch
  local minimum_major minimum_minor minimum_patch

  IFS=. read -r current_major current_minor current_patch <<< "$current"
  IFS=. read -r minimum_major minimum_minor minimum_patch <<< "$minimum"

  current_major="${current_major:-0}"
  current_minor="${current_minor:-0}"
  current_patch="${current_patch:-0}"
  minimum_major="${minimum_major:-0}"
  minimum_minor="${minimum_minor:-0}"
  minimum_patch="${minimum_patch:-0}"

  if [ "$current_major" -gt "$minimum_major" ]; then
    return 0
  fi
  if [ "$current_major" -lt "$minimum_major" ]; then
    return 1
  fi

  if [ "$current_minor" -gt "$minimum_minor" ]; then
    return 0
  fi
  if [ "$current_minor" -lt "$minimum_minor" ]; then
    return 1
  fi

  [ "$current_patch" -ge "$minimum_patch" ]
}

node_version_ok() {
  local current
  current="$(get_node_version)"
  [ -n "$current" ] && version_ge "$current" "$MIN_NODE_VERSION"
}

ensure_llamacpp_model_cached() {
  local env_file="$PROJECT_DIR/.env"
  local model_dir="$PROJECT_DIR/data/llamacpp/models"
  local hf_repo hf_file model_path

  hf_repo=$(get_env_setting_or_default "$env_file" "LLAMACPP_HF_REPO" "gguf-org/gemma-4-e2b-it-gguf")
  hf_file=$(get_env_setting_or_default "$env_file" "LLAMACPP_HF_FILE" "gemma-4-e2b-it-edited-q4_0.gguf")
  model_path="$model_dir/$hf_file"

  mkdir -p "$model_dir"
  maybe_chown_recursive "$PROJECT_DIR/data/llamacpp"

  if [ -f "$model_path" ]; then
    echo "  Gemma 4 model already cached for offline use"
    return 0
  fi

  if ! as_user_login "command -v hf >/dev/null 2>&1"; then
    warn "Hugging Face CLI is unavailable; skipping offline Gemma download"
    return 0
  fi

  echo "  Downloading Gemma 4 GGUF for offline use..."
  if ! as_user_login "mkdir -p \"$model_dir\" && hf download \"$hf_repo\" \"$hf_file\" --local-dir \"$model_dir\""; then
    warn "failed to download Gemma 4 for offline startup"
    return 0
  fi

  maybe_chown_recursive "$PROJECT_DIR/data/llamacpp"
  echo "  Gemma 4 model cached for offline startup"
}

install_systemd_units() {
  [ "$USE_SYSTEMD" -eq 1 ] || return 0

  cat > /etc/systemd/system/clawbox-setup.service <<EOF
[Unit]
Description=ClawBox Desktop UI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$CLAWBOX_USER
WorkingDirectory=$PROJECT_DIR
Environment=HOME=$CLAWBOX_HOME
Environment=CLAWBOX_HOME=$CLAWBOX_HOME
Environment=CLAWBOX_ROOT=$PROJECT_DIR
Environment=OPENCLAW_HOME=$OPENCLAW_HOME
Environment=FILES_ROOT=$CLAWBOX_HOME
Environment=HF_BIN=$HF_BIN
Environment=CLAWBOX_INSTALL_MODE=x64
Environment=CLAWBOX_INSTALL_SCRIPT=$PROJECT_DIR/install-x64.sh
Environment=CLAWBOX_USE_SYSTEMD=1
Environment=PORT=$PORT
Environment=HOSTNAME=0.0.0.0
Environment=NODE_ENV=production
Environment=BUN_ENV=production
Environment=PATH=$CLAWBOX_HOME/.local/bin:$CLAWBOX_HOME/.bun/bin:$CLAWBOX_HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-$PROJECT_DIR/.env
ExecStart=$BUN run production-server.js
Restart=always
RestartSec=3
StandardOutput=append:$UI_LOG
StandardError=append:$UI_LOG

[Install]
WantedBy=multi-user.target
EOF

  cat > /etc/systemd/system/clawbox-gateway.service <<EOF
[Unit]
Description=ClawBox OpenClaw Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$CLAWBOX_USER
WorkingDirectory=$CLAWBOX_HOME
Environment=HOME=$CLAWBOX_HOME
Environment=CLAWBOX_HOME=$CLAWBOX_HOME
Environment=CLAWBOX_ROOT=$PROJECT_DIR
Environment=OPENCLAW_HOME=$OPENCLAW_HOME
Environment=FILES_ROOT=$CLAWBOX_HOME
Environment=HF_BIN=$HF_BIN
Environment=CLAWBOX_INSTALL_MODE=x64
Environment=CLAWBOX_INSTALL_SCRIPT=$PROJECT_DIR/install-x64.sh
Environment=CLAWBOX_USE_SYSTEMD=1
Environment=CLAWBOX_GATEWAY_BIND=lan
Environment=NODE_ENV=production
Environment=BUN_ENV=production
Environment=PATH=$CLAWBOX_HOME/.local/bin:$CLAWBOX_HOME/.bun/bin:$CLAWBOX_HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-$PROJECT_DIR/.env
ExecStartPre=$PROJECT_DIR/scripts/gateway-pre-start.sh
ExecStart=$OPENCLAW_BIN gateway --allow-unconfigured --bind lan --token clawbox
Restart=always
RestartSec=5
StandardOutput=append:$GATEWAY_LOG
StandardError=append:$GATEWAY_LOG

[Install]
WantedBy=multi-user.target
EOF

  cat > /etc/systemd/system/$ROOT_UPDATE_TEMPLATE <<EOF
[Unit]
Description=ClawBox x64 Root Update Step (%i)

[Service]
Type=oneshot
Environment=CLAWBOX_HOME=$CLAWBOX_HOME
Environment=CLAWBOX_ROOT=$PROJECT_DIR
Environment=OPENCLAW_HOME=$OPENCLAW_HOME
Environment=FILES_ROOT=$CLAWBOX_HOME
Environment=HF_BIN=$HF_BIN
Environment=CLAWBOX_INSTALL_MODE=x64
Environment=CLAWBOX_INSTALL_SCRIPT=$PROJECT_DIR/install-x64.sh
Environment=CLAWBOX_USE_SYSTEMD=0
ExecStart=/bin/bash $PROJECT_DIR/install-x64.sh --step %i
TimeoutStartSec=1800
EOF

  systemctl daemon-reload
  systemctl enable clawbox-setup.service clawbox-gateway.service
}

install_sudoers_rules() {
  [ "$USE_SYSTEMD" -eq 1 ] || return 0

  local tmp_file="${SUDOERS_FILE}.tmp"
  cat > "$tmp_file" <<EOF
$CLAWBOX_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart clawbox-gateway.service
$CLAWBOX_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start clawbox-gateway.service
$CLAWBOX_USER ALL=(root) NOPASSWD: /usr/bin/systemctl stop clawbox-gateway.service
$CLAWBOX_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start clawbox-setup.service
$CLAWBOX_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart clawbox-setup.service
$CLAWBOX_USER ALL=(root) NOPASSWD: /usr/bin/systemctl stop clawbox-setup.service
$CLAWBOX_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start clawbox-root-update@*.service
$CLAWBOX_USER ALL=(root) NOPASSWD: /usr/bin/systemctl reset-failed clawbox-root-update@*.service
$CLAWBOX_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start ollama
$CLAWBOX_USER ALL=(root) NOPASSWD: /usr/bin/systemctl stop ollama
$CLAWBOX_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart ollama
$CLAWBOX_USER ALL=(root) NOPASSWD: /usr/bin/systemctl reboot
EOF

  if ! command -v visudo >/dev/null 2>&1; then
    rm -f "$tmp_file"
    echo "Error: visudo is required to validate sudoers rules before install" >&2
    return 1
  fi

  if ! visudo -c -f "$tmp_file" >/dev/null; then
    rm -f "$tmp_file"
    echo "Error: generated sudoers rules failed validation; refusing to replace $SUDOERS_FILE" >&2
    return 1
  fi

  chmod 440 "$tmp_file"
  mv "$tmp_file" "$SUDOERS_FILE"
  chmod 440 "$SUDOERS_FILE"
}

step_apt_update() {
  if [ "$RUN_AS_ROOT" -eq 0 ]; then
    local required=(git curl python3 node npm make gcc)
    local missing=()
    local optional_missing=()
    local optional=(cmake ninja ffmpeg x11vnc websockify)

    for cmd in "${required[@]}"; do
      command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
    done
    if [ ${#missing[@]} -gt 0 ]; then
      echo "Error: non-root install requires existing commands: ${missing[*]}" >&2
      exit 1
    fi

    if ! node_version_ok; then
      print_node_requirement_error "$(node --version 2>/dev/null || echo missing)"
      exit 1
    fi

    for cmd in "${optional[@]}"; do
      command -v "$cmd" >/dev/null 2>&1 || optional_missing+=("$cmd")
    done
    if [ ${#optional_missing[@]} -gt 0 ]; then
      warn "optional desktop/runtime tools are missing: ${optional_missing[*]}"
    fi

    echo "  Reusing existing system packages"
    return 0
  fi

  wait_for_apt
  apt-get update -qq
  apt-get install -y -qq git curl python3 python3-pip build-essential cmake ninja-build ffmpeg

  if node_version_ok; then
    echo "  Node.js $(node --version) already installed"
  else
    echo "  Installing Node.js 22 (minimum ${MIN_NODE_VERSION})..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs
    if ! node_version_ok; then
      print_node_requirement_error "$(node --version 2>/dev/null || echo missing)"
      exit 1
    fi
    echo "  Node.js $(node --version) installed"
  fi
}

step_install_bun() {
  if [ -n "$BUN" ] && [ -x "$BUN" ]; then
    echo "  Bun already installed at $BUN"
    return 0
  fi

  echo "  Installing bun..."
  as_user_login "curl -fsSL https://bun.sh/install | bash"
  BUN="$CLAWBOX_HOME/.bun/bin/bun"
}

step_git_pull() {
  if [ ! -d "$PROJECT_DIR/.git" ]; then
    echo "  Cloning from $REPO_URL (branch: $REPO_BRANCH)..."
    as_user git clone --branch "$REPO_BRANCH" "$REPO_URL" "$PROJECT_DIR"
    maybe_chown_recursive "$PROJECT_DIR"
    return 0
  fi

  local current_branch
  current_branch=$(git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" branch --show-current)
  local target_branch="${CLAWBOX_BRANCH:-$current_branch}"
  echo "  Repository exists, updating branch '$target_branch'..."

  as_user git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" fetch origin
  if [ "$target_branch" != "$current_branch" ]; then
    if ! as_user git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" checkout "$target_branch" 2>/dev/null; then
      as_user git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" checkout -b "$target_branch" "origin/$target_branch"
    fi
  fi
  as_user git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" merge --ff-only "origin/$target_branch" || warn "git merge failed; continuing with current code"
}

step_build() {
  as_user_login "cd \"$PROJECT_DIR\" && \"$BUN\" install"
  if ! as_user_login "cd \"$PROJECT_DIR\" && node -e \"require('node-pty')\"" >/dev/null 2>&1; then
    echo "  Rebuilding native modules (node-pty)..."
    as_user_login "cd \"$PROJECT_DIR\" && npm rebuild node-pty"
  fi
  as_user_login "cd \"$PROJECT_DIR\" && \"$BUN\" run build"
  if [ ! -f "$PROJECT_DIR/.next/standalone/server.js" ]; then
    echo "Error: build failed — .next/standalone/server.js not found" >&2
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
  local latest target installed
  latest=$("$BUN" pm view openclaw version 2>/dev/null || npm view openclaw version --registry https://registry.npmjs.org 2>/dev/null || echo "")
  target="${latest:-$OPENCLAW_VERSION}"

  if [ -x "$OPENCLAW_BIN" ]; then
    installed=$("$OPENCLAW_BIN" --version 2>/dev/null || echo "unknown")
    echo "  Installed: $installed, Target: $target"
    if [ "$installed" = "$target" ]; then
      echo "  OpenClaw is already up to date"
      return 0
    fi
  fi

  mkdir -p "$NPM_PREFIX"
  maybe_chown_recursive "$NPM_PREFIX" "$CLAWBOX_HOME/.npm"

  if ! as_user_login "npm install -g \"openclaw@$target\" --prefix \"$NPM_PREFIX\""; then
    warn "OpenClaw install failed"
    return 0
  fi

  local bashrc="$CLAWBOX_HOME/.bashrc"
  if ! grep -q 'npm-global/bin' "$bashrc" 2>/dev/null; then
    cat >> "$bashrc" <<'EOF'

# npm global binaries (openclaw)
export PATH="$HOME/.npm-global/bin:$PATH"
EOF
    maybe_chown "$bashrc"
  fi

  echo "  OpenClaw installed: $("$OPENCLAW_BIN" --version 2>/dev/null || echo 'unknown version')"
}

step_openclaw_patch() {
  if [ ! -x "$OPENCLAW_BIN" ]; then
    warn "OpenClaw is not installed; skipping patch"
    return 0
  fi

  as_user "$OPENCLAW_BIN" config set gateway.controlUi.allowInsecureAuth true --json >/dev/null 2>&1 || true

  local patched_marker='isControlUi && allowControlUiBypass'
  if grep -qrl --include='*.js' "$patched_marker" "$GATEWAY_DIST" 2>/dev/null; then
    echo "  Gateway scope patch already applied"
  else
    local scope_files
    scope_files=$(grep -Prl --include='*.js' 'if\s*\(\s*scopes\.length\s*>\s*0\s*\)\s*\{' "$GATEWAY_DIST" 2>/dev/null || true)
    for file in $scope_files; do
      sed -i -E 's/if[[:space:]]*\([[:space:]]*scopes\.length[[:space:]]*>[[:space:]]*0[[:space:]]*\)[[:space:]]*\{/if (scopes.length > 0 \&\& !(isControlUi \&\& allowControlUiBypass)) {/g' "$file"
    done
    if grep -qrl --include='*.js' "$patched_marker" "$GATEWAY_DIST" 2>/dev/null; then
      echo "  Gateway scope patch applied"
    else
      warn "Gateway scope patch verification failed"
    fi
  fi

  local device_marker='controlUiAuthPolicy.allowBypass) return'
  local device_files
  device_files=$(grep -rl --include='*.js' 'reject-device-required' "$GATEWAY_DIST" 2>/dev/null || true)
  for file in $device_files; do
    if ! grep -q "$device_marker" "$file" 2>/dev/null; then
      sed -i 's|if (roleCanSkipDeviceIdentity(params.role, params.sharedAuthOk)) return { kind: "allow" };|if (roleCanSkipDeviceIdentity(params.role, params.sharedAuthOk)) return { kind: "allow" };\n\tif (params.isControlUi \&\& params.controlUiAuthPolicy.allowBypass) return { kind: "allow" };|' "$file"
    fi
  done
}

step_openclaw_config() {
  if [ ! -x "$OPENCLAW_BIN" ]; then
    warn "OpenClaw is not installed; skipping config"
    return 0
  fi

  as_user "$OPENCLAW_BIN" config set gateway.auth.mode token >/dev/null 2>&1 || true
  as_user "$OPENCLAW_BIN" config set gateway.auth.token clawbox >/dev/null 2>&1 || true
  as_user "$OPENCLAW_BIN" config set gateway.controlUi.allowInsecureAuth true --json >/dev/null 2>&1 || true
  as_user "$OPENCLAW_BIN" config set gateway.controlUi.dangerouslyDisableDeviceAuth true --json >/dev/null 2>&1 || true
  as_user "$OPENCLAW_BIN" config set gateway.controlUi.allowedOrigins '["http://clawbox.local","http://localhost","http://127.0.0.1"]' --json >/dev/null 2>&1 || true

  local clawbox_config="$PROJECT_DIR/data/config.json"
  local openclaw_config="$OPENCLAW_HOME/openclaw.json"
  local openclaw_primary_model="${OPENCLAW_PRIMARY_MODEL:-$(get_env_setting_or_default "$PROJECT_DIR/.env" "OPENCLAW_PRIMARY_MODEL" "")}"
  if [ -f "$openclaw_config" ]; then
    CLAWBOX_CONFIG="$clawbox_config" OPENCLAW_CONFIG="$openclaw_config" CLAWBOX_HOME="$CLAWBOX_HOME" OPENCLAW_PRIMARY_MODEL="$openclaw_primary_model" node <<'NODE'
const fs = require("fs");
const path = require("path");
const cfgPath = process.env.OPENCLAW_CONFIG;
const c = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

try {
  const cb = JSON.parse(fs.readFileSync(process.env.CLAWBOX_CONFIG, "utf8"));
  if (cb.telegram_bot_token) {
    c.channels ??= {};
    c.channels.telegram = {
      ...c.channels.telegram,
      enabled: true,
      botToken: cb.telegram_bot_token,
      dmPolicy: "open",
      allowFrom: ["*"],
    };
    process.stderr.write("  Telegram channel registered in OpenClaw config\n");
  }
} catch {}

c.agents ??= {};
c.agents.defaults ??= {};
c.agents.defaults.model ??= {};
c.agents.defaults.workspace = path.join(process.env.CLAWBOX_HOME, ".openclaw", "workspace");
if (process.env.OPENCLAW_PRIMARY_MODEL && process.env.OPENCLAW_PRIMARY_MODEL.trim()) {
  c.agents.defaults.model.primary = process.env.OPENCLAW_PRIMARY_MODEL.trim();
}
c.agents.defaults.compaction ??= {};
c.agents.defaults.compaction.reserveTokensFloor = 24000;

c.gateway ??= {};
c.gateway.auth ??= {};
c.gateway.auth.mode = "token";
c.gateway.auth.token = "clawbox";
c.gateway.controlUi ??= {};
c.gateway.controlUi.allowInsecureAuth = true;
c.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
c.gateway.controlUi.allowedOrigins = ["http://clawbox.local", "http://localhost", "http://127.0.0.1"];

fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2));
NODE
    echo "  OpenClaw config updated"
  fi

  maybe_chown_recursive "$OPENCLAW_HOME"

  local clawhub_bin="$NPM_PREFIX/bin/clawhub"
  if [ ! -x "$clawhub_bin" ]; then
    as_user_login "npm install -g clawhub --prefix \"$NPM_PREFIX\"" >/dev/null 2>&1 || warn "ClawHub CLI install failed"
  fi
}

step_directories_permissions() {
  mkdir -p "$PROJECT_DIR/data" "$OPENCLAW_HOME" "$CLAWBOX_HOME/.local/bin"
  maybe_chown_recursive "$PROJECT_DIR/data" "$OPENCLAW_HOME" "$CLAWBOX_HOME/.local"
  if [ -d "$PROJECT_DIR/scripts" ]; then
    find "$PROJECT_DIR/scripts" -name "*.sh" -exec chmod +x {} +
  fi

  local env_file="$PROJECT_DIR/.env"
  local default_llama_bin="/usr/local/bin/llama-server"
  if [ "$RUN_AS_ROOT" -eq 0 ]; then
    default_llama_bin="$CLAWBOX_HOME/.local/bin/llama-server"
  fi

  if [ ! -f "$env_file" ]; then
    if [ -f "$PROJECT_DIR/.env.example" ]; then
      cp "$PROJECT_DIR/.env.example" "$env_file"
    else
      touch "$env_file"
    fi
    chmod 600 "$env_file"
    maybe_chown "$env_file"
    echo "  Created $env_file"
  fi

  # Development and production OAuth credentials must be supplied via the
  # environment or the generated .env file; this installer no longer embeds
  # Google OAuth secrets. Production deployments must provide
  # GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET via env vars or a
  # secure secret store before invoking the installer.
  local g_cid="${GOOGLE_OAUTH_CLIENT_ID:-$(get_env_setting_or_default "$env_file" "GOOGLE_OAUTH_CLIENT_ID" "")}"
  local g_sec="${GOOGLE_OAUTH_CLIENT_SECRET:-$(get_env_setting_or_default "$env_file" "GOOGLE_OAUTH_CLIENT_SECRET" "")}"

  if [ -z "$g_cid" ] || [ -z "$g_sec" ]; then
    echo "Error: GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set via environment or $env_file before running install-x64.sh" >&2
    if [ "$DEPLOYMENT_MODE" = "production" ]; then
      echo "  Production deployments must source these values from env vars or a secure secret store." >&2
    fi
    return 1
  fi

  upsert_env_setting "$env_file" "GOOGLE_OAUTH_CLIENT_ID" "$g_cid"
  upsert_env_setting "$env_file" "GOOGLE_OAUTH_CLIENT_SECRET" "$g_sec"
  upsert_env_setting "$env_file" "CLAWBOX_HOME" "$CLAWBOX_HOME"
  upsert_env_setting "$env_file" "CLAWBOX_ROOT" "$PROJECT_DIR"
  upsert_env_setting "$env_file" "OPENCLAW_HOME" "$OPENCLAW_HOME"
  upsert_env_setting "$env_file" "FILES_ROOT" "$CLAWBOX_HOME"
  upsert_env_setting "$env_file" "HF_BIN" "$HF_BIN"
  upsert_env_setting "$env_file" "CLAWBOX_INSTALL_MODE" "x64"
  upsert_env_setting "$env_file" "CLAWBOX_INSTALL_SCRIPT" "$PROJECT_DIR/install-x64.sh"
  upsert_env_setting "$env_file" "CLAWBOX_USE_SYSTEMD" "$USE_SYSTEMD"
  upsert_env_setting "$env_file" "CLAWBOX_GATEWAY_BIND" "$GATEWAY_BIND"
  upsert_env_setting "$env_file" "LLAMACPP_BASE_URL" "http://127.0.0.1:8080/v1"
  upsert_env_setting "$env_file" "LLAMACPP_MODEL" "gemma4-e2b-it-q4_0"
  upsert_env_setting "$env_file" "LLAMACPP_HF_REPO" "gguf-org/gemma-4-e2b-it-gguf"
  upsert_env_setting "$env_file" "LLAMACPP_HF_FILE" "gemma-4-e2b-it-edited-q4_0.gguf"
  upsert_env_setting "$env_file" "LLAMACPP_BIN" "$default_llama_bin"
  upsert_env_setting "$env_file" "LLAMACPP_CONTEXT_WINDOW" "32768"
  upsert_env_setting "$env_file" "LLAMACPP_CACHE_TYPE_K" "q4_0"
  upsert_env_setting "$env_file" "LLAMACPP_CACHE_TYPE_V" "q4_0"
  upsert_env_setting "$env_file" "LLAMACPP_MAX_TOKENS" "8192"
}

step_ollama_install() {
  if command -v ollama >/dev/null 2>&1; then
    echo "  Ollama already installed"
    if [ "$RUN_AS_ROOT" -eq 1 ] && [ "$USE_SYSTEMD" -eq 1 ]; then
      systemctl enable ollama >/dev/null 2>&1 || true
      systemctl start ollama >/dev/null 2>&1 || true
    fi
    return 0
  fi

  if [ "$RUN_AS_ROOT" -eq 0 ]; then
    warn "Ollama is not installed and cannot be added without root access; skipping"
    return 0
  fi

  echo "  Installing Ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
  if [ "$USE_SYSTEMD" -eq 1 ]; then
    systemctl enable ollama >/dev/null 2>&1 || true
    systemctl start ollama >/dev/null 2>&1 || true
  fi
}

step_llamacpp_install() {
  local env_file="$PROJECT_DIR/.env"
  local llama_dir="$CLAWBOX_HOME/llama.cpp"
  local llama_bin
  local cmake_args="-DCMAKE_BUILD_TYPE=Release"

  llama_bin=$(get_env_setting_or_default "$env_file" "LLAMACPP_BIN" "$([ "$RUN_AS_ROOT" -eq 1 ] && echo /usr/local/bin/llama-server || echo "$CLAWBOX_HOME/.local/bin/llama-server")")

  if command -v nvcc >/dev/null 2>&1; then
    cmake_args="$cmake_args -DGGML_CUDA=ON"
  fi

  if ! as_user_login "command -v hf >/dev/null 2>&1"; then
    echo "  Installing Hugging Face CLI..."
    if ! as_user_login "python3 -m pip install --user --break-system-packages --upgrade 'huggingface_hub[cli]'"; then
      warn "failed to install Hugging Face CLI; skipping llama.cpp provisioning"
      return 0
    fi
  fi

  if [ -x "$llama_bin" ]; then
    echo "  llama-server already installed at $llama_bin"
    ensure_llamacpp_model_cached
    return 0
  fi

  if ! command -v cmake >/dev/null 2>&1 || ! command -v ninja >/dev/null 2>&1; then
    if [ "$RUN_AS_ROOT" -eq 0 ]; then
      warn "cmake/ninja are missing; skipping llama.cpp build in user mode"
      return 0
    fi
    wait_for_apt
    apt-get update -qq
    apt-get install -y -qq cmake ninja-build pkg-config
  fi

  echo "  Building llama.cpp server..."
  if [ ! -d "$llama_dir/.git" ]; then
    as_user git clone --depth 1 https://github.com/ggml-org/llama.cpp.git "$llama_dir"
  fi

  if ! as_user_login "rm -f \"$llama_dir/build/CMakeCache.txt\" && rm -rf \"$llama_dir/build/CMakeFiles\" && cd \"$llama_dir\" && cmake -S . -B build $cmake_args"; then
    echo "Error: llama.cpp configure step failed; installer cannot continue with local backend provisioning" >&2
    return 1
  fi
  if ! as_user_login "cd \"$llama_dir\" && cmake --build build --config Release -j$(nproc) --target llama-server"; then
    echo "Error: llama.cpp build step failed; installer cannot continue with local backend provisioning" >&2
    return 1
  fi

  if [ "$RUN_AS_ROOT" -eq 1 ]; then
    install -m 755 "$llama_dir/build/bin/llama-server" "$llama_bin"
  else
    mkdir -p "$(dirname "$llama_bin")"
    cp "$llama_dir/build/bin/llama-server" "$llama_bin"
    chmod 755 "$llama_bin"
  fi

  ensure_llamacpp_model_cached
}

step_chromium_install() {
  if command -v chromium-browser >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1 || command -v google-chrome >/dev/null 2>&1; then
    echo "  Chromium/Chrome already installed"
  elif [ "$RUN_AS_ROOT" -eq 1 ]; then
    if command -v snap >/dev/null 2>&1; then
      snap list chromium >/dev/null 2>&1 || snap install chromium >/dev/null 2>&1 || true
    fi
    if ! command -v chromium-browser >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1 && ! command -v google-chrome >/dev/null 2>&1; then
      wait_for_apt
      apt-get install -y -qq chromium-browser >/dev/null 2>&1 || apt-get install -y -qq chromium >/dev/null 2>&1 || warn "Could not install Chromium"
    fi
  else
    warn "No Chromium/Chrome binary detected; relying on Playwright browser download only"
  fi

  ensure_playwright_chromium
}

step_ai_tools_install() {
  if as_user_login "command -v claude >/dev/null 2>&1"; then
    echo "  Claude Code already installed"
  else
    as_user_login "curl -fsSL https://claude.ai/install.sh | bash" >/dev/null 2>&1 || warn "Claude Code install failed"
  fi

  if as_user_login "command -v codex >/dev/null 2>&1"; then
    echo "  OpenAI Codex already installed"
  else
    as_user_login "npm i -g @openai/codex --prefix \"$NPM_PREFIX\"" >/dev/null 2>&1 || warn "Codex install failed"
  fi

  if as_user_login "command -v gemini >/dev/null 2>&1"; then
    echo "  Gemini CLI already installed"
  else
    as_user_login "npm i -g @google/gemini-cli --prefix \"$NPM_PREFIX\"" >/dev/null 2>&1 || warn "Gemini CLI install failed"
  fi
}

step_vnc_install() {
  if [ "$RUN_AS_ROOT" -eq 0 ]; then
    warn "Skipping VNC package install in user mode"
    return 0
  fi

  apt-get install -y -qq x11vnc xvfb websockify dbus-x11 openbox xterm x11-xserver-utils
  chmod +x "$PROJECT_DIR/scripts/start-vnc.sh"
  maybe_chown "$PROJECT_DIR/scripts/start-vnc.sh"
}

step_ffmpeg_install() {
  if command -v ffmpeg >/dev/null 2>&1; then
    echo "  ffmpeg already installed"
    return 0
  fi

  if [ "$RUN_AS_ROOT" -eq 0 ]; then
    warn "Skipping ffmpeg install in user mode"
    return 0
  fi

  wait_for_apt
  apt-get install -y -qq ffmpeg
}

step_systemd_services() {
  if [ "$USE_SYSTEMD" -eq 1 ]; then
    install_systemd_units
    echo "  Installed systemd services"
  else
    echo "  Skipping systemd services in user mode"
  fi
}

step_sudoers_setup() {
  if [ "$USE_SYSTEMD" -eq 1 ]; then
    install_sudoers_rules
    echo "  Installed sudoers rules for $CLAWBOX_USER"
  else
    echo "  Skipping sudoers setup in user mode"
  fi
}

step_fix_git_perms() {
  if [ "$RUN_AS_ROOT" -eq 1 ]; then
    chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/.git"
    echo "  Fixed .git ownership"
  else
    echo "  .git already owned by $CLAWBOX_USER"
  fi
}

step_start_gateway() {
  if [ ! -x "$OPENCLAW_BIN" ]; then
    warn "OpenClaw is not installed; skipping gateway start"
    return 0
  fi

  if [ "$USE_SYSTEMD" -eq 1 ]; then
    systemctl restart clawbox-gateway.service
  else
    as_user_login "cd \"$PROJECT_DIR\" && \"$PROJECT_DIR/scripts/gateway-pre-start.sh\" >/dev/null 2>&1 || true"
    as_user_login "fuser -k 18789/tcp >/dev/null 2>&1 || true; setsid -f env CLAWBOX_HOME=\"$CLAWBOX_HOME\" CLAWBOX_ROOT=\"$PROJECT_DIR\" OPENCLAW_HOME=\"$OPENCLAW_HOME\" FILES_ROOT=\"$CLAWBOX_HOME\" HF_BIN=\"$HF_BIN\" CLAWBOX_INSTALL_MODE=x64 CLAWBOX_INSTALL_SCRIPT=\"$PROJECT_DIR/install-x64.sh\" CLAWBOX_USE_SYSTEMD=0 CLAWBOX_GATEWAY_BIND=\"$GATEWAY_BIND\" \"$OPENCLAW_BIN\" gateway --allow-unconfigured --bind \"$GATEWAY_BIND\" </dev/null >> \"$GATEWAY_LOG\" 2>&1"
  fi

  sleep 3
  if curl -s "http://127.0.0.1:18789" >/dev/null 2>&1; then
    echo "  OpenClaw gateway running on port 18789"
  else
    warn "Gateway may still be starting; check $GATEWAY_LOG"
  fi
}

step_start_ui() {
  if [ "$USE_SYSTEMD" -eq 1 ]; then
    systemctl restart clawbox-setup.service
  else
    as_user_login "fuser -k \"$PORT\"/tcp >/dev/null 2>&1 || true; cd \"$PROJECT_DIR\" && setsid -f env CLAWBOX_HOME=\"$CLAWBOX_HOME\" CLAWBOX_ROOT=\"$PROJECT_DIR\" OPENCLAW_HOME=\"$OPENCLAW_HOME\" FILES_ROOT=\"$CLAWBOX_HOME\" HF_BIN=\"$HF_BIN\" CLAWBOX_INSTALL_MODE=x64 CLAWBOX_INSTALL_SCRIPT=\"$PROJECT_DIR/install-x64.sh\" CLAWBOX_USE_SYSTEMD=0 PORT=\"$PORT\" HOSTNAME=0.0.0.0 \"$BUN\" run production-server.js </dev/null >> \"$UI_LOG\" 2>&1"
  fi

  sleep 3
  if curl -s "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
    echo "  ClawBox UI running on port $PORT"
  else
    warn "UI may still be starting; check $UI_LOG"
  fi
}

DISPATCH_STEPS=(
  apt_update install_bun git_pull build
  openclaw_setup openclaw_install openclaw_patch openclaw_config
  directories_permissions ollama_install llamacpp_install chromium_install ai_tools_install
  vnc_install ffmpeg_install systemd_services sudoers_setup fix_git_perms
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

TOTAL_STEPS=16
step=0
log() {
  step=$((step + 1))
  echo ""
  echo "[$step/$TOTAL_STEPS] $1"
}

echo "=== ClawBox x64 Desktop Installer ==="
echo "  Mode: $([ "$RUN_AS_ROOT" -eq 1 ] && echo root || echo user)"
echo "  User: $CLAWBOX_USER"
echo "  Project: $PROJECT_DIR"
echo "  Port: $PORT"
echo ""

log "Checking / installing base packages..."
step_apt_update

log "Ensuring bun is installed..."
step_install_bun

log "Setting up ClawBox repository..."
step_git_pull

log "Preparing directories and runtime env..."
step_directories_permissions

log "Building ClawBox..."
step_build

log "Installing and configuring OpenClaw..."
step_openclaw_setup

log "Installing Ollama..."
step_ollama_install

log "Installing llama.cpp runtime..."
step_llamacpp_install

log "Installing Chromium runtime..."
step_chromium_install

log "Installing AI coding tools..."
step_ai_tools_install

log "Installing VNC dependencies..."
step_vnc_install

log "Installing ffmpeg..."
step_ffmpeg_install

log "Configuring systemd services..."
step_systemd_services

log "Configuring sudoers access..."
step_sudoers_setup

log "Starting OpenClaw gateway..."
step_start_gateway

log "Starting ClawBox UI..."
step_start_ui

LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "=== ClawBox x64 Setup Complete ==="
echo ""
echo "  Dashboard:    http://${LOCAL_IP:-127.0.0.1}:${PORT}"
echo "  Dashboard:    http://clawbox.local:${PORT}"
echo "  OpenClaw:     http://${LOCAL_IP:-127.0.0.1}:18789"
echo "  UI Logs:      $UI_LOG"
echo "  Gateway Logs: $GATEWAY_LOG"
echo ""
echo "  To stop UI:      fuser -k ${PORT}/tcp"
echo "  To stop gateway: fuser -k 18789/tcp"
echo ""
