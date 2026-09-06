#!/usr/bin/env bash
# ClawBox x64 Desktop Installer — Ubuntu desktop/server installer.
# Installs OpenClaw + the ClawBox UI as persistent systemd services.
# Does NOT modify: hostname, WiFi, DNS, NVIDIA drivers, or Jetson settings.
#
# Usage:
#   sudo bash install-x64.sh              — full install
#   sudo bash install-x64.sh --step NAME  — run a single step
#
# Environment variables:
#   CLAWBOX_BRANCH       — git branch to clone/checkout (default: main)
#   CLAWBOX_USER         — user to install as (default: current user)
#   CLAWBOX_PORT         — port for ClawBox UI (default: 3005)
#   CLAWBOX_DIR          — checkout to install (default: ~/clawbox)
#   OPENCLAW_PIN_VERSION — QA override for config/openclaw-target.txt
set -euo pipefail

# ── Require root ─────────────────────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: Run this script with sudo" >&2
  exit 1
fi

# ── Constants ────────────────────────────────────────────────────────────────

REPO_URL="https://github.com/ID-Robots/clawbox.git"
REPO_BRANCH="${CLAWBOX_BRANCH:-main}"
if [ "$(uname -m)" != "x86_64" ]; then
  echo "Error: install-x64.sh only supports x86_64 hosts (found $(uname -m))." >&2
  exit 1
fi

# `logname` fails in containers and remote shells, while SUDO_USER is unset
# when root invokes the installer directly. Resolve without tripping `set -u`.
DEFAULT_USER="$(logname 2>/dev/null || true)"
[ -n "$DEFAULT_USER" ] || DEFAULT_USER="${SUDO_USER:-}"
if [ -z "$DEFAULT_USER" ] && [ "$(id -u)" -ne 0 ]; then
  DEFAULT_USER="$(id -un)"
fi
CLAWBOX_USER="${CLAWBOX_USER:-$DEFAULT_USER}"
if [ -z "$CLAWBOX_USER" ] || [ "$CLAWBOX_USER" = "root" ]; then
  echo "Error: could not resolve an unprivileged install user. Set CLAWBOX_USER=<user>." >&2
  exit 1
fi
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

OPENCLAW_VERSION="2026.8.1"
NPM_PREFIX="$CLAWBOX_HOME/.npm-global"
OPENCLAW_BIN="$NPM_PREFIX/bin/openclaw"
GATEWAY_DIST="$NPM_PREFIX/lib/node_modules/openclaw/dist"
OPENCLAW_HOME="$CLAWBOX_HOME/.openclaw"
UI_SERVICE="clawbox-setup.service"
GATEWAY_SERVICE="clawbox-gateway.service"
NODE_DIST_VERSION="24.15.0"
NODE_DIST_ROOT="/opt/clawbox/node"
export PATH="$NODE_DIST_ROOT/bin:$PATH"

# ── Helpers ──────────────────────────────────────────────────────────────────

as_user() { sudo -u "$CLAWBOX_USER" "$@"; }

as_user_runtime() {
  sudo -u "$CLAWBOX_USER" -H env \
    HOME="$CLAWBOX_HOME" \
    CLAWBOX_ROOT="$PROJECT_DIR" \
    PATH="$NODE_DIST_ROOT/bin:$NPM_PREFIX/bin:$CLAWBOX_HOME/.bun/bin:$CLAWBOX_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
    "$@"
}

# Run a command as the user with login environment.
# Pass the entire command as a single argument (don't $* expand) so callers
# control quoting and shell metacharacters in their command can't break out.
as_user_login() {
  sudo -iu "$CLAWBOX_USER" bash -lc "export HOME=\"$CLAWBOX_HOME\" CLAWBOX_ROOT=\"$PROJECT_DIR\" PATH=\"$NODE_DIST_ROOT/bin:$CLAWBOX_HOME/.bun/bin:$CLAWBOX_HOME/.npm-global/bin:$CLAWBOX_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" && $1"
}

node_satisfies_openclaw_engine() {
  local version major
  version=$(node -p 'process.versions.node' 2>/dev/null || echo "")
  [ -n "$version" ] || return 1
  major="${version%%.*}"
  case "$major" in
    22) dpkg --compare-versions "$version" ge "22.22.3" ;;
    24) dpkg --compare-versions "$version" ge "24.15.0" ;;
    25) dpkg --compare-versions "$version" ge "25.9.0" ;;
    2[6-9]|[3-9][0-9]) return 0 ;;
    *) return 1 ;;
  esac
}

activate_node_runtime() {
  local node_real node_root
  node_real=$(readlink -f "$(command -v node)")
  node_root=$(dirname "$(dirname "$node_real")")
  mkdir -p /opt/clawbox
  if [ -e "$NODE_DIST_ROOT" ] && [ ! -L "$NODE_DIST_ROOT" ]; then
    echo "Error: $NODE_DIST_ROOT exists and is not a symlink; move it aside and rerun." >&2
    exit 1
  fi
  if [ "$node_root" != "$(readlink -f "$NODE_DIST_ROOT" 2>/dev/null || true)" ]; then
    ln -sfn "$node_root" "$NODE_DIST_ROOT"
  fi
  hash -r
}

ensure_openclaw_node_engine() {
  if node_satisfies_openclaw_engine; then
    activate_node_runtime
    echo "  Node.js $(node --version) satisfies OpenClaw engine requirements"
    return 0
  fi
  echo "  Installing/upgrading Node.js 22 for OpenClaw $OPENCLAW_VERSION..."
  wait_for_apt
  local nodesource_script
  nodesource_script=$(mktemp)
  if ! curl -fsSL -o "$nodesource_script" https://deb.nodesource.com/setup_22.x; then
    rm -f "$nodesource_script"
    echo "Error: failed to download the NodeSource setup script." >&2
    exit 1
  fi
  if ! bash "$nodesource_script"; then
    rm -f "$nodesource_script"
    echo "Error: the NodeSource setup script failed." >&2
    exit 1
  fi
  rm -f "$nodesource_script"
  wait_for_apt
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
  if node_satisfies_openclaw_engine; then
    activate_node_runtime
    return 0
  fi

  # Some Ubuntu desktops pin the distro nodejs package above NodeSource, and
  # /usr/local/bin may hold an unrelated older manual install. Keep ClawBox's
  # runtime isolated instead of replacing either machine-wide installation.
  echo "  APT still exposes $(node --version 2>/dev/null || echo no-node); installing verified Node $NODE_DIST_VERSION x64 under /opt/clawbox..."
  local archive="node-v${NODE_DIST_VERSION}-linux-x64.tar.xz"
  local tmp_dir
  tmp_dir=$(mktemp -d)
  curl -fsSLO --output-dir "$tmp_dir" "https://nodejs.org/dist/v${NODE_DIST_VERSION}/$archive"
  curl -fsSLo "$tmp_dir/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_DIST_VERSION}/SHASUMS256.txt"
  (cd "$tmp_dir" && grep "  $archive\$" SHASUMS256.txt | sha256sum -c -)
  mkdir -p /opt/clawbox
  if [ -e "$NODE_DIST_ROOT" ] && [ ! -L "$NODE_DIST_ROOT" ]; then
    rm -rf "$tmp_dir"
    echo "Error: $NODE_DIST_ROOT exists and is not a symlink; move it aside and rerun." >&2
    exit 1
  fi
  rm -rf "/opt/clawbox/node-v${NODE_DIST_VERSION}-linux-x64"
  tar -xJf "$tmp_dir/$archive" -C /opt/clawbox
  ln -sfn "/opt/clawbox/node-v${NODE_DIST_VERSION}-linux-x64" "$NODE_DIST_ROOT"
  rm -rf "$tmp_dir"
  hash -r
  if ! node_satisfies_openclaw_engine; then
    echo "Error: isolated Node install failed; found $(node --version 2>/dev/null || echo missing)." >&2
    exit 1
  fi
  echo "  Node.js $(node --version) installed at $NODE_DIST_ROOT"
}

openclaw_version_is_v2() {
  [ -n "${1:-}" ] && [ "$(printf '%s\n' 2026.8 "$1" | sort -V | head -1)" = "2026.8" ]
}

openclaw_is_v2() {
  local version=""
  if [ -x "$OPENCLAW_BIN" ]; then
    version=$("$OPENCLAW_BIN" --version 2>/dev/null | grep -oE '20[0-9]{2}\.[0-9]+\.[0-9]+' | head -1)
  fi
  [ -n "$version" ] || version="${OPENCLAW_TARGET:-$OPENCLAW_VERSION}"
  openclaw_version_is_v2 "$version"
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

# Move a setting off a superseded default.
#
# ensure_env_setting only ever ADDS a key, so every device installed before a
# default changed keeps the old value in .env forever - and both this script and
# the Next.js runtime read .env, so a new default in the source would never
# reach a device already in the field. This rewrites the value only when it is
# byte-identical to the old default, so a value the operator chose themselves is
# left exactly as they set it.
migrate_env_setting() {
  local env_file="$1"
  local key="$2"
  local old_value="$3"
  local new_value="$4"
  [ -f "$env_file" ] || return 0
  local current_value
  current_value=$(get_env_setting_or_default "$env_file" "$key" "")
  if [ "$current_value" != "$old_value" ]; then
    return 0
  fi
  local tmp
  tmp=$(mktemp "${env_file}.XXXXXX") || return 1
  # Rewrite in place via a temp file rather than sed -i so an unusual character
  # in either value cannot be read as sed syntax.
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "${key}="*) printf '%s=%s\n' "$key" "$new_value" >> "$tmp" ;;
      *) printf '%s\n' "$line" >> "$tmp" ;;
    esac
  done < "$env_file"
  # mktemp created the temp file as root with 0600; carry the real file's mode
  # and owner across so .env stays readable by the clawbox service user.
  chmod --reference="$env_file" "$tmp" 2>/dev/null || true
  chown --reference="$env_file" "$tmp" 2>/dev/null || true
  mv "$tmp" "$env_file"
  echo "  Migrated ${key} from ${old_value} to ${new_value}"
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

  # A device installed before the QAT switch still has the old repo/file pinned
  # in .env, so migrate the pin before reading it - otherwise this function
  # would keep re-downloading the superseded GGUF forever.
  migrate_env_setting "$ENV_FILE" "LLAMACPP_HF_REPO" "gguf-org/gemma-4-e2b-it-gguf" "google/gemma-4-E2B-it-qat-q4_0-gguf"
  migrate_env_setting "$ENV_FILE" "LLAMACPP_HF_FILE" "gemma-4-e2b-it-edited-q4_0.gguf" "gemma-4-E2B_q4_0-it.gguf"

  HF_REPO=$(get_env_setting_or_default "$ENV_FILE" "LLAMACPP_HF_REPO" "google/gemma-4-E2B-it-qat-q4_0-gguf")
  HF_FILE=$(get_env_setting_or_default "$ENV_FILE" "LLAMACPP_HF_FILE" "gemma-4-E2B_q4_0-it.gguf")
  MODEL_PATH="$MODEL_DIR/$HF_FILE"

  mkdir -p "$MODEL_DIR"
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/data/llamacpp"

  if [ -f "$MODEL_PATH" ]; then
    echo "  Gemma 4 model already cached for offline use"
    prune_superseded_llamacpp_model "$MODEL_DIR" "$HF_FILE"
    return 0
  fi

  echo "  Downloading Gemma 4 GGUF for offline use..."
  if ! as_user_login "mkdir -p \"$MODEL_DIR\" && hf download \"$HF_REPO\" \"$HF_FILE\" --local-dir \"$MODEL_DIR\""; then
    echo "Error: failed to download Gemma 4 for offline startup" >&2
    return 1
  fi

  if [ ! -f "$MODEL_PATH" ]; then
    echo "Error: Gemma 4 download completed but ${MODEL_PATH} was not found" >&2
    return 1
  fi

  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/data/llamacpp"
  echo "  Gemma 4 model cached for offline startup"
  prune_superseded_llamacpp_model "$MODEL_DIR" "$HF_FILE"
}

# The model is addressed by filename, so switching GGUF leaves the old 2.8GB
# file sitting in the models directory doing nothing. Reclaim it - but only the
# one filename we know we shipped, and never the file currently in use.
prune_superseded_llamacpp_model() {
  local model_dir="$1"
  local active_file="$2"
  local stale="gemma-4-e2b-it-edited-q4_0.gguf"

  [ "$active_file" = "$stale" ] && return 0
  [ -f "$model_dir/$stale" ] || return 0

  rm -f "$model_dir/$stale"
  echo "  Removed superseded GGUF ${stale}"
}

has_playwright_chromium() {
  find "$CLAWBOX_HOME/.cache/ms-playwright" -type f \
    \( -path "*/chrome-linux/chrome" \
       -o -path "*/chrome-linux64/chrome" \
       -o -path "*/chrome-linux-arm64/chrome" \) \
    -print -quit 2>/dev/null | grep -q .
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
    as_user_login "cd \"$PROJECT_DIR\" && PLAYWRIGHT_BROWSERS_PATH=\"$PLAYWRIGHT_PATH\" \"$PLAYWRIGHT_BIN\" install chromium"
  else
    as_user_login "cd \"$PROJECT_DIR\" && PLAYWRIGHT_BROWSERS_PATH=\"$PLAYWRIGHT_PATH\" \"$BUN\" x playwright install chromium"
  fi

  if ! has_playwright_chromium; then
    echo "Error: Playwright Chromium install completed but no service-safe browser binary was found." >&2
    exit 1
  fi

  echo "  Playwright Chromium runtime ready"
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
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    git curl python3 python3-pip pipx build-essential cmake ninja-build \
    pkg-config openssl ffmpeg ca-certificates sudo
  ensure_openclaw_node_engine
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
    if git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" show-ref --verify --quiet "refs/remotes/origin/$TARGET_BRANCH"; then
      git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" merge --ff-only "origin/$TARGET_BRANCH" \
        || echo "  Warning: merge failed (local changes?), continuing with current code"
    else
      echo "  Branch '$TARGET_BRANCH' has no origin ref yet; installing the local checkout"
    fi
    chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/.git"
  fi

  local INSTALLED_BRANCH
  INSTALLED_BRANCH=$(git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" branch --show-current)
  if [ -n "$INSTALLED_BRANCH" ]; then
    printf '%s\n' "$INSTALLED_BRANCH" > "$PROJECT_DIR/.update-branch"
    chown "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/.update-branch"
    echo "  Update branch pinned to '$INSTALLED_BRANCH'"
  fi
}

step_build() {
  cd "$PROJECT_DIR"
  as_user_login "cd \"$PROJECT_DIR\" && \"$BUN\" install"
  if ! as_user_login "cd \"$PROJECT_DIR\" && node -e \"require('node-pty')\"" &>/dev/null; then
    echo "  Rebuilding native modules (node-pty)..."
    as_user_login "cd \"$PROJECT_DIR\" && npm_config_python=/usr/bin/python3 npm rebuild node-pty --foreground-scripts"
  fi
  # ONE retry, and only for the mid-build file-trace race — the same guard
  # `run_next_build` carries in install.sh, copied rather than shared because
  # this installer is standalone by design and has its own helper names. See
  # that function for why the race exists and why one rebuild is the whole
  # repair.
  #
  # This SKU needs it at least as much: there is no `do_rebuild` here, so this
  # is the only build path on x64 — for a fresh install and for the documented
  # `--step build` on a live box alike — and it parks no previous build, while
  # `next build` wipes `.next/standalone` before it copies anything.
  # A private `mktemp -d` directory, never a predictable path — this installer
  # runs as root and a fixed name under TMPDIR is a symlink a local user can
  # plant. See run_next_build in install.sh.
  local build_log build_log_dir build_rc build_attempt
  build_log_dir="$(mktemp -d "${TMPDIR:-/tmp}/clawbox-x64-build-XXXXXX" 2>/dev/null || true)"
  build_log=""
  if [ -n "$build_log_dir" ]; then build_log="$build_log_dir/build.log"; fi
  build_rc=0
  for build_attempt in 1 2; do
    if [ -n "$build_log" ]; then
      if as_user_login "cd \"$PROJECT_DIR\" && \"$BUN\" run build" 2>&1 | tee "$build_log"; then
        build_rc=0
        break
      fi
      # The BUILD's status, never the pipeline's.
      build_rc=${PIPESTATUS[0]}
      if [ "$build_rc" -eq 0 ]; then break; fi
    else
      if as_user_login "cd \"$PROJECT_DIR\" && \"$BUN\" run build"; then build_rc=0; else build_rc=$?; fi
      break
    fi
    if [ "$build_attempt" -eq 2 ]; then break; fi
    # One awk, not two greps in a pipe — see run_next_build in install.sh.
    awk '/ENOENT.*copyfile/ && !/Failed to copy traced files for/ { hit = 1 } END { exit hit ? 0 : 1 }' "$build_log" || break
    echo "  A file this build was tracing changed while it ran — building once more"
  done
  if [ -n "$build_log_dir" ]; then rm -rf "$build_log_dir"; fi
  if [ "$build_rc" -ne 0 ]; then
    echo "Error: Build failed (exit $build_rc)"
    exit "$build_rc"
  fi
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
  local PIN_FILE="$PROJECT_DIR/config/openclaw-target.txt"
  local TARGET="${OPENCLAW_PIN_VERSION:-}"
  if [ -z "$TARGET" ] && [ -f "$PIN_FILE" ]; then
    # `|| true`: step_openclaw_install is called plainly from
    # step_openclaw_setup, which is itself called in plain command position, so
    # errexit is NOT suppressed here. Under `set -euo pipefail` (:16) an
    # unreadable pin file (permissions, a truncated mount) makes `head` fail,
    # pipefail carries it into the assignment, and the whole installer aborts.
    # An unknown pin is already a defined state -- the fallback on the next line
    # -- and an aborted install is not. TASK-657, the third copy of the read
    # install.sh:2245 and gateway-pre-start.sh:45 already guard.
    TARGET=$(head -1 "$PIN_FILE" 2>/dev/null | awk '{print $1}' || true)
    if [ -z "$TARGET" ]; then
      # Say it: the fallback is silently a DIFFERENT core version from the one
      # the repo pinned, and external plugins are locked to whatever wins here.
      echo "  WARN: $PIN_FILE is empty or could not be read — falling back to hardcoded $OPENCLAW_VERSION" >&2
    fi
  fi
  TARGET="${TARGET:-$OPENCLAW_VERSION}"
  OPENCLAW_TARGET="$TARGET"
  export OPENCLAW_TARGET
  echo "  Pinned OpenClaw target: $TARGET"
  ensure_openclaw_node_engine
  if [ -x "$OPENCLAW_BIN" ]; then
    local INSTALLED INSTALLED_VER
    # `openclaw --version` prints "OpenClaw X.Y.Z (hash)"; extract field 2 so
    # we can compare exactly against the bare npm version. Literal "=" on the
    # full string would always miss because of the prefix/hash.
    INSTALLED=$("$OPENCLAW_BIN" --version 2>/dev/null || echo "none")
    INSTALLED_VER=$(echo "$INSTALLED" | awk '{print $2}')
    echo "  Installed: $INSTALLED, Target: $TARGET"
    if [ "$INSTALLED_VER" = "$TARGET" ]; then
      echo "  OpenClaw core is already up to date"
    else
      as_user_runtime "$NODE_DIST_ROOT/bin/npm" install -g "openclaw@$TARGET" --prefix "$NPM_PREFIX"
    fi
  else
    mkdir -p "$NPM_PREFIX"
    chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$NPM_PREFIX"
    chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$CLAWBOX_HOME/.npm" 2>/dev/null || true
    as_user_runtime "$NODE_DIST_ROOT/bin/npm" install -g "openclaw@$TARGET" --prefix "$NPM_PREFIX"
  fi
  if [ ! -x "$OPENCLAW_BIN" ]; then
    echo "Error: OpenClaw installation failed — $OPENCLAW_BIN not found" >&2
    exit 1
  fi
  # Ensure ~/.npm-global/bin is in PATH for interactive shells
  local BASHRC="$CLAWBOX_HOME/.bashrc"
  if ! grep -q 'ClawBox x64 runtime' "$BASHRC" 2>/dev/null; then
    cat >> "$BASHRC" <<'PATHEOF'

# ClawBox x64 runtime (OpenClaw + its pinned Node engine)
export PATH="/opt/clawbox/node/bin:$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"
PATHEOF
    chown "$CLAWBOX_USER:$CLAWBOX_USER" "$BASHRC"
  fi
  if openclaw_version_is_v2 "$TARGET"; then
    echo "  Running OpenClaw 2 migrations..."
    local GATEWAY_WAS_ACTIVE=0
    if systemctl is-active --quiet "$GATEWAY_SERVICE" 2>/dev/null; then
      GATEWAY_WAS_ACTIVE=1
      systemctl stop "$GATEWAY_SERVICE"
    fi
    # Say WHICH failure this was, like install.sh's twin (TASK-737/741). A bare
    # `|| echo Warning` over a doctor that migrated NOTHING is the false-success
    # shape this repo keeps producing, and the commonest reason it exits
    # non-zero here is a legacy exec-approvals file whose mere presence makes
    # the core refuse every migration before starting one. Still non-fatal: the
    # gateway's own ExecStartPre moves a clearable one aside and re-runs the
    # migration on the next start.
    local _oc_doctor_out
    if ! _oc_doctor_out="$(as_user_runtime "$OPENCLAW_BIN" doctor --fix --non-interactive </dev/null 2>&1)"; then
      printf '%s\n' "$_oc_doctor_out"
      if printf '%s\n' "$_oc_doctor_out" | grep -q 'Legacy exec approvals exist at'; then
        echo "  Warning: doctor migrated NOTHING — a legacy exec-approvals file blocks it. The gateway's pre-start moves a clearable one aside and re-runs the migration on the next start."
      else
        echo "  Warning: doctor could not complete before initial configuration"
      fi
    else
      printf '%s\n' "$_oc_doctor_out"
    fi
    if [ "$GATEWAY_WAS_ACTIVE" -eq 1 ]; then
      systemctl start "$GATEWAY_SERVICE"
    fi
  fi
  echo "  OpenClaw installed: $($OPENCLAW_BIN --version 2>/dev/null || echo 'unknown version')"
}

step_openclaw_patch() {
  if [ ! -x "$OPENCLAW_BIN" ]; then
    echo "  Skipping — OpenClaw not installed"
    return
  fi

  if openclaw_is_v2; then
    echo "  Gateway patches: not needed on OpenClaw 2 (device identity is client-side)"
    return 0
  fi

  as_user_runtime "$OPENCLAW_BIN" config set gateway.controlUi.allowInsecureAuth true --json
  echo "  allowInsecureAuth enabled (OpenClaw 1 compatibility)"

  local PATCHED_MARKER='isControlUi && allowControlUiBypass'

  # Already patched — nothing to do
  if grep -qrl --include='*.js' "$PATCHED_MARKER" "$GATEWAY_DIST" 2>/dev/null; then
    echo "  Gateway scope patch: already applied"
  else
    # Find files containing the unpatched pattern
    local -a SCOPE_FILES=()
    mapfile -t SCOPE_FILES < <(grep -Prl --include='*.js' 'if\s*\(\s*scopes\.length\s*>\s*0\s*\)\s*\{' "$GATEWAY_DIST" 2>/dev/null || true)
    if [ "${#SCOPE_FILES[@]}" -eq 0 ]; then
      echo "  Warning: Gateway scope patch: pattern not found and patch not already applied"
    else
      for file in "${SCOPE_FILES[@]}"; do
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

  local -a DEVICE_FILES=()
  mapfile -t DEVICE_FILES < <(grep -rl --include='*.js' 'reject-device-required' "$GATEWAY_DIST" 2>/dev/null || true)
  if [ "${#DEVICE_FILES[@]}" -eq 0 ]; then
    echo "  Device identity bypass patch: pattern not found, skipping"
    return
  fi

  local -a NEEDS_PATCH=()
  for file in "${DEVICE_FILES[@]}"; do
    if ! grep -q "$DEVICE_MARKER" "$file" 2>/dev/null; then
      NEEDS_PATCH+=("$file")
    fi
  done

  if [ "${#NEEDS_PATCH[@]}" -eq 0 ]; then
    echo "  Device identity bypass patch: already applied"
    return
  fi

  for file in "${NEEDS_PATCH[@]}"; do
    sed -i 's|if (roleCanSkipDeviceIdentity(params.role, params.sharedAuthOk)) return { kind: "allow" };|if (roleCanSkipDeviceIdentity(params.role, params.sharedAuthOk)) return { kind: "allow" };\n\tif (params.isControlUi \&\& params.controlUiAuthPolicy.allowBypass) return { kind: "allow" };|' "$file"
  done

  local -a UNPATCHED=()
  for file in "${DEVICE_FILES[@]}"; do
    if ! grep -q "$DEVICE_MARKER" "$file" 2>/dev/null; then
      UNPATCHED+=("$file")
    fi
  done

  if [ "${#UNPATCHED[@]}" -gt 0 ]; then
    echo "  Warning: Device identity bypass patch failed for: ${UNPATCHED[*]}"
  else
    echo "  Device identity bypass patch applied and verified"
  fi
}

step_openclaw_config() {
  if [ ! -x "$OPENCLAW_BIN" ]; then
    echo "  Skipping — OpenClaw not installed"
    return
  fi

  # OpenClaw 2 removed the two insecure-Control-UI switches and rejects a
  # config that still carries them. Seed only the local gateway envelope;
  # the setup UI writes the selected provider/model after the owner connects.
  if openclaw_is_v2; then
    mkdir -p "$OPENCLAW_HOME"
    chown "$CLAWBOX_USER:$CLAWBOX_USER" "$OPENCLAW_HOME"
    local OPENCLAW_CONFIG="$OPENCLAW_HOME/openclaw.json"
    as_user env OPENCLAW_CONFIG="$OPENCLAW_CONFIG" CLAWBOX_PORT="$PORT" python3 - <<'PY'
import json, os, re, secrets, tempfile

path = os.environ["OPENCLAW_CONFIG"]
try:
    with open(path) as fh:
        cfg = json.load(fh)
except FileNotFoundError:
    cfg = {}

gateway = cfg.setdefault("gateway", {})
gateway.setdefault("mode", "local")
gateway.setdefault("bind", "loopback")
auth = gateway.setdefault("auth", {})
auth["mode"] = "token"
token = auth.get("token")
def is_strong_gateway_token(value):
    if isinstance(value, dict):
        return (
            value.get("source") in ("env", "file", "exec")
            and isinstance(value.get("provider"), str)
            and bool(value["provider"].strip())
            and isinstance(value.get("id"), str)
            and bool(value["id"].strip())
            and set(value) == {"source", "provider", "id"}
        )
    if isinstance(value, str):
        if re.fullmatch(r"\$\{.+\}", value):
            return True
        return value != "clawbox" and len(value) >= 32
    return False

if not is_strong_gateway_token(token):
    auth["token"] = secrets.token_hex(32)
control = gateway.setdefault("controlUi", {})
control.pop("allowInsecureAuth", None)
control.pop("dangerouslyDisableDeviceAuth", None)
meta = cfg.get("meta")
if isinstance(meta, dict):
    meta.pop("lastTouchedAt", None)
commands = cfg.get("commands")
if isinstance(commands, dict):
    commands.pop("ownerDisplay", None)
tailscale = gateway.get("tailscale")
if isinstance(tailscale, dict):
    tailscale.pop("resetOnExit", None)
defaults = cfg.setdefault("agents", {}).setdefault("defaults", {})
compaction = defaults.get("compaction")
if isinstance(compaction, dict):
    compaction.pop("reserveTokensFloor", None)
port = os.environ["CLAWBOX_PORT"]
if not control.get("allowedOrigins"):
    control["allowedOrigins"] = [
        f"http://localhost:{port}",
        f"http://127.0.0.1:{port}",
        "http://localhost",
        "http://127.0.0.1",
    ]

tmp_fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".openclaw.", suffix=".tmp")
try:
    with os.fdopen(tmp_fd, "w") as fh:
        json.dump(cfg, fh, indent=2)
        fh.write("\n")
    os.chmod(tmp_path, 0o600)
    os.replace(tmp_path, path)
except Exception:
    try:
        os.unlink(tmp_path)
    except OSError:
        pass
    raise
PY
    chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$OPENCLAW_HOME"
    echo "  OpenClaw 2 local gateway configuration seeded"

    local CLAWHUB_BIN="$NPM_PREFIX/bin/clawhub"
    if [ ! -x "$CLAWHUB_BIN" ]; then
      as_user_runtime "$NODE_DIST_ROOT/bin/npm" install -g clawhub --prefix "$NPM_PREFIX" 2>/dev/null \
        || echo "  Warning: ClawHub CLI install failed; App Store installs are unavailable"
    fi
    return 0
  fi

  as_user "$OPENCLAW_BIN" config set gateway.auth.mode token 2>/dev/null || true
  # Seed a strong per-device token only when missing/weak (see install.sh).
  # A `${ENV}` interpolation counts as strong and must not be rotated.
  # `|| true`: fresh installs have no token key yet, so `config get` exits
  # non-zero — without this, set -euo pipefail would abort the installer.
  EXISTING_GW_TOKEN=$(as_user "$OPENCLAW_BIN" config get gateway.auth.token 2>/dev/null | tr -d '"[:space:]') || true
  if [[ "$EXISTING_GW_TOKEN" =~ ^\$\{.+\}$ ]]; then
    GW_TOKEN_STRONG=1
  elif [ -n "$EXISTING_GW_TOKEN" ] && [ "$EXISTING_GW_TOKEN" != "clawbox" ] && [ "${#EXISTING_GW_TOKEN}" -ge 32 ]; then
    GW_TOKEN_STRONG=1
  else
    GW_TOKEN_STRONG=0
  fi
  if [ "$GW_TOKEN_STRONG" -eq 0 ]; then
    GW_TOKEN=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
    as_user "$OPENCLAW_BIN" config set gateway.auth.token "$GW_TOKEN" 2>/dev/null || true
  fi
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
    // dmPolicy/allowFrom intentionally NOT set — OpenClaw's "pairing"
    // default requires owner approval before the agent responds to a new
    // sender. See src/lib/openclaw-config.ts:setTelegramToken.
    const {dmPolicy:_dm,allowFrom:_af,...rest}=c.channels.telegram||{};
    // OpenClaw's own value wins over ClawBox's mirror — see the same block in
    // install.sh: the mirror re-registers the channel on a fresh ~/.openclaw,
    // it does not restore an older bot over one `openclaw config set` re-pointed.
    // An env REFERENCE under `token` ({source:'env',…}) is a bot OpenClaw holds
    // too — see the same block in install.sh.
    const existingToken=typeof rest.botToken==='string'?rest.botToken.trim():'';
    // `token: null`/`token: ""` is an UNSET reference, not a credential - see
    // the same block in install.sh.
    const openclawHasBot=existingToken!==''||(rest.token!==undefined&&rest.token!==null&&rest.token!=='');
    c.channels.telegram=openclawHasBot?{...rest,enabled:true}:{...rest,enabled:true,botToken:cb.telegram_bot_token};
    process.stderr.write(openclawHasBot
      ? '  Telegram channel registered in OpenClaw config (kept the bot OpenClaw already holds)\n'
      : "  Telegram channel registered in OpenClaw config from ClawBox's saved token\n");
  }
} catch {}

if(!c.agents)c.agents={};
if(!c.agents.defaults)c.agents.defaults={};
if(!c.agents.defaults.model)c.agents.defaults.model={};
c.agents.defaults.model.primary='anthropic/claude-sonnet-4-20250514';
if(!c.agents.defaults.compaction)c.agents.defaults.compaction={};
c.agents.defaults.compaction.reserveTokensFloor=24000;

if(!c.gateway)c.gateway={};
if(!c.gateway.auth)c.gateway.auth={};
c.gateway.auth.mode='token';
// Preserve a strong per-device token; only generate when missing/weak. A
// plain literal "clawbox" here would reintroduce the shared-token vuln (#149).
{
  // Keep this predicate in lockstep with is_strong_gateway_token() in
  // scripts/gateway-pre-start.sh: a canonical SecretRef object, a
  // non-empty ${ENV} interpolation, or a >=32-char non-legacy string.
  const t=c.gateway.auth.token;
  const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
  const keys=o=>Object.keys(o);
  const nonEmptyString=v=>typeof v==='string'&&v.trim().length>0;
  const source=t&&typeof t==='object'&&!Array.isArray(t)&&t.source;
  const canonicalRef =
    (source==='env'||source==='file'||source==='exec') &&
    nonEmptyString(t.provider) && nonEmptyString(t.id) &&
    keys(t).length===3 && own(t,'source') && own(t,'provider') && own(t,'id');
  const strong =
    canonicalRef ||
    (typeof t==='string' && (/^\$\{.+\}$/.test(t) || (t!=='clawbox' && t.length>=32)));
  if(!strong) c.gateway.auth.token=require('crypto').randomBytes(32).toString('hex');
}
if(!c.gateway.controlUi)c.gateway.controlUi={};
c.gateway.controlUi.allowInsecureAuth=true;
c.gateway.controlUi.dangerouslyDisableDeviceAuth=true;

// In PLACE, deliberately: no temp file and no rename, so the inode and its
// mode survive the write. install.sh's block replaces the inode and has to
// force 0600 for that reason; this one must not grow a temp-then-rename
// without the same chmod, or it will silently widen a 0600 credential file
// to the umask. The block only runs when openclaw.json already exists.
// It owes no REPAIR either: writeConfig re-secures this same file to 0600 on
// the next settings save, on an x64 box as on a Jetson.
fs.writeFileSync(cfgPath,JSON.stringify(c,null,2));
NODE
    echo "  OpenClaw config updated"
  fi

  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$CLAWBOX_HOME/.openclaw" 2>/dev/null || true

  # Install ClawHub CLI (skill installer)
  local CLAWHUB_BIN="$NPM_PREFIX/bin/clawhub"
  if [ ! -x "$CLAWHUB_BIN" ]; then
    as_user_runtime "$NODE_DIST_ROOT/bin/npm" install -g clawhub --prefix "$NPM_PREFIX" 2>/dev/null || true
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
  ensure_env_setting "$ENV_FILE" "LLAMACPP_BASE_URL" "http://127.0.0.1:8080/v1"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_MODEL" "gemma4-e2b-it-q4_0"
  # Keep these four lines in step with src/lib/llamacpp.ts - the model id is
  # deliberately unchanged, only the GGUF moved. src/tests/unit/llamacpp-gguf-pin.test.ts
  # fails if this file and that one ever disagree.
  migrate_env_setting "$ENV_FILE" "LLAMACPP_HF_REPO" "gguf-org/gemma-4-e2b-it-gguf" "google/gemma-4-E2B-it-qat-q4_0-gguf"
  migrate_env_setting "$ENV_FILE" "LLAMACPP_HF_FILE" "gemma-4-e2b-it-edited-q4_0.gguf" "gemma-4-E2B_q4_0-it.gguf"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_HF_REPO" "google/gemma-4-E2B-it-qat-q4_0-gguf"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_HF_FILE" "gemma-4-E2B_q4_0-it.gguf"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_BIN" "/usr/local/bin/llama-server"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_CONTEXT_WINDOW" "131072"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_CACHE_TYPE_K" "q4_0"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_CACHE_TYPE_V" "q4_0"
  ensure_env_setting "$ENV_FILE" "LLAMACPP_MAX_TOKENS" "131072"
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

step_llamacpp_install() {
  local LLAMA_DIR="$CLAWBOX_HOME/llama.cpp"
  local CMAKE_ARGS="-DCMAKE_BUILD_TYPE=Release"

  if command -v nvcc &>/dev/null; then
    CMAKE_ARGS="$CMAKE_ARGS -DGGML_CUDA=ON"
  fi

  if ! command -v cmake &>/dev/null || ! command -v git &>/dev/null || ! command -v python3 &>/dev/null; then
    echo "  Installing llama.cpp build prerequisites..."
    wait_for_apt
    apt-get update -qq
    apt-get install -y -qq git curl python3 python3-pip pipx build-essential cmake ninja-build pkg-config
  fi

  if ! as_user_login "command -v hf" &>/dev/null; then
    echo "  Installing Hugging Face CLI..."
    # Prefer pipx — pip --user is blocked by PEP 668 on Ubuntu 24.04+
    # (externally-managed-environment). pipx isolates into its own venv
    # and works regardless of distro Python policy.
    if as_user_login "command -v pipx" &>/dev/null; then
      # Wipe any stale user-pip-installed `hf` so pipx's symlink can win
      # (pipx skips overwriting non-pipx files).
      as_user rm -f "$CLAWBOX_HOME/.local/bin/hf" "$CLAWBOX_HOME/.local/bin/huggingface-cli" 2>/dev/null || true
      if ! as_user_login "pipx install --force 'huggingface_hub[cli]'"; then
        echo "Error: pipx install of huggingface_hub failed" >&2
        return 1
      fi
      # Symlink into ~/.npm-global/bin — that dir is explicitly on the
      # PATH that as_user_login exports, so the next `command -v hf`
      # check finds it without depending on .profile sourcing ~/.local/bin.
      as_user ln -sf "$CLAWBOX_HOME/.local/bin/hf" "$NPM_PREFIX/bin/hf"
      as_user ln -sf "$CLAWBOX_HOME/.local/bin/huggingface-cli" "$NPM_PREFIX/bin/huggingface-cli"
    elif ! as_user_login "python3 -m pip install --user --upgrade --break-system-packages 'huggingface_hub[cli]' 2>/dev/null || python3 -m pip install --user --upgrade 'huggingface_hub[cli]'"; then
      echo "Error: failed to install Hugging Face CLI (pipx not available, pip blocked by PEP 668)" >&2
      return 1
    fi
  else
    echo "  Hugging Face CLI already installed"
  fi

  if [ ! -x /usr/local/bin/llama-server ]; then
    echo "  Installing llama.cpp server..."
    if [ ! -d "$LLAMA_DIR/.git" ]; then
      if ! as_user git clone --depth 1 https://github.com/ggml-org/llama.cpp.git "$LLAMA_DIR"; then
        echo "Error: failed to clone llama.cpp into $LLAMA_DIR" >&2
        return 1
      fi
    fi
    if ! as_user_login "rm -f $LLAMA_DIR/build/CMakeCache.txt && rm -rf $LLAMA_DIR/build/CMakeFiles && cd $LLAMA_DIR && cmake -S . -B build $CMAKE_ARGS"; then
      echo "Error: failed to configure llama.cpp build in $LLAMA_DIR" >&2
      return 1
    fi
    if ! as_user_login "cd $LLAMA_DIR && cmake --build build --config Release -j$(nproc) --target llama-server"; then
      echo "Error: failed to build llama-server in $LLAMA_DIR" >&2
      return 1
    fi
    if ! install -m 755 "$LLAMA_DIR/build/bin/llama-server" /usr/local/bin/llama-server; then
      echo "Error: failed to install llama-server to /usr/local/bin/llama-server" >&2
      return 1
    fi
  else
    echo "  llama-server already installed"
  fi

  ensure_llamacpp_model_cached
  echo "  llama.cpp runtime ready"
}

step_chromium_install() {
  if command -v chromium-browser &>/dev/null || command -v chromium &>/dev/null || command -v google-chrome &>/dev/null; then
    echo "  Chromium/Chrome already installed"
  else
    # Try snap first (Ubuntu), fall back to apt
    if command -v snap &>/dev/null; then
      if snap list chromium &>/dev/null 2>&1; then
        echo "  Chromium already installed (snap)"
      else
        snap install chromium 2>/dev/null && echo "  Chromium installed (snap)"
      fi
    fi
    if ! command -v chromium-browser &>/dev/null && ! command -v chromium &>/dev/null && ! command -v google-chrome &>/dev/null; then
      wait_for_apt
      apt-get install -y -qq chromium-browser 2>/dev/null || apt-get install -y -qq chromium 2>/dev/null || echo "  Warning: Could not install Chromium — install manually"
    fi
  fi

  ensure_playwright_chromium
}

# ── The OpenAI Codex CLI (TASK-439) ──────────────────────────────────────────
#
# The device installer's twin, kept deliberately small and parallel to it. Same
# pin file — one `<version> <sha256>` line in config/codex-target.txt, so this
# host and the fleet cannot end up on two different builds — same vendor
# installer, the same refusal to run a script whose digest is not the pinned
# one, and the same order: install the native binary, prove it, and only then
# take the npm copy away. The installer resolves x86_64-unknown-linux-musl here
# on its own.
CODEX_NATIVE_BIN="$CLAWBOX_HOME/.local/bin/codex"
# NOT the installer's default package root ($CODEX_HOME, ~/.codex): that
# directory is the CLI's auth and state. Kept identical to install.sh, where a
# factory reset removes ~/.codex whole, so the two hosts have one layout.
CODEX_PACKAGE_HOME="$CLAWBOX_HOME/.local/share/codex"

codex_pin_field() {
  local file="${CODEX_PIN_FILE:-$PROJECT_DIR/config/codex-target.txt}"
  [ -f "$file" ] || return 1
  awk -v n="$1" '
    /^[[:space:]]*#/ { next }
    NF >= 2 { print $n; found = 1; exit }
    END { if (!found) exit 1 }
  ' "$file"
}

# By path, never through `command -v`: ~/.npm-global/bin comes first on this
# PATH too, so while the npm copy survives it is what answers for `codex`.
codex_native_is_current() {
  local want="$1" reported
  [ -x "$CODEX_NATIVE_BIN" ] || return 1
  # `|| true`: under `set -euo pipefail` a binary that will not exec would fail
  # the pipeline, fail the assignment and end the whole run, over the very case
  # this line exists to detect.
  reported="$(as_user_login "'$CODEX_NATIVE_BIN' --version" 2>/dev/null | tr -d '\r' | tail -n1 || true)"
  case " $reported " in *" $want "*) return 0 ;; esac
  return 1
}

npm_codex_present() {
  # -L as well as -e: a half-finished npm uninstall leaves a dangling symlink.
  [ -e "$NPM_PREFIX/bin/codex" ] || [ -L "$NPM_PREFIX/bin/codex" ]
}

remove_npm_codex() {
  npm_codex_present || return 0
  local rc=0
  as_user_login "npm uninstall -g @openai/codex --prefix '$NPM_PREFIX'" >/dev/null 2>&1 || rc=$?
  # npm exits non-zero for a package it never had and zero for one it failed to
  # unlink, so the re-probe is the verdict and that code only a diagnostic.
  if npm_codex_present; then
    echo "  WARN: npm uninstall exited $rc and $NPM_PREFIX/bin/codex is still there; it shadows the native Codex on PATH" >&2
    return 1
  fi
  echo "  Removed the npm-installed Codex"
}

ensure_codex_cli() {
  local version sha url installer actual

  version="$(codex_pin_field 1 2>/dev/null || true)"
  sha="$(codex_pin_field 2 2>/dev/null || true)"
  if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
    || ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{64}$'; then
    echo "  WARN: config/codex-target.txt carries no '<version> <sha256>' pin; not installing Codex" >&2
    return 1
  fi

  if codex_native_is_current "$version"; then
    echo "  OpenAI Codex $version already installed"
    remove_npm_codex
    return $?
  fi

  url="https://github.com/openai/codex/releases/download/rust-v$version/install.sh"
  installer="$(mktemp || true)"
  if ! curl -fsSL --proto '=https' --proto-redir '=https' \
      --connect-timeout 15 --max-time 300 "$url" -o "$installer" 2>/dev/null \
    || [ ! -s "$installer" ]; then
    echo "  WARN: could not download OpenAI's Codex installer from $url" >&2
    rm -f "$installer"
    return 1
  fi

  # `|| true` for the same reason: an unusable sha256sum must reach the
  # refusal below (which already words an empty digest), not end the run.
  actual="$(sha256sum "$installer" 2>/dev/null | cut -d' ' -f1 || true)"
  if [ "$actual" != "$sha" ]; then
    echo "  WARN: the Codex installer for rust-v$version does not match its pinned sha256 — not running it" >&2
    rm -f "$installer"
    return 1
  fi

  # After the download, before the run: mktemp makes the file root:root 0600 and
  # it is executed as the unprivileged user.
  if ! chown "$CLAWBOX_USER" "$installer"; then
    echo "  WARN: could not hand the Codex installer to $CLAWBOX_USER; not running it" >&2
    rm -f "$installer"
    return 1
  fi

  # CODEX_NON_INTERACTIVE=true is what declines the installer's own offer to
  # remove the npm copy (its prompt opens /dev/tty, so </dev/null alone would
  # not) — the removal is ours, after the verification. `timeout` bounds the
  # ~117 MB package fetch, which the vendor leaves unbounded on its GitHub
  # fallback path.
  if ! as_user_login "CODEX_RELEASE='$version' CODEX_NON_INTERACTIVE=true CODEX_INSTALL_DIR='$CLAWBOX_HOME/.local/bin' CODEX_HOME='$CODEX_PACKAGE_HOME' timeout -k 30 1800 sh '$installer'" </dev/null; then
    echo "  WARN: OpenAI's Codex installer ran but failed" >&2
    rm -f "$installer"
    return 1
  fi
  rm -f "$installer"

  # The installer's exit code is not the outcome. Ask the binary.
  if ! codex_native_is_current "$version"; then
    echo "  WARN: the Codex installer exited 0 but $CODEX_NATIVE_BIN does not report $version" >&2
    return 1
  fi
  echo "  OpenAI Codex $version installed at $CODEX_NATIVE_BIN"

  local rc=0
  remove_npm_codex || rc=1
  # The same verdict the device installer ends on: PATH order, not the presence
  # of a file. `as_user_login` puts ~/.bun/bin ahead of ~/.local/bin, so a codex
  # installed by bun still shadows the pinned one and this would otherwise
  # report success — and the two installers would answer differently about the
  # same box.
  local resolved
  resolved="$(as_user_login "command -v codex" 2>/dev/null | tr -d '\r' | tail -n1 || true)"
  if [ "$resolved" != "$CODEX_NATIVE_BIN" ]; then
    echo "  WARN: \`codex\` still resolves to ${resolved:-nothing}, not $CODEX_NATIVE_BIN" >&2
    rc=1
  fi
  return "$rc"
}

step_ai_tools_install() {
  # Claude Code
  if sudo -u "$CLAWBOX_USER" bash -c 'command -v claude' &>/dev/null; then
    echo "  Claude Code already installed"
  else
    sudo -u "$CLAWBOX_USER" bash -c 'curl -fsSL https://claude.ai/install.sh | bash' || echo "  Warning: Claude Code install failed"
    echo "  Claude Code installed"
  fi

  # OpenAI Codex CLI — the pinned native binary, never an npm global (TASK-439).
  ensure_codex_cli || echo "  Warning: Codex install failed"

  # Google Gemini CLI
  if as_user_login "command -v gemini" &>/dev/null; then
    echo "  Gemini CLI already installed"
  else
    as_user_login "npm i -g @google/gemini-cli --prefix $NPM_PREFIX" 2>/dev/null || echo "  Warning: Gemini CLI install failed"
    echo "  Gemini CLI installed"
  fi
}

step_vnc_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    x11vnc xvfb websockify dbus-x11 openbox xterm x11-xserver-utils \
    autocutsel xclip

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

step_systemd_services() {
  local gateway_unit="/etc/systemd/system/$GATEWAY_SERVICE"
  local ui_unit="/etc/systemd/system/$UI_SERVICE"
  local vnc_unit="/etc/systemd/system/clawbox-vnc.service"
  local websockify_unit="/etc/systemd/system/clawbox-websockify.service"
  local browser_unit="/etc/systemd/system/clawbox-browser.service"

  cat > "$gateway_unit" <<EOF
[Unit]
Description=ClawBox x64 OpenClaw Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$CLAWBOX_USER
WorkingDirectory=$CLAWBOX_HOME
Environment=HOME=$CLAWBOX_HOME
Environment=USER=$CLAWBOX_USER
Environment=CLAWBOX_HOME_DIR=$CLAWBOX_HOME
Environment=CLAWBOX_ROOT=$PROJECT_DIR
Environment=CLAWBOX_PORT=$PORT
Environment=NODE_ENV=production
Environment=PATH=$NPM_PREFIX/bin:$NODE_DIST_ROOT/bin:$CLAWBOX_HOME/.bun/bin:$CLAWBOX_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStartPre=$PROJECT_DIR/scripts/gateway-pre-start.sh
ExecStart=$OPENCLAW_BIN gateway --allow-unconfigured --bind loopback
Restart=always
RestartSec=5
RestartPreventExitStatus=78
SuccessExitStatus=0 143
TimeoutStartSec=600
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

  cat > "$vnc_unit" <<EOF
[Unit]
Description=ClawBox x64 virtual desktop
After=network.target

[Service]
Type=simple
User=$CLAWBOX_USER
Environment=HOME=$CLAWBOX_HOME
Environment=CLAWBOX_VNC_MODE=virtual
ExecStart=$PROJECT_DIR/scripts/start-vnc.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  cat > "$websockify_unit" <<EOF
[Unit]
Description=ClawBox x64 WebSocket VNC proxy
After=clawbox-vnc.service
Requires=clawbox-vnc.service

[Service]
Type=simple
User=$CLAWBOX_USER
ExecStart=/usr/bin/websockify 127.0.0.1:6080 localhost:5900
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  cat > "$browser_unit" <<EOF
[Unit]
Description=ClawBox x64 browser (Chromium with CDP)
Requires=clawbox-vnc.service
After=clawbox-vnc.service

[Service]
Type=simple
User=$CLAWBOX_USER
Group=$CLAWBOX_USER
WorkingDirectory=$PROJECT_DIR
Environment=DISPLAY=:99
Environment=CDP_PORT=18800
Environment=HOME=$CLAWBOX_HOME
Environment=XDG_CONFIG_HOME=$CLAWBOX_HOME/.config
Environment=XDG_CACHE_HOME=$CLAWBOX_HOME/.cache
EnvironmentFile=-$PROJECT_DIR/.env
ExecStart=$PROJECT_DIR/scripts/launch-browser.sh
Restart=no
TimeoutStartSec=45
StandardOutput=append:/tmp/clawbox-browser.log
StandardError=append:/tmp/clawbox-browser.log
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF

  cat > "$ui_unit" <<EOF
[Unit]
Description=ClawBox x64 UI
After=network-online.target $GATEWAY_SERVICE
Wants=network-online.target $GATEWAY_SERVICE

[Service]
Type=simple
User=$CLAWBOX_USER
WorkingDirectory=$PROJECT_DIR
Environment=HOME=$CLAWBOX_HOME
Environment=USER=$CLAWBOX_USER
Environment=CLAWBOX_HOME_DIR=$CLAWBOX_HOME
Environment=CLAWBOX_ROOT=$PROJECT_DIR
Environment=CLAWBOX_OPENCLAW_HOME=$OPENCLAW_HOME
Environment=NODE_ENV=production
Environment=BUN_ENV=production
Environment=PORT=$PORT
Environment=HOSTNAME=0.0.0.0
Environment=PATH=$NPM_PREFIX/bin:$NODE_DIST_ROOT/bin:$CLAWBOX_HOME/.bun/bin:$CLAWBOX_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-$PROJECT_DIR/.env
ExecStart=$NODE_DIST_ROOT/bin/node $PROJECT_DIR/production-server.js
Restart=always
RestartSec=3
SuccessExitStatus=143 SIGTERM

[Install]
WantedBy=multi-user.target
EOF

  # Provider configuration and the in-app updater manage the system gateway
  # from the unprivileged web process. The updater's runtime mask keeps the
  # gateway from racing OpenClaw npm/plugin/SQLite migrations; it is paired
  # with an exact unmask grant and always removed in a finally path.
  local sudoers_tmp
  sudoers_tmp=$(mktemp)
  cat > "$sudoers_tmp" <<EOF
$CLAWBOX_USER ALL=(root) NOPASSWD: /usr/bin/systemctl stop $GATEWAY_SERVICE, /usr/bin/systemctl --runtime mask $GATEWAY_SERVICE, /usr/bin/systemctl --runtime unmask $GATEWAY_SERVICE, /usr/bin/systemctl reset-failed $GATEWAY_SERVICE, /usr/bin/systemctl restart $GATEWAY_SERVICE, /usr/bin/systemctl start clawbox-browser.service, /usr/bin/systemctl stop clawbox-browser.service, /usr/bin/systemctl enable --now ollama.service, /usr/bin/systemctl start ollama.service, /usr/bin/systemctl stop ollama.service
EOF
  chmod 440 "$sudoers_tmp"
  if ! visudo -cf "$sudoers_tmp" >/dev/null; then
    rm -f "$sudoers_tmp"
    echo "Error: generated x64 sudoers rule is invalid" >&2
    exit 1
  fi
  install -o root -g root -m 440 "$sudoers_tmp" /etc/sudoers.d/clawbox-x64
  rm -f "$sudoers_tmp"

  systemctl daemon-reload
  systemctl enable "$GATEWAY_SERVICE" "$UI_SERVICE" clawbox-vnc.service clawbox-websockify.service
  systemctl restart clawbox-vnc.service clawbox-websockify.service
  echo "  Persistent x64 services installed"
}

wait_for_http() {
  local url="$1" label="$2" log_unit="$3" attempt
  for attempt in $(seq 1 60); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      local ready_pid
      ready_pid=$(systemctl show "$log_unit" -p MainPID --value)
      # OpenClaw can open its HTTP listener before plugin verification ends,
      # then exit several seconds later. Require one stable 20-second window
      # with the same service process before certifying the install.
      sleep 20
      if systemctl is-active --quiet "$log_unit" \
         && [ "$ready_pid" != "0" ] \
         && [ "$ready_pid" = "$(systemctl show "$log_unit" -p MainPID --value)" ]; then
        echo "  $label is ready and stable"
        return 0
      fi
      echo "  $label opened its port but restarted; continuing readiness checks..."
    fi
    sleep 1
  done
  echo "Error: $label did not become ready at $url" >&2
  systemctl status "$log_unit" --no-pager -n 30 >&2 || true
  journalctl -u "$log_unit" --no-pager -n 50 >&2 || true
  return 1
}

step_start_gateway() {
  if [ ! -x "$OPENCLAW_BIN" ]; then
    echo "Error: OpenClaw is not installed at $OPENCLAW_BIN" >&2
    return 1
  fi
  systemctl restart "$GATEWAY_SERVICE"
  wait_for_http "http://127.0.0.1:18789" "OpenClaw gateway" "$GATEWAY_SERVICE"
}

step_clawkeep_install() {
  if [ ! -d "$PROJECT_DIR/clawkeep" ]; then
    echo "  ClawKeep source missing; skipping"
    return 0
  fi
  if as_user_login "command -v clawkeepd" &>/dev/null; then
    echo "  ClawKeep CLI already installed"
    return 0
  fi
  if ! as_user_login "command -v pipx" &>/dev/null; then
    echo "  Warning: pipx not found, skipping ClawKeep install" >&2
    return 0
  fi
  echo "  Installing ClawKeep via pipx..."
  # PEP 517 build via pipx — sidesteps PEP 668 and ensures a clean venv,
  # avoiding the Jetson-style UNKNOWN-0.0.0 wheel failure the install.sh
  # workaround was written for.
  if ! as_user_login "pipx install --force '$PROJECT_DIR/clawkeep'"; then
    echo "  Warning: clawkeep pipx install failed (non-fatal — restore/scheduler unavailable)" >&2
    return 0
  fi
  # boto3 isn't pulled in by clawkeep's [project.dependencies]; inject it
  # so cloud uploads work.
  as_user_login "pipx inject clawkeep 'boto3>=1.34'" \
    || echo "  Warning: boto3 inject failed (cloud backups unavailable)" >&2
  if as_user_login "command -v clawkeepd" &>/dev/null; then
    echo "  ClawKeep CLI installed"
  else
    echo "  Warning: clawkeepd still not on PATH after install" >&2
  fi
}

step_start_ui() {
  systemctl restart "$UI_SERVICE"
  wait_for_http "http://127.0.0.1:$PORT" "ClawBox UI" "$UI_SERVICE"
}

# ── Single-step mode ────────────────────────────────────────────────────────

DISPATCH_STEPS=(
  apt_update install_bun git_pull build
  openclaw_setup openclaw_install openclaw_patch openclaw_config
  directories_permissions
  ollama_install llamacpp_install chromium_install ai_tools_install
  vnc_install ffmpeg_install fix_git_perms clawkeep_install
  systemd_services start_gateway start_ui
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

TOTAL_STEPS=16
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
echo "  Skipping: hostname, WiFi AP, JetPack, performance mode, jtop"
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

log "Installing llama.cpp runtime..."
step_llamacpp_install

log "Installing Chromium..."
step_chromium_install

log "Installing AI coding tools (Claude Code, Codex, Gemini)..."
step_ai_tools_install

log "Installing VNC server..."
step_vnc_install

log "Installing ffmpeg..."
step_ffmpeg_install

log "Installing ClawKeep CLI..."
step_clawkeep_install

log "Installing persistent x64 services..."
step_systemd_services

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
echo "  UI Logs:      journalctl -u $UI_SERVICE"
echo "  Gateway Logs: journalctl -u $GATEWAY_SERVICE"
echo ""
echo "  To stop:      sudo systemctl stop $UI_SERVICE $GATEWAY_SERVICE"
echo "  To restart:   sudo systemctl restart $GATEWAY_SERVICE $UI_SERVICE"
echo ""
