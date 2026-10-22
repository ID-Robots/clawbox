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

# The pinned core's `engines.node` — the same table install.sh and install-x64.sh
# carry (install-node-engine-table.test.ts runs all three): with 2026.9.3 it
# became `>=24.16.0 <25 || >=26.1.0`, so Node 22 is refused outright, and
# 2026.10.6 raised it to `>=24.22.1 <25 || >=26.12.1` (the October 2026 Node.js
# security releases).
OPENCLAW_NODE_ENGINE=">=24.22.1 <25, or >=26.12.1"

node_version_satisfies_openclaw_engine() {
  local version="$1" major
  [ -n "$version" ] || return 1
  major="${version%%.*}"
  case "$major" in
    24) dpkg --compare-versions "$version" ge "24.22.1" ;;
    26) dpkg --compare-versions "$version" ge "26.12.1" ;;
    2[7-9]|[3-9][0-9]|[1-9][0-9][0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

# The Node THIS PACKAGE names (NODE_DIR, baked in by build-package.py), asked
# as the owner — never the one on root's PATH, which is not what the core runs
# on. Asked with --version (every Node answers it, so does the fixture's).
node_satisfies_openclaw_engine() {
  local v
  v=$(as_owner "$NODE_DIR/node" --version 2>/dev/null </dev/null || echo "")
  node_version_satisfies_openclaw_engine "${v#v}"
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

# The core tree, its bin/ entries and the state are separate roots, so the two
# renames make only the tree swap atomic, not the replacement. This marker
# names the recovery point from before the swap until the migration is
# confirmed or rolled back: a reboot, a power loss or the unit's
# TimeoutStartSec in between leaves it behind, and the next core step settles
# it (settle_interrupted_core_replacement) before it compares versions — a new
# core at the pin over state its doctor never finished must not pass as
# "already installed". Four lines: point, previous version, target, phase
# (`replacing`, or `rolling-back` once a rollback has begun).
core_replacement_marker() { printf '%s/.openclaw-migration-pending' "$NPM_PREFIX"; }

mark_core_replacement() {
  as_owner /bin/bash -c 'printf "%s\n%s\n%s\n%s\n" "$2" "$3" "$4" "$5" >"$1.tmp" && sync -f "$1.tmp" && mv -f "$1.tmp" "$1" && sync -f "$(dirname "$1")"' _ \
    "$(core_replacement_marker)" "$1" "$2" "$3" "$4"
}

clear_core_replacement_mark() {
  as_owner /bin/bash -c 'rm -f "$1" "$1.tmp" && sync -f "$(dirname "$1")"' _ "$(core_replacement_marker)"
}

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
  # Checked BEFORE npm runs: this package was once rebuilt without --node-dir
  # and so pointed at the distro's Node 22, and the core's preinstall refused
  # it with a wall of npm text that named neither the Node nor the repair.
  if ! node_satisfies_openclaw_engine; then
    echo "Error: the Node this integration package names, $NODE_DIR/node, is $(as_owner "$NODE_DIR/node" --version 2>/dev/null </dev/null || echo 'not runnable') and openclaw@$target needs Node $OPENCLAW_NODE_ENGINE; rebuild the package with --node-dir naming a Node the core accepts (python3 scripts/x64-migration/build-package.py --node-dir <dir> ...) and install it, then run the update again. The core on this desktop is untouched." >&2
    return 1
  fi
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
# under config/openclaw.json) and lists it in snapshot.txt, one line per file,
# with every database file of that set that did NOT exist written as
# `absent:<path>`; `restore` puts exactly the listed files back and removes
# what the new core created: an absent-listed file (a state database a
# legacy-store migration wrote, a -wal/-shm beside it), a -wal/-shm beside a
# listed database, and the database of an agent that had none. An old core
# never opens a schema newer than its own, so a leftover would keep the
# restored gateway down. Never through a symlink in either direction.
core_state_set() {
  as_owner /usr/bin/python3 -I - "$1" "$INSTALL_HOME/.openclaw" "$2" "$INSTALL_HOME/.openclaw/openclaw.json" <<'PY'
import os, pathlib, shutil, sys
mode, state_dir, snap, config = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4])
manifest = snap / 'snapshot.txt'
STATE_DB = 'state/openclaw.sqlite'
AGENT_DB = 'openclaw-agent.sqlite'
SUFFIXES = ['', '-wal', '-shm']
def agent_files():
    """Every agent database file under the default layout now, relative."""
    names = {AGENT_DB + suffix for suffix in SUFFIXES}
    return sorted(str(p.relative_to(state_dir)) for p in state_dir.glob('agents/*/agent/' + AGENT_DB + '*') if p.name in names)
def copy(src, dst):
    if src.is_symlink():
        raise SystemExit(f'refusing a symbolic link in the state set: {src}')
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    with open(dst, 'rb') as f:
        os.fsync(f.fileno())
if mode == 'snapshot':
    bases = [STATE_DB, *sorted(rel for rel in agent_files() if rel.endswith(AGENT_DB))]
    entries, absent = [], 0
    if config.exists():
        copy(config, snap / 'config' / 'openclaw.json'); entries.append('config/openclaw.json')
    for base in bases:
        for suffix in SUFFIXES:
            rel = base + suffix
            src = state_dir / rel
            if src.exists() or src.is_symlink():
                copy(src, snap / rel); entries.append(rel)
            else:
                entries.append('absent:' + rel); absent += 1
    manifest.write_text(''.join(e + '\n' for e in entries))
    print(f'  Snapshot: {len(entries) - absent} files under {snap}, {absent} recorded absent')
elif mode == 'restore':
    lines = [e for e in manifest.read_text().splitlines() if e]
    entries = [e for e in lines if not e.startswith('absent:')]
    kept = set(entries)
    for rel in entries:
        dst = config if rel == 'config/openclaw.json' else state_dir / rel
        if dst.is_symlink():
            raise SystemExit(f'refusing to restore over a symbolic link: {dst}')
        copy(snap / rel, dst)
    # What the new core created: every file the snapshot recorded absent, a
    # -wal/-shm beside a listed database (a manifest from before absent
    # entries lists only what existed), and an agent database the snapshot
    # never saw.
    created = [e[len('absent:'):] for e in lines if e.startswith('absent:')]
    created += [rel + suffix for rel in entries if rel.endswith('.sqlite') for suffix in SUFFIXES[1:]]
    created += agent_files()
    removed = 0
    for rel in dict.fromkeys(created):
        if rel in kept or pathlib.PurePosixPath(rel).is_absolute() or '..' in pathlib.PurePosixPath(rel).parts:
            continue
        stray = state_dir / rel
        if stray.is_symlink():
            raise SystemExit(f'refusing to remove a symbolic link: {stray}')
        if stray.exists():
            stray.unlink(); removed += 1
            print(f'  Removed {rel}, which the new core created')
    os.sync()
    print(f'  Restored: {len(entries)} files from {snap}, removed {removed}')
else:
    raise SystemExit('unknown mode')
PY
}

# The links the archiver refuses, set aside for the archive and put back.
# OpenClaw's `backup create` (2026.9.4 and 2026.10.x alike) refuses, WHILE
# WRITING, every symbolic link whose target is outside its declared assets —
# an absolute target whose real path is outside every asset or does not exist,
# a relative one that lands outside — and has no exclusion (ClawKeep's
# backup_guard meets the same rule and is the model here). On the desktop this
# package was built for that was some seventy links — a plugin-skills index
# pointing at a core prefix, a Codex sandbox's tool links, Chromium's
# SingletonSocket — and the first refusal came 23 minutes into the archive.
# So the links are found first, by the archiver's own rule over the roots its
# dry run declares (the state directory alone when the plan cannot be read),
# their text journalled in <point>/set-aside-links.txt, unlinked for the
# archive and recreated from the journal afterwards, pass or fail; the journal
# is renamed set-aside-links.restored.txt once every link is back, and one a
# cut-short run left is put back at the start of the next core step. Only
# links are touched, only while the gateway is stopped, and never one that
# something else has replaced meanwhile.
core_links_set_aside() {
  as_owner /usr/bin/python3 -I - "$1" "$2" "$INSTALL_HOME/.openclaw" <<'PY'
import json, os, pathlib, sys
mode, point, state_dir = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
journal, restored = point / 'set-aside-links.txt', point / 'set-aside-links.restored.txt'
def inside(path, root):
    return path == root or path.startswith(root.rstrip('/') + '/')
def refused(path, target, roots):
    """The archiver's rule: an absolute target is kept only when its REAL path
    is inside a declared asset, a relative one must land inside one."""
    if '\\' in target:
        return True
    if os.path.isabs(target):
        try:
            real = os.path.realpath(target, strict=True)
        except OSError:
            return True
        return not any(inside(real, root) for root in roots)
    landed = os.path.normpath(os.path.join(os.path.dirname(path), target))
    return not any(inside(landed, root) for root in roots)
def put_back():
    if not journal.exists():
        return 0, 0
    back = kept = 0
    for line in journal.read_text().splitlines():
        if '\t' not in line:
            continue
        path, target = line.split('\t', 1)
        if os.path.lexists(path):
            if os.path.islink(path) and os.readlink(path) == target:
                back += 1
            else:
                kept += 1
                print(f'  Warning: not restoring the link {path}: something else is there now')
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        os.symlink(target, path)
        back += 1
    if kept == 0:
        with open(restored, 'a') as out:
            out.write(journal.read_text())
        journal.unlink()
    os.sync()
    return back, kept
if mode == 'set-aside':
    if journal.exists():
        raise SystemExit(f'{journal} is still there: links from an earlier run were not put back')
    roots = []
    try:
        plan = json.loads((point / 'backup-plan.json').read_text())
        for asset in plan.get('assets') or []:
            if asset.get('sourcePath'):
                roots.append(os.path.realpath(asset['sourcePath']))
        for agent in plan.get('agentRoots') or []:
            if agent.get('sourcePath'):
                roots.append(os.path.realpath(agent['sourcePath']))
    except (OSError, ValueError):
        roots = []
    if not roots:
        roots = [os.path.realpath(state_dir)]
    # The plan lists an agent root inside the state root as a root of its own:
    # walk only the outermost roots, and keep one entry per link.
    outer = [r for r in dict.fromkeys(roots) if not any(o != r and inside(r, o) for o in roots)]
    found = {}
    for root in outer:
        for dirpath, dirnames, filenames in os.walk(root):
            for name in dirnames + filenames:
                path = os.path.join(dirpath, name)
                if not os.path.islink(path):
                    continue
                target = os.readlink(path)
                if '\n' in path or '\n' in target or '\t' in path:
                    raise SystemExit(f'refusing to journal a link whose name or target holds a newline or tab: {path}')
                if refused(path, target, roots):
                    found[path] = target
    with open(journal, 'w') as out:
        out.write(''.join(f'{path}\t{target}\n' for path, target in found.items()))
        out.flush(); os.fsync(out.fileno())
    for path in found:
        os.unlink(path)
    os.sync()
    print(f'  Set aside {len(found)} symbolic links the archiver would refuse (listed in {journal})')
elif mode == 'restore':
    back, kept = put_back()
    print(f'  Put back {back} set-aside links' + (f'; {kept} not restored' if kept else ''))
    if kept:
        raise SystemExit(1)
else:
    raise SystemExit('unknown mode')
PY
}

# Links a cut-short run left set aside, under any recovery point: put back
# before the core is probed, the way a parked core is.
restore_set_aside_links_everywhere() {
  local root journal
  root=$(core_recovery_root)
  [ -d "$root" ] || return 0
  for journal in "$root"/*/set-aside-links.txt; do
    [ -f "$journal" ] || continue
    echo "An earlier core step left links set aside; putting them back from $journal"
    core_links_set_aside restore "$(dirname "$journal")" || return 1
  done
}

make_core_recovery_point() {
  local point=$1 current=$2 target=$3
  local archive_rc=0
  as_owner /bin/mkdir -p -m 0700 "$point" "$point/archive" "$point/state" || return 1
  # The archiver's own plan names the roots its link rule is judged against.
  as_owner /bin/bash -c 'exec "$1" backup create --dry-run --no-include-workspace --json </dev/null >"$2" 2>/dev/null' _ \
      "$NPM_PREFIX/bin/openclaw" "$point/backup-plan.json" || true
  core_links_set_aside set-aside "$point" || {
    echo "Error: the links the archiver refuses could not be set aside; nothing on this desktop was changed" >&2
    return 1
  }
  echo "Writing the verified pre-update archive with OpenClaw $current (backup create --verify --no-include-workspace)..."
  as_owner /bin/bash -c 'exec "$1" backup create --verify --no-include-workspace --output "$2" --json </dev/null >"$3" 2>"$4"' _ \
      "$NPM_PREFIX/bin/openclaw" "$point/archive" "$point/backup-create.json" "$point/backup-create.log" || archive_rc=$?
  core_links_set_aside restore "$point" || {
    echo "Error: not every set-aside link is back (see $point/set-aside-links.txt); the next core step puts them back, nothing else on this desktop was changed" >&2
    return 1
  }
  if [ "$archive_rc" -ne 0 ]; then
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
set-aside-links.*   the symbolic links the archiver refuses, unlinked for the archive and recreated
                    after it (.restored.txt once they are back; .txt means the next core step puts them back).

The previous core is retained at $NPM_PREFIX/lib/node_modules/.openclaw-previous until the next
core replacement. To go back by hand:
  1. stop the gateway through its bridge, as root: systemctl stop clawbox-gateway.service
  2. copy state/ back over $INSTALL_HOME/.openclaw (state/config/openclaw.json is
     $INSTALL_HOME/.openclaw/openclaw.json; the other paths mirror the state directory);
  3. put the previous core back: move .openclaw-previous to
     $NPM_PREFIX/lib/node_modules/openclaw (or: npm install -g openclaw@$current --prefix $NPM_PREFIX);
  4. start it again, as root: systemctl restart clawbox-gateway.service
  5. delete $(core_replacement_marker) if it is there, or the next core step
     settles this replacement again.
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
  sync -f "$prefix"
fi
# A rollback cut short after its first rename is finished by
# recover_parked_openclaw_core; what it set aside goes here.
rm -rf "$rejected"
SH
  core_state_set restore "$point/state"
}

# Put the previous core and the pre-update state back, under the marker's
# rolling-back phase so a stop part-way is finished by the next core step.
# Returns 0 once both are back (the caller still fails the step).
roll_back_core_replacement() {
  local point=$1 current=$2 target=$3 reason=$4
  echo "Error: $reason; restoring OpenClaw $current and the pre-update state from $point" >&2
  mark_core_replacement "$point" "$current" "$target" rolling-back || true
  if ! rollback_openclaw_core "$point" "$target"; then
    echo "Error: the rollback did not complete; restore by hand from $point (recovery.txt there says how)" >&2
    return 1
  fi
  clear_core_replacement_mark || true
  if [ -f "$point/doctor.log" ]; then
    echo "Error: OpenClaw $current and its state are back as they were; the migration's output is in $point/doctor.log" >&2
  else
    echo "Error: OpenClaw $current and its state are back as they were (recovery point $point)" >&2
  fi
  # Every failed attempt writes a point with a copy of every database: keep
  # the newest few here too, or retries of a refused migration fill the disk.
  prune_core_recovery_points || true
}

# A replacement an earlier run did not see through: finish it or put it back.
# The new core in place means its doctor may have run part-way (and a gateway
# started on it after a reboot may have written since), so the migration runs
# again and a refusal rolls back to the recorded point. The previous core in
# place means the swap never completed and nothing was migrated: the mark
# goes and the update proceeds. A rollback already begun is finished.
settle_interrupted_core_replacement() {
  local marker point= current= target= phase= extra= installed root name
  marker=$(core_replacement_marker)
  { [ -e "$marker" ] || [ -L "$marker" ]; } || return 0
  root=$(core_recovery_root)
  { IFS= read -r point; IFS= read -r current; IFS= read -r target; IFS= read -r phase; IFS= read -r extra || true; } \
    < <(as_owner /bin/cat "$marker" 2>/dev/null || true)
  local version='^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$'
  name=${point#"$root/"}
  if [ -n "$extra" ] || [[ "$point" != "$root/"* ]] || [[ -z "$name" || "$name" == */* || "$name" == . || "$name" == .. ]] \
      || ! [[ "$current" =~ $version || "$current" == none ]] || ! [[ "$target" =~ $version ]] \
      || ! [[ "$phase" == replacing || "$phase" == rolling-back ]] \
      || ! as_owner /bin/bash -c '[ -d "$1" ] && [ ! -L "$1" ] && [ -f "$1/state/snapshot.txt" ]' _ "$point"; then
    echo "Error: $marker records an OpenClaw core replacement this step cannot settle (it names no recovery point under $root); check the core and the state against the newest recovery point there, then delete it" >&2
    return 1
  fi
  installed=$(installed_openclaw_version)
  if [ "$phase" = rolling-back ]; then
    echo "An earlier rollback of OpenClaw $target to $current did not finish; finishing it from $point"
    roll_back_core_replacement "$point" "$current" "$target" "the earlier replacement of OpenClaw $current by $target had failed" || true
    return 1
  fi
  if [ "$installed" = "$target" ]; then
    echo "An earlier replacement of OpenClaw $current by $target stopped before its state migration was confirmed; running the migration again (recovery point $point)"
    if ! migrate_openclaw_state "$point"; then
      roll_back_core_replacement "$point" "$current" "$target" "OpenClaw $target did not complete the interrupted state migration" || true
      return 1
    fi
    clear_core_replacement_mark || return 1
    echo "OpenClaw $target completed the interrupted state migration"
    prune_core_recovery_points || true
    return 0
  fi
  if [ "$installed" = "$current" ] || { [ "$current" = none ] && [ -z "$installed" ]; }; then
    echo "An earlier replacement of OpenClaw $current by $target stopped before the new core was in place; nothing was migrated"
    clear_core_replacement_mark
    return
  fi
  echo "Error: $marker records a replacement of OpenClaw $current by $target, but the installed core is ${installed:-absent}; restore by hand from $point (recovery.txt there says how), then delete it" >&2
  return 1
}

prune_core_recovery_points() {
  as_owner /usr/bin/python3 -I - "$(core_recovery_root)" "$CORE_RECOVERY_KEEP" "$(core_replacement_marker)" <<'PY'
import pathlib, shutil, sys
root, keep, marker = pathlib.Path(sys.argv[1]), int(sys.argv[2]), pathlib.Path(sys.argv[3])
# Never the point a pending replacement still needs.
pending = marker.read_text().splitlines()[:1] if marker.is_file() else []
points = sorted(p for p in root.iterdir() if p.is_dir() and not p.is_symlink() and str(p) not in pending and not (p / 'set-aside-links.txt').exists()) if root.is_dir() else []
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
  mark_core_replacement "$point" "$current" "$target" replacing || {
    echo "Error: could not record the pending replacement at $(core_replacement_marker); nothing on this desktop was changed" >&2
    as_owner /bin/rm -rf "$stage"; return 1
  }
  if ! promote_openclaw_core "$stage"; then
    # promote puts the previous core back on every failure it sees before the
    # tree swap; one after it leaves the new tree live and needs the rollback.
    if [ "$(installed_openclaw_version)" = "$target" ]; then
      roll_back_core_replacement "$point" "$current" "$target" "OpenClaw $target was not completely put in place" || true
    else
      clear_core_replacement_mark || true
    fi
    return 1
  fi
  echo "OpenClaw $target is in place; the previous core is retained at $NPM_PREFIX/lib/node_modules/.openclaw-previous"
  if ! migrate_openclaw_state "$point"; then
    roll_back_core_replacement "$point" "$current" "$target" "OpenClaw $target did not complete the state migration" || true
    return 1
  fi
  clear_core_replacement_mark || return 1
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
  restore_set_aside_links_everywhere || return 1
  settle_interrupted_core_replacement || return 1
  current=$(installed_openclaw_version)
  if [ "$current" != "$target" ]; then
    replace_openclaw_core "${current:-none}" "$target" || return 1
  fi
  reapply_owner_core_patches || return $?
  # Validate without rewriting configuration or running a second migration,
  # through the mirror's retry wrapper: the core refuses a config read while a
  # gateway start or a doctor run holds its state for maintenance and says to
  # retry when it finishes; still refused after its window, it exits 75. A
  # mirror cut from a branch that predates the wrapper validates as before.
  if [ -f "$MIRROR/scripts/openclaw-maintenance-retry.sh" ]; then
    as_owner /bin/bash "$MIRROR/scripts/openclaw-maintenance-retry.sh" \
      "$NPM_PREFIX/bin/openclaw" config validate --json </dev/null || return $?
  else
    as_owner "$NPM_PREFIX/bin/openclaw" config validate --json </dev/null || return $?
  fi
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
  # Settings → Users, out of the same MIRROR: the install-x64.sh PC's root
  # dispatcher implements both, handed this desktop's owner and checkout (it
  # would otherwise look for the x64.env this package never writes).
  user_add|user_remove)
    /usr/bin/env CLAWBOX_USER="$INSTALL_USER" PROJECT_DIR="$PROJECT_DIR" \
      /bin/bash "$MIRROR/scripts/x64-migration/clawbox-x64-root-step.sh" "$step"
    ;;
  *) echo "Error: $step is not supported by this desktop integration" >&2; exit 64 ;;
esac
