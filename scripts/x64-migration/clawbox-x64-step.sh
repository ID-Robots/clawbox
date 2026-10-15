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

# Install the verified coding harness with the desktop owner's privileges.
install_coding_harness() {
  as_owner /bin/bash "$MIRROR/scripts/x64-migration/install-coding-harness.sh" \
    "$MIRROR/scripts/claude-ds" "$PROJECT_DIR"
}

# ---------------------------------------------------------------------------
# Replacing the OpenClaw core on this desktop.
#
# The pin in the mirror moves past the installed core on every core bump, and
# this step used to refuse that outright for want of a recovery plan. The plan
# is the one the core's own "Rollback and recovery" doc names: a recovery point
# is the matching package, openclaw.json, state/openclaw.sqlite and every
# agents/<id>/agent/openclaw-agent.sqlite, from ONE generation, taken with the
# gateway stopped — and once state has migrated past an older release's schema,
# the supported way back is that recovery point with its matching release.
#
# So, inside the maintenance guard the caller holds (gateway stopped, nothing
# may restart it):
#   1. stage the pinned core in a prefix of its own and gate it on its own
#      `--version` (the core is the authority on its engines) — nothing of the
#      owner's is touched while npm can still fail;
#   2. the recovery point: `backup create --verify --no-include-workspace` by
#      the INSTALLED core (the one that can read this state), which is the
#      verified archive the docs name, beside a plain copy of the exact
#      pre-activation bytes (config, databases, their -wal/-shm) that the
#      automatic rollback puts back;
#   3. the swap, two renames, with the previous core RETAINED beside the live
#      one until the next replacement;
#   4. `doctor --fix --non-interactive` on the new core; a refused or
#      incomplete migration restores the previous core and the snapshot, and
#      the caller then restarts the gateway it stopped — on the core it had.
#
# `openclaw update` is deliberately not used: it restarts and verifies the
# managed service itself, and this package holds the user gateway behind the
# maintenance condition for the whole step, so its activation check could never
# pass and it would roll every update back. Every write into the owner-writable
# core prefix and into the recovery point runs as the owner, never as root.
# ---------------------------------------------------------------------------
CORE_RECOVERY_KEEP=3

core_recovery_root() { printf '%s/backups/openclaw-core-update' "$INSTALL_HOME"; }

installed_openclaw_version() {
  as_owner "$NODE_DIR/node" -p "require('$NPM_PREFIX/lib/node_modules/openclaw/package.json').version" 2>/dev/null || true
}

# A replacement cut short between its two renames leaves the live tree gone and
# the old one set aside: put it back before the core is probed, so a parked
# core is never mistaken for an absent one. A retained previous core beside a
# live one is this package's rollback material and stays; only a stage left
# behind is dropped.
recover_parked_openclaw_core() {
  as_owner /bin/bash -s -- "$NPM_PREFIX" <<'SH'
set -euo pipefail
live=$1/lib/node_modules/openclaw
previous=$1/lib/node_modules/.openclaw-previous
stage=$1/.openclaw-stage
if [ ! -e "$live" ] && [ ! -L "$live" ]; then
  if [ -e "$previous" ] || [ -L "$previous" ]; then
    echo '  An earlier core swap was cut short with the previous OpenClaw core set aside; putting it back'
    mv "$previous" "$live"
  fi
  exit 0
fi
if [ -e "$stage" ]; then
  echo '  Removing the stage an earlier core swap left behind'
  rm -rf "$stage"
fi
SH
}

stage_openclaw_core() {
  local stage=$1 target=$2 out
  as_owner /bin/rm -rf "$stage" || return 1
  as_owner /bin/mkdir -p "$stage" || return 1
  if ! as_owner npm install -g "openclaw@$target" --prefix "$stage" --no-fund --no-audit </dev/null; then
    echo "Error: npm could not install openclaw@$target into the stage; the core on this desktop is untouched" >&2
    as_owner /bin/rm -rf "$stage"; return 1
  fi
  if [ ! -x "$stage/bin/openclaw" ]; then
    echo "Error: npm left no openclaw launcher in the stage; the core on this desktop is untouched" >&2
    as_owner /bin/rm -rf "$stage"; return 1
  fi
  # The staged launcher's own answer is the gate: a core that refuses the Node
  # it is given, or answers nothing, never reaches the live prefix.
  if ! out=$(as_owner "$stage/bin/openclaw" --version 2>&1 </dev/null); then
    printf '%s\n' "$out" >&2
    echo "Error: openclaw@$target is staged but refuses to run with the Node at $NODE_DIR ($(as_owner "$NODE_DIR/node" --version 2>/dev/null || echo unknown)); rebuild this integration package with --node-dir naming a Node the core's engines accept. The core on this desktop is untouched." >&2
    as_owner /bin/rm -rf "$stage"; return 1
  fi
  if [ "$(printf '%s\n' "$out" | awk '$1 == "OpenClaw" { print $2; exit }')" != "$target" ]; then
    echo "Error: the staged openclaw answers '${out:-<nothing>}' to --version, not $target; the core on this desktop is untouched" >&2
    as_owner /bin/rm -rf "$stage"; return 1
  fi
  echo "Staged: $(printf '%s\n' "$out" | awk '$1 == "OpenClaw" { print; exit }')"
}

# The plain half of the recovery point: `snapshot` copies the set the rollback
# needs under <point>/state (paths mirroring the state directory, the config
# under config/openclaw.json) and lists it in snapshot.txt; `restore` puts
# exactly that list back and removes a -wal/-shm the new core added beside a
# database the list holds. Never through a symlink in either direction.
core_state_set() {
  as_owner /usr/bin/python3 -I - "$1" "$INSTALL_HOME/.openclaw" "$2" "$INSTALL_HOME/.openclaw/openclaw.json" <<'PY'
import os, pathlib, shutil, sys
mode, state_dir, snap, config = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4])
manifest = snap / 'snapshot.txt'
def copy(src, dst):
    if src.is_symlink():
        raise SystemExit(f'refusing a symbolic link in the state set: {src}')
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    with open(dst, 'rb') as f:
        os.fsync(f.fileno())
if mode == 'snapshot':
    bases = [state_dir / 'state' / 'openclaw.sqlite', *sorted(state_dir.glob('agents/*/agent/openclaw-agent.sqlite'))]
    entries = []
    if config.exists():
        copy(config, snap / 'config' / 'openclaw.json'); entries.append('config/openclaw.json')
    for base in bases:
        for suffix in ['', '-wal', '-shm']:
            src = pathlib.Path(str(base) + suffix)
            if src.exists():
                rel = src.relative_to(state_dir)
                copy(src, snap / rel); entries.append(str(rel))
    manifest.write_text(''.join(e + '\n' for e in entries))
    print(f'  Snapshot: {len(entries)} files under {snap}')
elif mode == 'restore':
    entries = [e for e in manifest.read_text().splitlines() if e]
    kept = set(entries)
    for rel in entries:
        dst = config if rel == 'config/openclaw.json' else state_dir / rel
        if dst.is_symlink():
            raise SystemExit(f'refusing to restore over a symbolic link: {dst}')
        copy(snap / rel, dst)
    for rel in entries:
        if rel.endswith('.sqlite'):
            for suffix in ['-wal', '-shm']:
                if rel + suffix not in kept:
                    stray = state_dir / (rel + suffix)
                    if stray.exists() and not stray.is_symlink():
                        stray.unlink()
    os.sync()
    print(f'  Restored: {len(entries)} files from {snap}')
else:
    raise SystemExit('unknown mode')
PY
}

make_core_recovery_point() {
  local point=$1 current=$2 target=$3
  as_owner /bin/mkdir -p -m 0700 "$point" "$point/archive" "$point/state" || return 1
  echo "Writing the verified pre-update archive with OpenClaw $current (backup create --verify --no-include-workspace)..."
  if ! as_owner /bin/bash -c 'exec "$1" backup create --verify --no-include-workspace --output "$2" --json </dev/null >"$3" 2>"$4"' _ \
      "$NPM_PREFIX/bin/openclaw" "$point/archive" "$point/backup-create.json" "$point/backup-create.log"; then
    as_owner /bin/cat "$point/backup-create.log" >&2 || true
    echo "Error: openclaw backup create --verify failed; nothing on this desktop was changed (its output is in $point)" >&2
    return 1
  fi
  core_state_set snapshot "$point/state" || {
    echo "Error: the pre-update state could not be copied; nothing on this desktop was changed" >&2
    return 1
  }
  as_owner /bin/bash -c 'cat >"$1"' _ "$point/recovery.txt" <<EOF
OpenClaw core replacement on this desktop: $current -> $target

archive/            verified archive written by OpenClaw $current ("backup create --verify
                    --no-include-workspace"): config, credentials, the state database and every
                    agent database; workspaces left out. backup-create.json is its report.
state/              the exact pre-update bytes the automatic rollback puts back: config/openclaw.json,
                    state/openclaw.sqlite and agents/<id>/agent/openclaw-agent.sqlite with their
                    -wal/-shm, one generation, taken with the gateway stopped; snapshot.txt lists them.
doctor.log          the new core's migration output, once it ran.

The previous core is retained at $NPM_PREFIX/lib/node_modules/.openclaw-previous until the next
core replacement. To go back by hand, with the gateway stopped
(sudo systemctl stop clawbox-gateway.service):
  1. copy state/ back over $INSTALL_HOME/.openclaw (state/config/openclaw.json is
     $INSTALL_HOME/.openclaw/openclaw.json; the other paths mirror the state directory);
  2. put the previous core back: move .openclaw-previous to
     $NPM_PREFIX/lib/node_modules/openclaw (or: npm install -g openclaw@$current --prefix $NPM_PREFIX);
  3. sudo systemctl start clawbox-gateway.service
Package rollback alone never reverses a migration: the state must go back with it.
EOF
}

promote_openclaw_core() {
  as_owner /bin/bash -s -- "$1" "$NPM_PREFIX" <<'SH'
set -euo pipefail
stage=$1 prefix=$2
live=$prefix/lib/node_modules/openclaw
previous=$prefix/lib/node_modules/.openclaw-previous
# Flush first: npm's writes sit in the page cache, and a stop in the seconds
# after the rename must find the new tree whole as well as in place.
sync -f "$stage"
rm -rf "$previous"
if [ -e "$live" ] || [ -L "$live" ]; then mv "$live" "$previous"; fi
if ! mv "$stage/lib/node_modules/openclaw" "$live"; then
  { [ -e "$previous" ] || [ -L "$previous" ]; } && mv "$previous" "$live"
  echo 'Error: could not move the staged OpenClaw core into place; the previous one is back' >&2
  exit 1
fi
mkdir -p "$prefix/bin"
for entry in "$stage"/bin/*; do
  { [ -e "$entry" ] || [ -L "$entry" ]; } || continue
  name=$(basename "$entry")
  rm -f "$prefix/bin/$name"
  mv "$entry" "$prefix/bin/$name"
done
if ! { [ -e "$prefix/bin/openclaw" ] || [ -L "$prefix/bin/openclaw" ]; }; then
  mv "$live" "$prefix/lib/node_modules/.openclaw-rejected"
  { [ -e "$previous" ] || [ -L "$previous" ]; } && mv "$previous" "$live"
  rm -rf "$prefix/lib/node_modules/.openclaw-rejected"
  echo 'Error: the staged core came with no openclaw launcher; the previous one is back' >&2
  exit 1
fi
sync -f "$prefix"
rm -rf "$stage"
SH
}

migrate_openclaw_state() {
  local point=$1 rc=0 out
  echo 'Running openclaw doctor --fix --non-interactive (state migrations for the new core)...'
  out=$(as_owner /usr/bin/env OPENCLAW_SERVICE_REPAIR_POLICY=external \
    "$NPM_PREFIX/bin/openclaw" doctor --fix --non-interactive </dev/null 2>&1) || rc=$?
  printf '%s\n' "$out"
  printf '%s\n' "$out" | as_owner /bin/bash -c 'cat >"$1"' _ "$point/doctor.log" || true
  [ "$rc" -eq 0 ] || return 1
  # install.sh's blockers, plus the two this desktop has met: a maintenance
  # lease lost under a multi-GB agent database, and inputs that changed.
  if printf '%s\n' "$out" | grep -qiE 'requires stopped-writer maintenance|Legacy session store requires migration|startup migrations did not complete|Skipped historical transcript directive migration|lease was lost|migration inputs changed'; then
    return 1
  fi
}

rollback_openclaw_core() {
  local point=$1 target=$2
  as_owner /bin/bash -s -- "$NPM_PREFIX" "$target" <<'SH'
set -euo pipefail
prefix=$1 target=$2
live=$prefix/lib/node_modules/openclaw
previous=$prefix/lib/node_modules/.openclaw-previous
rejected=$prefix/lib/node_modules/.openclaw-rejected-$target
if [ -e "$previous" ] || [ -L "$previous" ]; then
  rm -rf "$rejected"
  if [ -e "$live" ] || [ -L "$live" ]; then mv "$live" "$rejected"; fi
  mv "$previous" "$live"
  rm -rf "$rejected"
  sync -f "$prefix"
fi
SH
  core_state_set restore "$point/state"
}

prune_core_recovery_points() {
  as_owner /usr/bin/python3 -I - "$(core_recovery_root)" "$CORE_RECOVERY_KEEP" <<'PY'
import pathlib, shutil, sys
root, keep = pathlib.Path(sys.argv[1]), int(sys.argv[2])
points = sorted(p for p in root.iterdir() if p.is_dir() and not p.is_symlink()) if root.is_dir() else []
for old in points[:-keep] if keep else points:
    shutil.rmtree(old)
    print(f'  Removed the older recovery point {old.name}')
PY
}

replace_openclaw_core() {
  local current=$1 target=$2
  local stage="$NPM_PREFIX/.openclaw-stage"
  local point
  point="$(core_recovery_root)/$(date -u +%Y%m%dT%H%M%SZ)-$current-to-$target"
  echo "OpenClaw $current -> $target: staging the pinned core (the running core is untouched until it is gated and the recovery point is on disk)"
  stage_openclaw_core "$stage" "$target" || return 1
  echo "Recovery point: $point"
  make_core_recovery_point "$point" "$current" "$target" || { as_owner /bin/rm -rf "$stage"; return 1; }
  promote_openclaw_core "$stage" || return 1
  echo "OpenClaw $target is in place; the previous core is retained at $NPM_PREFIX/lib/node_modules/.openclaw-previous"
  if ! migrate_openclaw_state "$point"; then
    echo "Error: OpenClaw $target did not complete the state migration; restoring OpenClaw $current and the pre-update state from $point" >&2
    if ! rollback_openclaw_core "$point" "$target"; then
      echo "Error: the rollback did not complete; restore by hand from $point (recovery.txt there says how)" >&2
      return 1
    fi
    echo "Error: OpenClaw $current and its state are back as they were; the migration's output is in $point/doctor.log" >&2
    return 1
  fi
  prune_core_recovery_points || true
}

# The owner's own compatibility patches over the installed core, each pinned to
# the core version it was reviewed for and refusing any other with "Review
# required". That refusal is reported, never fatal: a patch written for an older
# core has nothing to do on a newer one, and failing the update over it would
# hold the pin back for a repair only the owner can make. Any other failure is
# the step's, as before.
reapply_owner_core_patches() {
  local live="$NPM_PREFIX/lib/node_modules/openclaw" helper out rc
  for helper in openclaw-patch-backup-sqlite openclaw-patch-memory-maintenance; do
    [ -x "$INSTALL_HOME/bin/$helper" ] || continue
    rc=0
    out=$(as_owner "$INSTALL_HOME/bin/$helper" "$live" 2>&1) || rc=$?
    [ -z "$out" ] || printf '%s\n' "$out"
    [ "$rc" -eq 0 ] && continue
    if printf '%s\n' "$out" | grep -q '^Review required:'; then
      echo "CLAWBOX-WARN[core-patch-skipped]: $helper does not apply to the installed OpenClaw core and was skipped ($(printf '%s\n' "$out" | grep -m1 '^Review required:'))"
      continue
    fi
    case "$helper" in
      *memory-maintenance) echo 'Error: the memory maintenance compatibility repair refused; stopping the core step.' >&2 ;;
    esac
    return "$rc"
  done
}

update_openclaw() {
  local target current
  target=$(head -n 1 "$MIRROR/config/openclaw-target.txt")
  [[ "$target" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || {
    echo 'Error: invalid pinned OpenClaw version' >&2; return 1;
  }
  recover_parked_openclaw_core || return 1
  current=$(installed_openclaw_version)
  if [ "$current" != "$target" ]; then
    replace_openclaw_core "${current:-none}" "$target" || return 1
  fi
  reapply_owner_core_patches || return $?
  # Validate without rewriting configuration or running a second migration.
  as_owner "$NPM_PREFIX/bin/openclaw" config validate --json </dev/null || return $?
  if [ "$current" != "$target" ]; then
    echo "OpenClaw $target installed; configuration accepted"
  else
    echo "OpenClaw $target already installed; configuration accepted"
  fi
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
  # Out of the verified MIRROR, like the coding harness: root-established bytes,
  # never the desktop checkout.
  cloudflared_install) /bin/bash "$MIRROR/scripts/setup-tunnel.sh" ;;
  *) echo "Error: $step is not supported by this desktop integration" >&2; exit 64 ;;
esac
