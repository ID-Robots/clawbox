#!/usr/bin/env bash
# Installed root-owned by build-package.py. Never execute the desktop checkout
# as root: code for privileged steps is this package and its verified mirror.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[ "$(id -u)" -eq 0 ] || exit 77
. /etc/clawbox/x64-integration.env
MIRROR=/var/lib/clawbox/root-exec-mirror
SOURCE=/var/lib/clawbox/x64-update-source
MANIFEST=/usr/local/libexec/clawbox/clawbox-root-manifest.sh
step=${1:-}
[ "$#" -eq 1 ] || exit 64

as_owner() {
  /usr/sbin/runuser -u "$INSTALL_USER" -- /usr/bin/env \
    HOME="$INSTALL_HOME" USER="$INSTALL_USER" \
    XDG_RUNTIME_DIR="/run/user/$INSTALL_UID" \
    CLAWBOX_ROOT="$PROJECT_DIR" CLAWBOX_HOME_DIR="$INSTALL_HOME" \
    CLAWBOX_OPENCLAW_HOME="$INSTALL_HOME/.openclaw" \
    OPENCLAW_STATE_DIR="$INSTALL_HOME/.openclaw" \
    OPENCLAW_CONFIG_PATH="$INSTALL_HOME/.openclaw/openclaw.json" \
    PATH="$NODE_DIR:$NPM_PREFIX/bin:$INSTALL_HOME/.bun/bin:$INSTALL_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
    "$@"
}

refresh_trusted_source() {
  # The branch is DATA. Never trust the user checkout's remote, hooks, objects,
  # or executable files for a root update. Fetch the fixed vendor URL into a
  # root-owned repository and record/mirror those exact bytes.
  local branch
  branch=$(as_owner /usr/bin/python3 -c 'import pathlib; print(pathlib.Path(".update-branch").read_text().strip())' 2>/dev/null) || branch=beta
  [[ "$branch" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] && /usr/bin/git check-ref-format "refs/heads/$branch" || {
    echo 'Error: invalid update branch' >&2; return 1;
  }
  install -d -o root -g root -m 0755 "$SOURCE"
  if [ ! -d "$SOURCE/.git" ]; then /usr/bin/git -C "$SOURCE" init -q; fi
  /usr/bin/env -i HOME=/root PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    /usr/bin/git -c core.hooksPath=/dev/null -C "$SOURCE" fetch --depth=1 \
    https://github.com/ID-Robots/clawbox.git "refs/heads/$branch"
  /usr/bin/git -c core.hooksPath=/dev/null -C "$SOURCE" reset --hard FETCH_HEAD
  "$MANIFEST" --write
  "$MANIFEST" --mirror
  # The unprivileged UI resets to this same remote ref during its rebuild.
  as_owner /usr/bin/git -C "$PROJECT_DIR" fetch origin \
    "+refs/heads/$branch:refs/remotes/origin/$branch"
  [ "$(as_owner /usr/bin/git -C "$PROJECT_DIR" rev-parse "refs/remotes/origin/$branch")" = \
    "$(/usr/bin/git -C "$SOURCE" rev-parse HEAD)" ] || {
    echo 'Error: desktop origin and trusted vendor source disagree' >&2; return 1;
  }
  echo "Trusted x64 updater source refreshed from $branch"
}

apply_timezone() {
  # Read as the owner, with O_NOFOLLOW|O_NONBLOCK and an inode type check: even
  # a racing symlink/FIFO in user-writable data cannot make root read a target.
  local zone
  zone=$(as_owner /usr/bin/python3 - "$PROJECT_DIR/data/timezone.env" <<'PY'
import os, stat, sys
p=sys.argv[1]
try: fd=os.open(p, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
except FileNotFoundError: sys.exit(0)
with os.fdopen(fd) as f:
    if not stat.S_ISREG(os.fstat(f.fileno()).st_mode): raise ValueError("timezone request is not a plain file")
    raw=f.read(512)
if len(raw)>=512: raise ValueError("timezone request is too large")
lines=raw.splitlines()
if len(lines)!=1 or not lines[0].startswith("TIMEZONE="): raise ValueError("invalid timezone request")
print(lines[0][9:])
PY
  )
  [ -n "$zone" ] || { echo 'No timezone requested'; return; }
  /usr/bin/timedatectl list-timezones | /usr/bin/grep -qxF -- "$zone" || {
    echo 'Error: requested timezone is not recognised' >&2; return 1;
  }
  if [ "$(/usr/bin/timedatectl show -p Timezone --value)" != "$zone" ]; then
    /usr/bin/timedatectl set-timezone "$zone"
  fi
  echo "System timezone verified: $zone"
}

install_coding_harness() {
  as_owner /bin/bash "$MIRROR/scripts/x64-migration/install-coding-harness.sh" \
    "$MIRROR/scripts/claude-ds" "$PROJECT_DIR"
}

update_openclaw() {
  local target current
  target=$(head -n 1 "$MIRROR/config/openclaw-target.txt")
  [[ "$target" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || {
    echo 'Error: invalid pinned OpenClaw version' >&2; return 1;
  }
  current=$(as_owner "$NODE_DIR/node" -p "require('$NPM_PREFIX/lib/node_modules/openclaw/package.json').version" 2>/dev/null || true)
  if [ "$current" != "$target" ]; then
    echo "Error: OpenClaw $current -> $target needs a reviewed state snapshot and rollback migration. This desktop integration refuses to replace the core or migrate its database without that recovery plan." >&2
    return 78
  fi
  if [ -x "$INSTALL_HOME/bin/openclaw-patch-backup-sqlite" ]; then
    as_owner "$INSTALL_HOME/bin/openclaw-patch-backup-sqlite" \
      "$NPM_PREFIX/lib/node_modules/openclaw" || return $?
  fi
  if [ -x "$INSTALL_HOME/bin/openclaw-patch-memory-maintenance" ]; then
    as_owner "$INSTALL_HOME/bin/openclaw-patch-memory-maintenance" \
      "$NPM_PREFIX/lib/node_modules/openclaw" || {
        local repair_rc=$?
        echo 'Error: the memory maintenance compatibility repair refused; stopping the core step.' >&2
        return "$repair_rc"
      }
  fi
  # Already on the requested core: validate without rewriting configuration or
  # running a second migration. The existing SQLite state stays untouched.
  as_owner "$NPM_PREFIX/bin/openclaw" config validate --json </dev/null || return $?
  echo "OpenClaw $target already installed; configuration accepted"
}

with_gateway_stopped() {
  local owns_guard=0 was_active=0 rc=0
  exec 8>>/run/clawbox-x64-core.lock
  /usr/bin/flock -w 600 8 || return $?
  if [ ! -d /run/clawbox-gateway-maintenance ]; then
    /usr/local/libexec/clawbox/clawbox-x64-gateway.sh is-active && was_active=1
    /usr/local/libexec/clawbox/clawbox-gateway-maintenance.sh enter
    owns_guard=1
  fi
  # A direct Install/Configure button needs the same serialization as a full
  # update. An outer update owns an existing guard and decides when to restart.
  /usr/bin/systemctl stop clawbox-gateway.service || rc=$?
  # An independently started user unit can outlive an inactive bridge.
  if [ "$rc" -eq 0 ]; then
    /usr/local/libexec/clawbox/clawbox-x64-gateway.sh stop || rc=$?
  fi
  if [ "$rc" -eq 0 ]; then update_openclaw || rc=$?; fi
  if [ "$owns_guard" -eq 1 ]; then
    /usr/local/libexec/clawbox/clawbox-gateway-maintenance.sh leave || return $?
    if [ "$was_active" -eq 1 ]; then /usr/bin/systemctl start clawbox-gateway.service || return $?; fi
  fi
  return "$rc"
}

rebuild_ui() {
  # Build only as the desktop owner. The existing updater records its old
  # BUILD_ID and resumes after this service restart; no PC reboot is needed.
  /usr/bin/systemctl stop clawbox-setup.service
  local rc=0
  as_owner /bin/bash -s -- "$PROJECT_DIR" "$INSTALL_HOME/.bun/bin/bun" <<'SH' || rc=$?
set -euo pipefail
cd "$1"
bun_bin=$2
mkdir -p "$HOME/.cache/clawbox"
backup=$(mktemp -d "$HOME/.cache/clawbox/previous-build.XXXXXX")
if [ -d .next ]; then mv .next "$backup/.next"; fi
restore() {
  rc=$?
  if [ "$rc" -ne 0 ] && [ -d "$backup/.next" ]; then
    rm -rf .next
    mv "$backup/.next" .next
  fi
  rm -rf "$backup"
  exit "$rc"
}
trap restore EXIT
"$bun_bin" install --frozen-lockfile
if ! node -e 'require("node-pty")' >/dev/null 2>&1; then npm rebuild node-pty --foreground-scripts; fi
"$bun_bin" run build
test -s .next/BUILD_ID
test -s .next/standalone/server.js
SH
  /usr/bin/systemctl restart clawbox-setup.service
  return "$rc"
}

install_local_model() {
  local model_dir="$PROJECT_DIR/data/llamacpp/models"
  # This desktop uses hf as Higgsfield's alias; always name the actual CLI.
  as_owner /usr/bin/python3 - "$PROJECT_DIR/.env" "$model_dir" "$INSTALL_HOME" <<'PY'
import os,pathlib,subprocess,sys
env={}
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if '=' in line and not line.lstrip().startswith('#'):
        k,v=line.split('=',1); env[k]=v.strip().strip('"\'')
repo=env.get('LLAMACPP_HF_REPO','google/gemma-4-E2B-it-qat-q4_0-gguf')
name=env.get('LLAMACPP_HF_FILE','gemma-4-E2B_q4_0-it.gguf')
binary=env.get('LLAMACPP_BIN','/usr/local/bin/llama-server')
if not os.access(binary,os.X_OK): raise RuntimeError('the configured x64 llama-server runtime is missing')
if pathlib.Path(name).name!=name or not name.endswith('.gguf'): raise ValueError('invalid model filename')
dest=pathlib.Path(sys.argv[2]); dest.mkdir(parents=True,exist_ok=True)
if not (dest/name).is_file():
    cli=pathlib.Path(sys.argv[3])/'.local/share/pipx/venvs/huggingface-hub/bin/hf'
    subprocess.run([str(cli),'download',repo,name,'--local-dir',str(dest)],check=True)
if not (dest/name).is_file(): raise RuntimeError('model download did not produce the selected file')
print('Selected local model is cached:',name)
PY
}

cd "$PROJECT_DIR"
case "$step" in
  bootstrap_updater)
    refresh_trusted_source
    # Deliver the harness before the core step restarts the user gateway, so
    # its MCP server discovers the newly available coding tools on that start.
    install_coding_harness
    ;;
  set_timezone) apply_timezone ;;
  chpasswd)
    as_owner /usr/bin/python3 - "$PROJECT_DIR/data/.chpasswd-input" <<'PY' | /usr/bin/python3 -I -c '
import subprocess,sys
value=sys.stdin.buffer.read(4097)
if len(value)>4096 or b"\x00" in value or b"\r" in value: raise ValueError("invalid password request")
lines=value.splitlines()
account=sys.argv[1].encode()
if len(lines)!=1 or not lines[0].startswith(account+b":"): raise ValueError("password request must name the desktop owner only")
subprocess.run(["/usr/sbin/chpasswd"],input=lines[0]+b"\n",check=True)
' "$INSTALL_USER"
import os,stat,sys
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
with os.fdopen(fd) as f:
    if not stat.S_ISREG(os.fstat(f.fileno()).st_mode): raise ValueError('password request is not a plain file')
    value=f.read(4096)
if len(value)>=4096: raise ValueError('password request is too large')
print(value,end='')
PY
    as_owner /bin/rm -f "$PROJECT_DIR/data/.chpasswd-input"
    ;;
  fix_git_perms)
    # Every Git operation this package performs in the desktop tree already
    # runs as its owner. Verify instead of root-chowning a mutable path.
    as_owner /usr/bin/python3 - "$PROJECT_DIR" <<'PY'
import os,pathlib,subprocess,sys
base=pathlib.Path(subprocess.check_output(['git','-C',sys.argv[1],'rev-parse','--absolute-git-dir'],text=True).strip())
for parent,dirs,files in os.walk(base):
    if not os.access(parent,os.W_OK|os.X_OK): raise PermissionError(f'Git directory needs owner write access: {parent}')
    for name in files:
        path=pathlib.Path(parent)/name
        if path.lstat().st_uid!=os.getuid(): raise PermissionError(f'Git path is owned by another account: {path}')
for name in ['config','FETCH_HEAD','index','HEAD','shallow','ORIG_HEAD','packed-refs']:
    path=base/name
    if path.exists() and not os.access(path,os.W_OK): raise PermissionError(f'Git metadata needs owner write access: {path}')
print('Desktop Git metadata is writable by its owner')
PY
    ;;
  apt_update)
    /usr/bin/apt-get update -qq
    DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y -qq git curl python3 python3-pip pipx build-essential cmake ninja-build pkg-config openssl ffmpeg ca-certificates sudo
    ;;
  nvidia_jetpack|performance_mode) echo "Skipping $step on this existing x64 desktop" ;;
  chromium_install)
    as_owner /bin/bash -c 'cd "$1"; bunx playwright install chromium' _ "$PROJECT_DIR"
    ;;
  vnc_install|vnc_refresh)
    DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y -qq x11vnc xvfb websockify dbus-x11 openbox xterm x11-xserver-utils autocutsel xclip
    ;;
  ffmpeg_install) DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y -qq ffmpeg ;;
  openclaw_install|openclaw_setup|openclaw_config) with_gateway_stopped ;;
  openclaw_patch) echo 'OpenClaw 2 requires no legacy gateway patch' ;;
  gateway_setup) /usr/bin/systemctl daemon-reload; echo 'Existing user gateway remains managed through the x64 bridge' ;;
  rebuild_reboot) rebuild_ui ;;
  post_update)
    "$MANIFEST" --verify
    "$MANIFEST" --mirror
    install_coding_harness
    apply_timezone
    echo 'x64 root integration and trusted updater source verified'
    ;;
  llamacpp_install) install_local_model ;;
  clawkeep_install)
    as_owner /bin/bash -c 'pipx install --force "$1/clawkeep" && pipx inject clawkeep "boto3>=1.34"' _ "$PROJECT_DIR"
    ;;
  cloudflared_install) test -x /usr/local/bin/cloudflared ;;
  *) echo "Error: $step is not supported by this desktop integration" >&2; exit 64 ;;
esac
