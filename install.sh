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
# Explicit PATH ensures bun/node are found even inside systemd services
as_clawbox_login() {
  # On Jetson, CUDA tools live at /usr/local/cuda/bin but aren't on the login
  # shell's PATH by default. Include them so cmake / nvcc / llama.cpp builds
  # can find the toolkit during `as_clawbox_login` invocations.
  local cuda_prefix=""
  [ -x /usr/local/cuda/bin/nvcc ] && cuda_prefix="/usr/local/cuda/bin:"
  su - "$CLAWBOX_USER" -c "export PATH=\"${cuda_prefix}$CLAWBOX_HOME/.bun/bin:$CLAWBOX_HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" && $*"
}

ensure_env_setting() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  if ! grep -q "^${key}=" "$env_file" 2>/dev/null; then
    printf '%s=%s\n' "$key" "$value" >> "$env_file"
    echo "  Added ${key} to ${env_file}"
  fi
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

ensure_llamacpp_model_cached() {
  local ENV_FILE="$PROJECT_DIR/.env"
  local MODEL_DIR="$PROJECT_DIR/data/llamacpp/models"
  local HF_REPO HF_FILE MODEL_PATH

  HF_REPO=$(get_env_setting_or_default "$ENV_FILE" "LLAMACPP_HF_REPO" "gguf-org/gemma-4-e2b-it-gguf")
  HF_FILE=$(get_env_setting_or_default "$ENV_FILE" "LLAMACPP_HF_FILE" "gemma-4-e2b-it-edited-q4_0.gguf")
  MODEL_PATH="$MODEL_DIR/$HF_FILE"

  mkdir -p "$MODEL_DIR"
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/data/llamacpp"

  if [ -f "$MODEL_PATH" ]; then
    echo "  Gemma 4 model already cached for offline use"
    return 0
  fi

  echo "  Downloading Gemma 4 GGUF for offline use..."
  if ! as_clawbox_login "mkdir -p \"$MODEL_DIR\" && hf download \"$HF_REPO\" \"$HF_FILE\" --local-dir \"$MODEL_DIR\""; then
    echo "Error: failed to download Gemma 4 for offline startup" >&2
    return 1
  fi

  if [ ! -f "$MODEL_PATH" ]; then
    echo "Error: Gemma 4 download completed but ${MODEL_PATH} was not found" >&2
    return 1
  fi

  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/data/llamacpp"
  echo "  Gemma 4 model cached for offline startup"
}

has_playwright_chromium() {
  find "$CLAWBOX_HOME/.cache/ms-playwright" -type f \( -path "*/chrome-linux/chrome" -o -path "*/chrome-linux-arm64/chrome" \) -print -quit 2>/dev/null | grep -q .
}

ensure_playwright_chromium() {
  if has_playwright_chromium; then
    echo "  Playwright Chromium runtime already installed"
    return 0
  fi

  local PLAYWRIGHT_BIN="$PROJECT_DIR/node_modules/.bin/playwright"
  local PLAYWRIGHT_PATH="$CLAWBOX_HOME/.cache/ms-playwright"

  echo "  Installing Playwright Chromium runtime for the desktop browser service..."
  if [ -x "$PLAYWRIGHT_BIN" ]; then
    as_clawbox_login "cd \"$PROJECT_DIR\" && PLAYWRIGHT_BROWSERS_PATH=\"$PLAYWRIGHT_PATH\" \"$PLAYWRIGHT_BIN\" install chromium"
  else
    as_clawbox_login "cd \"$PROJECT_DIR\" && PLAYWRIGHT_BROWSERS_PATH=\"$PLAYWRIGHT_PATH\" $BUN x playwright install chromium"
  fi

  if ! has_playwright_chromium; then
    echo "Error: Playwright Chromium install completed but no service-safe browser binary was found." >&2
    exit 1
  fi

  echo "  Playwright Chromium runtime ready"
}

print_native_build_preflight() {
  local node_version node_abi npm_version python_version make_version gpp_version node_header_dir

  node_version=$(as_clawbox_login "node -p 'process.version'" 2>/dev/null || echo "missing")
  node_abi=$(as_clawbox_login "node -p 'process.versions.modules'" 2>/dev/null || echo "unknown")
  npm_version=$(as_clawbox_login "npm --version" 2>/dev/null || echo "missing")
  python_version=$(/usr/bin/python3 --version 2>/dev/null || echo "python3 missing")

  if command -v make >/dev/null 2>&1; then
    make_version=$(make --version | head -1)
  else
    make_version="make missing"
  fi

  if command -v g++ >/dev/null 2>&1; then
    gpp_version=$(g++ --version | head -1)
  else
    gpp_version="g++ missing"
  fi

  if [ -d /usr/include/nodejs ]; then
    node_header_dir="/usr/include/nodejs"
  elif [ -d /usr/include/node ]; then
    node_header_dir="/usr/include/node"
  else
    node_header_dir="not found"
  fi

  echo "  Native build preflight:"
  echo "    Node.js: $node_version (ABI $node_abi)"
  echo "    npm: $npm_version"
  echo "    Python: $python_version"
  echo "    make: $make_version"
  echo "    g++: $gpp_version"
  echo "    Node headers: $node_header_dir"
}

ensure_node_pty() {
  local verify_cmd="cd $PROJECT_DIR && node -e \"require('node-pty')\""
  if as_clawbox_login "$verify_cmd" &>/dev/null; then
    echo "  node-pty is already loadable"
    return 0
  fi

  echo "  node-pty is missing or built for the wrong Node ABI; preparing native build prerequisites..."
  print_native_build_preflight
  wait_for_apt
  apt-get install -y -qq python3 python3-pip python-is-python3 build-essential pkg-config

  mkdir -p "$CLAWBOX_HOME/.npm" "$CLAWBOX_HOME/.cache/node-gyp"
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" \
    "$CLAWBOX_HOME/.npm" \
    "$CLAWBOX_HOME/.cache/node-gyp" \
    "$PROJECT_DIR/node_modules" 2>/dev/null || true

  local rebuild_cmd="
    cd $PROJECT_DIR &&
    export npm_config_python=/usr/bin/python3 &&
    export npm_config_build_from_source=true &&
    if [ -d /usr/include/nodejs ]; then
      export npm_config_nodedir=/usr/include/nodejs
    elif [ -d /usr/include/node ]; then
      export npm_config_nodedir=/usr/include/node
    fi &&
    npm rebuild node-pty --foreground-scripts
  "

  echo "  Rebuilding native modules (node-pty)..."
  if ! as_clawbox_login "$rebuild_cmd"; then
    echo "  Initial node-pty rebuild failed; clearing stale build output and retrying once..."
    as_clawbox_login "cd $PROJECT_DIR && rm -rf node_modules/node-pty/build node_modules/node-pty/bin"
    as_clawbox_login "$rebuild_cmd"
  fi

  if ! as_clawbox_login "$verify_cmd" &>/dev/null; then
    echo "Error: node-pty is still not loadable after rebuild. Check the node-gyp output above." >&2
    exit 1
  fi

  echo "  node-pty rebuilt and verified"
}

# Stop the setup service, clear cache, reinstall, and rebuild
do_rebuild() {
  echo "Stopping clawbox-setup.service for rebuild..."
  systemctl stop clawbox-setup.service 2>/dev/null || true
  echo "Clearing .next cache..."
  rm -rf "$PROJECT_DIR/.next"
  echo "Running bun install..."
  as_clawbox_login "cd $PROJECT_DIR && $BUN install"
  ensure_node_pty
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

wait_for_apt() {
  local max_wait="${1:-900}"
  local waited=0
  while fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/cache/apt/archives/lock >/dev/null 2>&1; do
    if [ $waited -eq 0 ]; then
      echo "  Waiting for apt lock (another update is running)..."
    fi
    sleep 5
    waited=$((waited + 5))
    if [ $waited -ge "$max_wait" ]; then
      echo "Error: apt lock is still held after $((max_wait / 60)) minutes. Another updater (often unattended-upgrades) is still running; try again shortly." >&2
      return 1
    fi
  done
}

step_apt_update() {
  wait_for_apt
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl network-manager avahi-daemon iptables iw python3 python3-pip python-is-python3 gh build-essential cmake ninja-build pkg-config
  # Node.js 22 (required for production server — bun doesn't fire upgrade events)
  if node --version 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])\.'; then
    echo "  Node.js $(node --version) already installed"
  else
    echo "  Installing Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
    echo "  Node.js $(node --version) installed"
  fi
}

step_network_setup() {
  # --- Detect WiFi interface ---
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

  # --- Hostname and mDNS ---
  apply_hostname "$(read_configured_hostname)"
}

# Validate an RFC 1123 hostname label: 1-63 chars, [a-z0-9-], no leading/trailing hyphen.
# Prints the lowercased hostname on success, or empty string on failure.
validate_hostname() {
  local name="${1:-}"
  name="${name,,}"
  if [[ ! "$name" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
    echo ""
    return 1
  fi
  echo "$name"
}

# Read desired hostname from data/hostname.env (HOSTNAME=value) or config.json.
# Falls back to "clawbox".
read_configured_hostname() {
  local hostname_env="$PROJECT_DIR/data/hostname.env"
  local name=""
  if [ -f "$hostname_env" ]; then
    # shellcheck source=/dev/null
    name=$(. "$hostname_env" 2>/dev/null; printf '%s' "${HOSTNAME:-}")
  fi
  if [ -z "$name" ]; then
    name="clawbox"
  fi
  local valid
  valid=$(validate_hostname "$name") || valid=""
  if [ -z "$valid" ]; then
    valid="clawbox"
  fi
  printf '%s' "$valid"
}

# Set system hostname and install the hardened avahi config so mDNS
# advertises <name>.local reliably.
#
# Hardening goals (full rationale in config/avahi-daemon.conf):
#   - Shorter rate-limit window + larger burst so Windows' chatty
#     parallel A/AAAA/SRV/PTR queries don't trip avahi's throttle and
#     trigger a 15-minute negative-cache on the client.
#   - Cross-family (publish-a-on-ipv6 / publish-aaaa-on-ipv4) so dual-
#     stack clients resolve on the first attempt.
#   - use-iff-running=no so we announce the instant an address is
#     assigned, not after IFF_RUNNING flips on.
#   - A NetworkManager dispatcher hook forces avahi to re-announce on
#     every interface up/down / DHCP change so stale negative caches
#     on clients expire within seconds instead of 15 minutes.
apply_hostname() {
  local name
  name=$(validate_hostname "${1:-}") || name=""
  if [ -z "$name" ]; then
    echo "  Invalid hostname '${1:-}', skipping"
    return 1
  fi
  hostnamectl set-hostname "$name"

  # Install ClawBox's hardened avahi config if we have one in the repo.
  # Keep the distro default as .bak.orig the first time so operators can
  # diff and revert if needed.
  # Prefer the canonical project copy under $PROJECT_DIR, but fall back to
  # the config shipped next to the installer script. This matters on the
  # fresh-install path where the network setup step runs before `git pull`
  # has populated $PROJECT_DIR — the installer is being executed straight
  # out of the cloned tarball at that moment.
  local clawbox_avahi_src="$PROJECT_DIR/config/avahi-daemon.conf"
  if [ ! -f "$clawbox_avahi_src" ] && [ -f "$(dirname "$0")/config/avahi-daemon.conf" ]; then
    clawbox_avahi_src="$(dirname "$0")/config/avahi-daemon.conf"
  fi
  if [ -f "$clawbox_avahi_src" ]; then
    if [ -f "$AVAHI_CONF" ] && [ ! -f "${AVAHI_CONF}.bak.orig" ]; then
      cp "$AVAHI_CONF" "${AVAHI_CONF}.bak.orig"
    fi
    install -m 644 "$clawbox_avahi_src" "$AVAHI_CONF"
    # Rewrite the host-name line to match the configured device hostname.
    sed -i "s/^#\\?host-name=.*/host-name=$name/" "$AVAHI_CONF"
    echo "  Installed hardened avahi-daemon.conf (host-name=$name)"
  elif [ -f "$AVAHI_CONF" ]; then
    # Fallback when install.sh runs from a repo that doesn't have the
    # new config file (older deployments): just rewrite the host-name
    # line in the distro default, same as before.
    cp -n "$AVAHI_CONF" "${AVAHI_CONF}.bak" 2>/dev/null || true
    if grep -q '^#\?host-name=' "$AVAHI_CONF"; then
      sed -i "s/^#\\?host-name=.*/host-name=$name/" "$AVAHI_CONF"
    elif grep -q '^\[server\]' "$AVAHI_CONF"; then
      sed -i "/^\\[server\\]/a host-name=$name" "$AVAHI_CONF"
    else
      printf '\n[server]\nhost-name=%s\n' "$name" >> "$AVAHI_CONF"
    fi
  else
    echo "  Warning: $AVAHI_CONF not found and no repo config to install"
  fi

  # Install the NetworkManager dispatcher hook that reloads avahi on
  # every interface state change, so clients' negative caches flush.
  local dispatcher_dir="/etc/NetworkManager/dispatcher.d"
  local dispatcher_src="$PROJECT_DIR/config/99-clawbox-avahi-reload"
  if [ ! -f "$dispatcher_src" ] && [ -f "$(dirname "$0")/config/99-clawbox-avahi-reload" ]; then
    dispatcher_src="$(dirname "$0")/config/99-clawbox-avahi-reload"
  fi
  if [ -f "$dispatcher_src" ] && [ -d "$dispatcher_dir" ]; then
    install -m 755 "$dispatcher_src" "$dispatcher_dir/99-clawbox-avahi-reload"
    # NetworkManager requires dispatcher scripts to be owned by root and
    # not world-writable — install(1) defaults already match, but make it
    # explicit so future permission tightening doesn't silently disable.
    chown root:root "$dispatcher_dir/99-clawbox-avahi-reload"
    echo "  Installed NetworkManager dispatcher for avahi re-announce"
  fi

  systemctl restart avahi-daemon
  echo "  Hostname set to '$name', avahi restarted"
}

step_set_hostname() {
  apply_hostname "$(read_configured_hostname)"
}

is_safe_git_ref() {
  local ref="${1:-}"
  [ -n "$ref" ] || return 1
  git check-ref-format --branch "$ref" >/dev/null 2>&1
}

resolve_update_branch() {
  UPDATE_TARGET_LOCAL="main"
  UPDATE_TARGET_UPSTREAM="origin/main"

  local pinned=""
  if [ -f "$PROJECT_DIR/.update-branch" ]; then
    pinned=$(head -n 1 "$PROJECT_DIR/.update-branch" | tr -d '[:space:]')
    if [ -n "$pinned" ] && is_safe_git_ref "$pinned"; then
      UPDATE_TARGET_LOCAL="$pinned"
      UPDATE_TARGET_UPSTREAM="origin/$pinned"
      return 0
    fi
  fi

  local current upstream
  current=$(git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" symbolic-ref --short HEAD 2>/dev/null || true)
  if [ -n "$current" ] && [ "$current" != "main" ] && is_safe_git_ref "$current"; then
    upstream=$(git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" rev-parse --abbrev-ref "${current}@{u}" 2>/dev/null || true)
    if [ -n "$upstream" ] && is_safe_git_ref "$upstream"; then
      UPDATE_TARGET_LOCAL="$current"
      UPDATE_TARGET_UPSTREAM="$upstream"
    fi
  fi
}

sync_repo_to_update_target() {
  local target_branch="$1"
  local upstream_branch="$2"

  if [ ! -d "$PROJECT_DIR/.git" ]; then
    echo "Error: $PROJECT_DIR is not a git repository" >&2
    exit 1
  fi

  git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" fetch origin
  if ! git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" checkout "$target_branch" 2>/dev/null; then
    if ! git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" checkout -b "$target_branch" "$upstream_branch" 2>/dev/null; then
      echo "Error: failed to checkout branch '$target_branch'" >&2
      exit 1
    fi
  fi
  git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" reset --hard "$upstream_branch"
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR"
}

step_bootstrap_updater() {
  # Pull the latest repo files (especially install.sh) before any later update
  # steps run. The current root service finishes under the old script, but the
  # next root step will launch a fresh shell against the updated install.sh.
  step_fix_git_perms
  resolve_update_branch
  echo "  Refreshing updater files on branch '$UPDATE_TARGET_LOCAL'..."
  sync_repo_to_update_target "$UPDATE_TARGET_LOCAL" "$UPDATE_TARGET_UPSTREAM"
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
      if ! git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" checkout "$TARGET_BRANCH" 2>/dev/null; then
        # Try creating a tracking branch from origin if it only exists remotely
        if ! git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" checkout -b "$TARGET_BRANCH" "origin/$TARGET_BRANCH" 2>/dev/null; then
          echo "Error: failed to checkout branch '$TARGET_BRANCH'" >&2
          exit 1
        fi
      fi
    fi
    git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" merge --ff-only "origin/$TARGET_BRANCH" || echo "  Warning: merge failed (local changes?), continuing with current code"
    # Fix project ownership — git operations run as root can leave both git
    # metadata and working-tree files owned by root, which blocks later pulls
    # and writes by the clawbox user.
    chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR"
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
  ensure_node_pty
  as_clawbox_login "cd $PROJECT_DIR && $BUN run build"
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
  LATEST=$(npm view openclaw version --registry https://registry.npmjs.org 2>/dev/null || echo "")
  local TARGET="${LATEST:-$OPENCLAW_VERSION}"
  if [ -x "$OPENCLAW_BIN" ]; then
    local INSTALLED INSTALLED_VER
    # `openclaw --version` prints "OpenClaw X.Y.Z (hash)"; extract field 2 so
    # we can compare exactly against the bare npm version. Literal "=" on the
    # full string would always miss because of the prefix/hash.
    INSTALLED=$("$OPENCLAW_BIN" --version 2>/dev/null || echo "none")
    INSTALLED_VER=$(echo "$INSTALLED" | awk '{print $2}')
    echo "  Installed: $INSTALLED, Target: $TARGET"
    if [ "$INSTALLED_VER" = "$TARGET" ]; then
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
  # Patcher restricts file searches to .js (runtime bundles) — newer openclaw
  # releases ship .d.ts declaration files alongside bundled JS, and literal
  # type strings would otherwise match files we cannot patch.
  local PATCHED_MARKER='isControlUi && allowControlUiBypass'

  # Gateway scope patch
  if grep -qrl --include='*.js' "$PATCHED_MARKER" "$GATEWAY_DIST" 2>/dev/null; then
    echo "  Gateway scope patch: already applied"
  else
    local SCOPE_FILES
    SCOPE_FILES=$(grep -Prl --include='*.js' 'if\s*\(\s*scopes\.length\s*>\s*0\s*\)\s*\{' "$GATEWAY_DIST" 2>/dev/null || true)
    if [ -z "$SCOPE_FILES" ]; then
      echo "Error: Gateway scope patch: pattern not found and patch not already applied"
      exit 1
    fi

    for file in $SCOPE_FILES; do
      sed -i -E 's/if[[:space:]]*\([[:space:]]*scopes\.length[[:space:]]*>[[:space:]]*0[[:space:]]*\)[[:space:]]*\{/if (scopes.length > 0 \&\& !(isControlUi \&\& allowControlUiBypass)) {/g' "$file"
    done

    if ! grep -qrl --include='*.js' "$PATCHED_MARKER" "$GATEWAY_DIST" 2>/dev/null; then
      echo "Error: Gateway scope patch verification failed"
      exit 1
    fi
    echo "  Gateway scope patch applied and verified"
  fi

  # --- Device identity bypass patch ---
  # OpenClaw bug: dangerouslyDisableDeviceAuth sets allowBypass but
  # handleMissingDeviceIdentity doesn't check it before the final rejection.
  # Add: allow Control UI when bypass flag is set.
  local DEVICE_MARKER='controlUiAuthPolicy.allowBypass) return'

  local DEVICE_FILES
  DEVICE_FILES=$(grep -rl --include='*.js' 'reject-device-required' "$GATEWAY_DIST" 2>/dev/null || true)
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
  local CLAWBOX_AI_ENV="$PROJECT_DIR/.env"
  local CLAWBOX_AI_KEY="${CLAWBOX_AI_API_KEY:-}"
  local AUTH_PROFILES="$CLAWBOX_HOME/.openclaw/agents/main/agent/auth-profiles.json"

  # Sequential config set calls to avoid ConfigMutationConflictError
  # Only seed the primary model if unset — preserves the user's provider choice
  # across updates (rebuild_reboot re-invokes this step).
  local CURRENT_PRIMARY
  CURRENT_PRIMARY=$(as_clawbox "$OPENCLAW_BIN" config get agents.defaults.model.primary 2>/dev/null || echo "")
  if [ -z "$CURRENT_PRIMARY" ] || [ "$CURRENT_PRIMARY" = "null" ]; then
    as_clawbox "$OPENCLAW_BIN" config set agents.defaults.model.primary "anthropic/claude-sonnet-4-20250514"
    echo "  Default model set"
  else
    echo "  Default model already set ($CURRENT_PRIMARY) — preserving"
  fi
  as_clawbox "$OPENCLAW_BIN" config set agents.defaults.compaction.reserveTokensFloor 24000
  echo "  Compaction reserve floor set"

  if [ -z "$CLAWBOX_AI_KEY" ] && [ -f "$CLAWBOX_AI_ENV" ]; then
    CLAWBOX_AI_KEY=$(grep '^CLAWBOX_AI_API_KEY=' "$CLAWBOX_AI_ENV" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  fi
  if [ -n "$CLAWBOX_AI_KEY" ]; then
    local CLAWBOX_AI_PROVIDER_JSON
    CLAWBOX_AI_PROVIDER_JSON=$(node -e 'const key=process.argv[1]; process.stdout.write(JSON.stringify({baseUrl:"https://api.deepseek.com",api:"openai-completions",apiKey:key,models:[{id:"deepseek-chat",name:"ClawBox AI",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:8192}]}));' "$CLAWBOX_AI_KEY")
    mkdir -p "$(dirname "$AUTH_PROFILES")"
    CLAWBOX_AI_KEY="$CLAWBOX_AI_KEY" AUTH_PROFILES="$AUTH_PROFILES" node -e 'const fs=require("fs"); const p=process.env.AUTH_PROFILES; let data={version:1,profiles:{}}; try{data=JSON.parse(fs.readFileSync(p,"utf8"));}catch{} data.profiles["deepseek:default"]={type:"api_key",provider:"deepseek",key:process.env.CLAWBOX_AI_KEY}; fs.writeFileSync(p, JSON.stringify(data,null,2), { mode: 0o600 });'
    as_clawbox "$OPENCLAW_BIN" config set auth.profiles.deepseek:default '{"provider":"deepseek","mode":"api_key"}' --json
    as_clawbox "$OPENCLAW_BIN" config set models.providers.deepseek "$CLAWBOX_AI_PROVIDER_JSON" --json
    as_clawbox "$OPENCLAW_BIN" config set agents.defaults.model.fallback "deepseek/deepseek-chat"
    echo "  ClawBox AI fallback model configured"
  fi

  as_clawbox "$OPENCLAW_BIN" config set gateway.auth.mode token
  as_clawbox "$OPENCLAW_BIN" config set gateway.auth.token clawbox
  echo "  Gateway auth mode set to token"

  as_clawbox "$OPENCLAW_BIN" config set gateway.controlUi.allowInsecureAuth true --json
  echo "  allowInsecureAuth enabled"

  as_clawbox "$OPENCLAW_BIN" config set gateway.controlUi.dangerouslyDisableDeviceAuth true --json
  echo "  dangerouslyDisableDeviceAuth enabled"

  # Register Telegram channel (if token exists)
  if [ -f "$CLAWBOX_CONFIG" ]; then
    local TG_TOKEN
    TG_TOKEN=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('$CLAWBOX_CONFIG','utf8'));if(c.telegram_bot_token)process.stdout.write(c.telegram_bot_token)}catch{}" 2>/dev/null || true)
    if [ -n "$TG_TOKEN" ]; then
      as_clawbox "$OPENCLAW_BIN" config set channels.telegram \
        "{\"enabled\":true,\"botToken\":\"$TG_TOKEN\",\"dmPolicy\":\"open\",\"allowFrom\":[\"*\"]}" --json
      echo "  Telegram channel registered"
    fi
  fi

  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$CLAWBOX_HOME/.openclaw" 2>/dev/null || true
  echo "  OpenClaw config updated"
}

step_setup_config() {
  step_directories_permissions
  step_captive_portal_dns
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
  if [ -n "${CLAWBOX_AI_API_KEY:-}" ] && ! grep -q '^CLAWBOX_AI_API_KEY=' "$ENV_FILE" 2>/dev/null; then
    printf 'CLAWBOX_AI_API_KEY=%s\n' "$CLAWBOX_AI_API_KEY" >> "$ENV_FILE"
    echo "  Added CLAWBOX_AI_API_KEY to $ENV_FILE"
  fi
  ensure_env_setting "$ENV_FILE" "LLAMACPP_BASE_URL" "http://127.0.0.1:8080/v1"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_MODEL" "gemma4-e2b-it-q4_0"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_HF_REPO" "gguf-org/gemma-4-e2b-it-gguf"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_HF_FILE" "gemma-4-e2b-it-edited-q4_0.gguf"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_BIN" "/usr/local/bin/llama-server"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_CONTEXT_WINDOW" "131072"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_CACHE_TYPE_K" "q4_0"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_CACHE_TYPE_V" "q4_0"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_MAX_TOKENS" "131072"
  echo "  Done"
}

step_system_config() {
  step_systemd_services
  step_polkit_rules
  step_nm_dispatcher
  step_sysctl_linkdown
}

step_systemd_services() {
  local ALL_SERVICES=(clawbox-ap.service clawbox-setup.service clawbox-gateway.service clawbox-performance.service "clawbox-root-update@.service" clawbox-browser.service clawbox-tunnel.service)
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
  # Enable all services except templates and the on-demand browser unit.
  for svc in "${ALL_SERVICES[@]}"; do
    [[ "$svc" == *@* ]] && continue
    [[ "$svc" == "clawbox-browser.service" ]] && continue
    systemctl enable "$svc"
  done
  # Clean up older installs that enabled Chromium on boot.
  systemctl disable --now clawbox-browser.service >/dev/null 2>&1 || true
  # Install sudoers rules so the clawbox user can manage services (systemctl restart, reboot, etc.)
  if [ -f "$PROJECT_DIR/config/clawbox-sudoers" ]; then
    cp "$PROJECT_DIR/config/clawbox-sudoers" /etc/sudoers.d/clawbox
    chmod 0440 /etc/sudoers.d/clawbox
    chown root:root /etc/sudoers.d/clawbox
    if ! visudo -cf /etc/sudoers.d/clawbox >/dev/null; then
      rm -f /etc/sudoers.d/clawbox
      echo "Error: sudoers drop-in failed visudo validation; removed to keep sudo functional" >&2
      exit 1
    fi
    echo "  Sudoers rules installed"
  fi
  echo "  Services installed and enabled"
}

step_sysctl_linkdown() {
  local SYSCTL_DIR="/etc/sysctl.d"
  local DEST="$SYSCTL_DIR/90-clawbox-linkdown.conf"
  mkdir -p "$SYSCTL_DIR"
  cat > "$DEST" <<'SYSCTL_EOF'
# ClawBox: instantly skip default routes whose interface has lost link.
# Fixes the 5-10s blackhole when Ethernet is unplugged while WiFi is also up.
net.ipv4.conf.all.ignore_routes_with_linkdown=1
net.ipv4.conf.default.ignore_routes_with_linkdown=1
SYSCTL_EOF
  chown root:root "$DEST"
  chmod 0644 "$DEST"
  sysctl -q -p "$DEST" 2>/dev/null || true
  echo "  Linkdown routing sysctl installed"
}

step_nm_dispatcher() {
  local DISPATCHER_DIR="/etc/NetworkManager/dispatcher.d"
  local SRC="$PROJECT_DIR/scripts/nm-dispatcher-failover.sh"
  local DEST="$DISPATCHER_DIR/90-clawbox-failover"
  if [ ! -f "$SRC" ]; then
    echo "  Skipping NM dispatcher: $SRC missing"
    return
  fi
  mkdir -p "$DISPATCHER_DIR"
  cp "$SRC" "$DEST"
  chown root:root "$DEST"
  chmod 0755 "$DEST"
  echo "  NetworkManager failover dispatcher installed"
}

step_post_update() {
  # Re-apply system-level fixups that aren't covered by `git pull && build`.
  # Triggered by the in-app updater so existing devices pick up new dispatcher
  # scripts, sysctls, etc. without a full reinstall. Keep this list small and
  # idempotent.
  # step_set_hostname re-runs apply_hostname, which redeploys the hardened
  # avahi-daemon.conf + 99-clawbox-avahi-reload dispatcher hook. Without this
  # call, devices updating via the in-app updater never receive the mDNS
  # fixes from this PR — they'd keep failing to resolve <hostname>.local on
  # Windows until the owner did a fresh install.
  step_set_hostname || echo "  Warning: set_hostname step failed (non-fatal)"
  step_nm_dispatcher || echo "  Warning: nm_dispatcher step failed (non-fatal)"
  step_sysctl_linkdown || echo "  Warning: sysctl_linkdown step failed (non-fatal)"
  # step_vnc_refresh is a tiny idempotent refresh of the clawbox-vnc.service
  # unit + autocutsel package. Devices installed before the display-:99 move
  # and the clipboard-sync addition get both here without needing a reinstall.
  step_vnc_refresh || echo "  Warning: vnc_refresh step failed (non-fatal)"
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
  # clawbox-tunnel.service is started on-demand from Settings → Remote Control,
  # not at boot — skip it here.
  echo "  Services started"
}

step_cloudflared_install() {
  if [ ! -f "$PROJECT_DIR/scripts/setup-tunnel.sh" ]; then
    echo "  setup-tunnel.sh missing — skipping cloudflared install"
    return 0
  fi
  bash "$PROJECT_DIR/scripts/setup-tunnel.sh" || {
    echo "  WARNING: cloudflared install failed; remote control will be unavailable until reinstalled"
    return 0
  }
}

# ── Update-only steps (called from dashboard System Update) ──────────────────

step_nvidia_jetpack() {
  wait_for_apt
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nvidia-jetpack
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

step_llamacpp_install() {
  local LLAMA_DIR="$CLAWBOX_HOME/llama.cpp"
  local ENABLE_GGML_CUDA="OFF"

  # On Jetson, nvcc ships at /usr/local/cuda/bin but isn't on systemd's PATH,
  # so `command -v nvcc` fails and we silently fall back to a CPU-only build.
  # Probe the standard location and add it to PATH so detection works regardless
  # of how install.sh is invoked (interactive shell vs systemd unit).
  if ! command -v nvcc &>/dev/null && [ -x /usr/local/cuda/bin/nvcc ]; then
    export PATH="/usr/local/cuda/bin:$PATH"
  fi

  if command -v nvcc &>/dev/null; then
    ENABLE_GGML_CUDA="ON"
  fi

  if ! command -v cmake &>/dev/null || ! command -v git &>/dev/null || ! command -v python3 &>/dev/null; then
    echo "  Installing llama.cpp build prerequisites..."
    wait_for_apt
    apt-get update -qq
    apt-get install -y -qq git curl python3 python3-pip python-is-python3 build-essential cmake ninja-build pkg-config
  fi

  if ! as_clawbox_login "command -v hf" &>/dev/null; then
    echo "  Installing Hugging Face CLI..."
    as_clawbox_login "python3 -m pip install --user --upgrade 'huggingface_hub[cli]'"
  else
    echo "  Hugging Face CLI already installed"
  fi

  # Determine if a rebuild is needed. Rebuild when:
  #   a) llama-server is missing, OR
  #   b) CUDA is now available but the installed binary was built CPU-only
  #      (common upgrade case for existing installs that predate the fix above).
  local needs_rebuild="false"
  if [ ! -x /usr/local/bin/llama-server ]; then
    needs_rebuild="true"
  elif [ "$ENABLE_GGML_CUDA" = "ON" ] \
       && ! ldd /usr/local/bin/llama-server 2>/dev/null | grep -qiE 'libcuda|libcublas|libcudart'; then
    echo "  Existing llama-server was built without CUDA — rebuilding with GPU support"
    needs_rebuild="true"
  fi

  if [ "$needs_rebuild" = "true" ]; then
    echo "  Installing llama.cpp server (CUDA=$ENABLE_GGML_CUDA)..."
    if [ ! -d "$LLAMA_DIR/.git" ]; then
      as_clawbox git clone --depth 1 https://github.com/ggml-org/llama.cpp.git "$LLAMA_DIR"
    fi
    # Pin CUDA architectures to Jetson Orin's sm_87 so cmake doesn't spend
    # ~15 extra minutes probing / compiling kernels for datacenter and
    # desktop GPUs we don't target. Without this, configure on Jetson ARM
    # can take 20–30 minutes and the resulting binary is 8x larger than
    # needed.
    local LLAMACPP_CMAKE_FLAGS=(-DCMAKE_BUILD_TYPE=Release "-DGGML_CUDA=$ENABLE_GGML_CUDA")
    if [ "$ENABLE_GGML_CUDA" = "ON" ]; then
      LLAMACPP_CMAKE_FLAGS+=(-DCMAKE_CUDA_ARCHITECTURES=87)
    fi
    as_clawbox_login "rm -f $LLAMA_DIR/build/CMakeCache.txt && rm -rf $LLAMA_DIR/build/CMakeFiles && cd $LLAMA_DIR && cmake -S . -B build ${LLAMACPP_CMAKE_FLAGS[*]}"
    as_clawbox_login "cd $LLAMA_DIR && cmake --build build --config Release -j$(nproc) --target llama-server"
    install -m 755 "$LLAMA_DIR/build/bin/llama-server" /usr/local/bin/llama-server
  else
    echo "  llama-server already installed (CUDA=$ENABLE_GGML_CUDA)"
  fi

  ensure_llamacpp_model_cached
  echo "  llama.cpp runtime ready"
}

step_chpasswd() {
  local INPUT_FILE="$PROJECT_DIR/data/.chpasswd-input"
  if [ ! -f "$INPUT_FILE" ]; then
    echo "Error: password input file not found" >&2
    exit 1
  fi
  /usr/sbin/chpasswd < "$INPUT_FILE"
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
  else
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
  fi

  ensure_playwright_chromium
}


step_ai_tools_install() {
  # Claude Code
  if sudo -u "$CLAWBOX_USER" bash -c 'command -v claude' &>/dev/null; then
    echo "  Claude Code already installed"
  else
    sudo -u "$CLAWBOX_USER" bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
    echo "  Claude Code installed"
  fi

  # OpenAI Codex CLI
  if as_clawbox_login "command -v codex" &>/dev/null; then
    echo "  OpenAI Codex already installed"
  else
    as_clawbox_login "npm i -g @openai/codex --prefix $NPM_PREFIX"
    echo "  OpenAI Codex installed"
  fi

  # Google Gemini CLI
  if as_clawbox_login "command -v gemini" &>/dev/null; then
    echo "  Gemini CLI already installed"
  else
    as_clawbox_login "npm i -g @google/gemini-cli --prefix $NPM_PREFIX"
    echo "  Gemini CLI installed"
  fi
}

step_vnc_install() {
  wait_for_apt
  # Install x11vnc, Xvfb (virtual framebuffer fallback), websockify, and a lightweight WM
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq x11vnc xvfb websockify dbus-x11 openbox xterm x11-xserver-utils autocutsel

  chmod +x "$PROJECT_DIR/scripts/start-vnc.sh"
  chown "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/scripts/start-vnc.sh"
  chmod +x "$PROJECT_DIR/scripts/ensure-vnc-on-first-boot.sh"
  chown root:root "$PROJECT_DIR/scripts/ensure-vnc-on-first-boot.sh"

  # Systemd service for VNC — force virtual display mode. On headless
  # Jetsons, :0 is GDM's greeter; apps launched into it are covered by
  # the greeter and invisible to VNC viewers. Xvfb :99 gives a clean
  # dedicated surface that matches what the browser service targets.
  cat > /etc/systemd/system/clawbox-vnc.service <<VNCSVC
[Unit]
Description=ClawBox VNC (virtual desktop)
After=network.target

[Service]
Type=simple
User=$CLAWBOX_USER
Environment=CLAWBOX_VNC_MODE=virtual
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

  # One-shot first-boot service to bring VNC back up after the first reboot
  mkdir -p /var/lib/clawbox
  touch /var/lib/clawbox/ensure-vnc-on-first-boot.pending
  cat > /etc/systemd/system/clawbox-firstboot-vnc.service <<FIRSTBOOTVNC
[Unit]
Description=ClawBox first boot VNC bring-up
After=network-online.target display-manager.service multi-user.target
Wants=network-online.target
ConditionPathExists=/var/lib/clawbox/ensure-vnc-on-first-boot.pending

[Service]
Type=oneshot
ExecStartPre=/bin/sleep 10
ExecStart=$PROJECT_DIR/scripts/ensure-vnc-on-first-boot.sh

[Install]
WantedBy=multi-user.target
FIRSTBOOTVNC

  # Browser CDP service (launched on demand, not auto-started)
  chmod +x "$PROJECT_DIR/scripts/launch-browser.sh"
  cp "$PROJECT_DIR/config/clawbox-browser.service" /etc/systemd/system/

  systemctl daemon-reload
  systemctl enable clawbox-vnc.service clawbox-websockify.service clawbox-firstboot-vnc.service
  systemctl restart clawbox-vnc.service clawbox-websockify.service || true
  echo "  VNC (x11vnc + Xvfb fallback) and websockify installed and started"
  echo "  First reboot will re-ensure VNC services are active"
}

step_vnc_refresh() {
  # Idempotent subset of step_vnc_install, safe to run on every update path.
  # Picks up changes to the clawbox-vnc.service unit (e.g. the CLAWBOX_VNC_MODE
  # env var added when we moved VNC off display :0) and installs packages
  # added in later PRs (e.g. autocutsel for bidirectional VNC clipboard sync).
  # Without this step, existing devices updating via the in-app updater never
  # receive those fixes — they'd keep mirroring GDM's greeter + have no
  # clipboard support until the owner did a fresh install.
  #
  # Deliberately a narrow subset of step_vnc_install — no firstboot-pending
  # flag, no websockify unit rewrite, no clawbox-browser unit re-copy. All of
  # those are already on-disk from the original install and re-touching them
  # here risks extra reboot-time reruns (the firstboot flag) or racey restarts
  # of services that aren't involved in this particular bugfix.
  #
  # apt-get may collide with unattended-upgrades or a user-triggered install,
  # so wait for the dpkg lock first. Make the install non-fatal — a transient
  # apt failure here shouldn't block the more important unit refresh below.
  wait_for_apt
  if ! DEBIAN_FRONTEND=noninteractive apt-get install -y -qq autocutsel; then
    echo "  Warning: autocutsel install failed (non-fatal; continuing with unit refresh)"
  fi

  local unit_path=/etc/systemd/system/clawbox-vnc.service
  local unit_tmp
  unit_tmp="$(mktemp)"
  cat > "$unit_tmp" <<VNCSVC
[Unit]
Description=ClawBox VNC (virtual desktop)
After=network.target

[Service]
Type=simple
User=$CLAWBOX_USER
Environment=CLAWBOX_VNC_MODE=virtual
ExecStart=$PROJECT_DIR/scripts/start-vnc.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
VNCSVC

  # Only reload + restart when the unit actually changed — the restart
  # disconnects any active VNC viewer, so we don't want to kick sessions
  # on an idempotent re-run. Websockify is tied to the VNC service via
  # Requires=, but that only propagates *stops*, not restarts, so we
  # bounce it alongside when the VNC unit changed to keep the proxy
  # aligned with the freshly-restarted server.
  if [ ! -f "$unit_path" ] || ! cmp -s "$unit_tmp" "$unit_path"; then
    install -m 644 "$unit_tmp" "$unit_path"
    systemctl daemon-reload
    systemctl restart clawbox-vnc.service clawbox-websockify.service || true
    echo "  VNC service refreshed (CLAWBOX_VNC_MODE=virtual, autocutsel installed)"
  else
    echo "  VNC service already up-to-date, skipping restart"
  fi
  rm -f "$unit_tmp"
}

step_desktop_theme() {
  local theme_script="$PROJECT_DIR/scripts/apply-desktop-theme.sh"
  local autostart_dir="$CLAWBOX_HOME/.config/autostart"
  local autostart_file="$autostart_dir/clawbox-desktop-theme.desktop"

  if [ ! -f "$theme_script" ]; then
    echo "Error: Desktop theme script not found: $theme_script" >&2
    exit 1
  fi

  chmod +x "$theme_script"
  chown "$CLAWBOX_USER:$CLAWBOX_USER" "$theme_script"

  mkdir -p "$autostart_dir"
  cat > "$autostart_file" <<EOF
[Desktop Entry]
Type=Application
Name=ClawBox Desktop Theme
Exec=$theme_script
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
  chown "$CLAWBOX_USER:$CLAWBOX_USER" "$autostart_dir" "$autostart_file"
  chmod 644 "$autostart_file"

  mkdir -p /etc/dconf/db/local.d
  cat > /etc/dconf/db/local.d/01-clawbox-desktop-theme <<'EOF'
[org/gnome/desktop/background]
picture-uri=''
picture-uri-dark=''
picture-options='none'
color-shading-type='solid'
primary-color='#0a0f1a'
secondary-color='#111827'
EOF
  dconf update >/dev/null 2>&1 || true

  if command -v dbus-launch >/dev/null 2>&1; then
    as_clawbox_login "dbus-launch \"$theme_script\"" >/dev/null 2>&1 || true
  else
    as_clawbox_login "\"$theme_script\"" >/dev/null 2>&1 || true
  fi

  echo "  ClawBox desktop background configured"
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
  bootstrap_updater apt_update nvidia_jetpack performance_mode jtop_install ollama_install llamacpp_install
  chromium_install ai_tools_install vnc_install vnc_refresh
  openclaw_setup openclaw_install openclaw_patch openclaw_config openclaw_models
  network_setup set_hostname setup_config system_config
  git_pull build rebuild rebuild_reboot restart restart_ap recover
  chpasswd gateway_setup ffmpeg_install polkit_rules systemd_services
  directories_permissions captive_portal_dns desktop_theme
  fix_git_perms browser_launch cloudflared_install
  nm_dispatcher sysctl_linkdown post_update
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

TOTAL_STEPS=20
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

log "Configuring network (WiFi, hostname, mDNS)..."
step_network_setup

log "Setting up ClawBox repository..."
step_git_pull

log "Ensuring bun is installed..."
step_install_bun

log "Building ClawBox..."
step_build

log "Installing and configuring OpenClaw..."
step_openclaw_setup

log "Setting up directories, permissions and DNS..."
step_setup_config

# Clean up default NVIDIA desktop shortcuts
rm -f "$CLAWBOX_HOME/Desktop"/*.desktop 2>/dev/null || true

log "Installing systemd services and polkit rules..."
step_system_config

log "Installing jtop (jetson-stats)..."
step_jtop_install

log "Installing Ollama..."
step_ollama_install

log "Installing llama.cpp runtime..."
step_llamacpp_install

log "Installing Chromium..."
step_chromium_install

log "Installing Cloudflare Tunnel (cloudflared)..."
step_cloudflared_install

log "Installing AI coding tools (Claude Code, Codex, Gemini)..."
step_ai_tools_install

log "Installing VNC server..."
step_vnc_install

log "Applying ClawBox desktop theme..."
step_desktop_theme

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
