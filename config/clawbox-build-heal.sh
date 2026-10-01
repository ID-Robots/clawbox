#!/usr/bin/env bash
#
# Heal, at boot, a web build an interrupted update left behind. TASK-1316.
#
# Installed by install.sh::install_root_libexec to
# /usr/local/libexec/clawbox/clawbox-build-heal.sh, root:root 0755, and run as
# root by config/clawbox-build-heal.service on every boot. Granted to nobody:
# the web server cannot start it, and does not need to.
#
# WHY THIS EXISTS. A box was found running a web build from before TASK-539 —
# one that starts every root step with a plain `systemctl start
# clawbox-root-update@<step>.service`, authorised only by the polkit
# `manage-units` grant — over a tree from after it, on which the update that
# moved the tree had already removed that grant and then never landed its
# rebuild. Every update then died at step 1 with polkit's "Interactive
# authentication required", and no update could ever fix it: the update is
# exactly what that server can no longer start, and the running code is not
# something a later release can change. The way out has to need no web-server
# privilege at all. This is it.
#
# WHAT IT DOES. Asks one question, cheaply, and in the ordinary case answers
# "nothing to do" in well under a second:
#
#   stale-build            the web build a server would run does not match the
#                          tree on disk, predates the root-step launcher, and
#                          the tree uses the launcher
#   root-contract-missing  the build uses the launcher, but the launcher or its
#                          sudoers grant is not installed
#
# and for either one dispatches `heal_build` through the ROOT-OWNED dispatcher,
# like any other root step: the dispatcher refuses unless the tree still
# matches the root-exec record, and runs install.sh out of the mirror (TASK-445,
# TASK-733). install.sh's step_heal_build then rebuilds from the tree ON DISK —
# no fetch, no reset, nothing discarded — brings the root side of the launcher
# contract up to that build, restarts the web server onto it, and only then
# lets step_polkit_rules retire the old grant.
#
# BOUNDED. At most MAX_ATTEMPTS attempts per (tree commit, reason), each one
# recorded — when, why, how it ended — in STATE_FILE, root-owned. A box whose
# build genuinely fails is not rebuilt at every boot for ever: it stops, says
# so in the journal on every later boot with the command an operator can run,
# and starts counting again only when the tree moves to another commit.
#
# SECURITY. Root reads the clawbox-writable tree here as DATA only — a JSON
# stamp and compiled JavaScript it greps, never sources or runs — and asks git
# for HEAD as the tree's OWNER (runuser), because git reads .git/config, which
# that account writes. What runs as root afterwards is the dispatcher's
# decision, out of the mirror. Nothing here re-adds the manage-units grant or
# any sudoers rule.
#
# Usage (root):
#   clawbox-build-heal.sh                                boot: check, heal within bounds
#   clawbox-build-heal.sh --check [PROJECT_DIR]          exit 0 + reason when a heal is needed,
#                                                        exit 1 + why not
#   clawbox-build-heal.sh --build-uses-launcher [DIR]    exit 0 when the build a server would run
#                                                        uses the launcher (or there is no build)

set -uo pipefail

PROJECT_DIR="/home/clawbox/clawbox"
LIBEXEC_DIR="/usr/local/libexec/clawbox"
LAUNCHER="$LIBEXEC_DIR/clawbox-run-root-step.sh"
DISPATCHER="$LIBEXEC_DIR/clawbox-root-step.sh"
SUDOERS_DROPIN="/etc/sudoers.d/clawbox"
STATE_DIR="/var/lib/clawbox"
STATE_FILE="$STATE_DIR/build-heal.state"
MAX_ATTEMPTS=2
# What a build that uses the launcher carries in its compiled server code:
# src/lib/root-step-runner.ts's ROOT_STEP_LAUNCHER. No build from before
# TASK-539 contains it.
LAUNCHER_NAME="clawbox-run-root-step.sh"

short() { printf '%s' "${1:0:7}"; }

# The build production-server.js would load: the live standalone tree, else the
# one a killed rebuild left parked (production-server.js reclaims that at boot).
runnable_build() {
  local dir="$1" b
  for b in "$dir/.next/standalone" "$dir/.next-old/standalone"; do
    if [ -e "$b/server.js" ] || [ -L "$b/server.js" ]; then
      printf '%s\n' "$b"
      return 0
    fi
  done
  return 1
}

# The commit the build says it was made from (scripts/write-build-info.mjs).
# Parsed, never sourced; hex only.
build_commit() {
  local build="$1" dir="$2" stamp
  for stamp in "$build/.next/build-info.json" "$dir/.next/build-info.json"; do
    [ -f "$stamp" ] && [ ! -L "$stamp" ] || continue
    sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{7,64\}\)".*/\1/p' "$stamp" | head -n 1
    return 0
  done
}

# git as the tree's owner — see SECURITY above.
tree_commit() {
  local dir="$1" owner
  owner="$(stat -c %U "$dir" 2>/dev/null || true)"
  if [ "$(id -u)" = "0" ] && [ -n "$owner" ] && [ "$owner" != "root" ] && id -u "$owner" >/dev/null 2>&1; then
    runuser -u "$owner" -- git -c safe.directory="$dir" -C "$dir" rev-parse --verify --quiet 'HEAD^{commit}' 2>/dev/null
  else
    git -c safe.directory="$dir" -C "$dir" rev-parse --verify --quiet 'HEAD^{commit}' 2>/dev/null
  fi
}

# Does the build a server would run start its root steps through the launcher?
# Yes when there is no build at all: nothing then depends on the old path.
build_uses_launcher() {
  local dir="$1" build
  build="$(runnable_build "$dir")" || return 0
  [ -d "$build" ] && [ ! -L "$build" ] || return 1
  # Recursive grep never follows a symlink below its argument; `-D skip` keeps
  # a planted FIFO or device from hanging the boot. node_modules is the
  # dependencies, not ClawBox's own code.
  grep -rqsF -D skip --include='*.js' --exclude-dir=node_modules -- "$LAUNCHER_NAME" "$build"
}

# The tree has used the launcher since it shipped config/clawbox-run-root-step.sh.
tree_uses_launcher() {
  [ -f "$1/config/$LAUNCHER_NAME" ]
}

sudoers_grants_launcher() {
  [ -f "$SUDOERS_DROPIN" ] || return 1
  awk -v l="$LAUNCHER" '$1 == "clawbox" && /NOPASSWD:/ && $NF == l { f = 1 } END { exit f ? 0 : 1 }' "$SUDOERS_DROPIN"
}

# Print the reason and return 0 when a heal is needed; print why not, return 1.
heal_reason() {
  local dir="$1" build built tree uses
  if [ ! -d "$dir/.git" ]; then
    echo "healthy: $dir is not a checkout"
    return 1
  fi
  if ! build="$(runnable_build "$dir")"; then
    echo "healthy: there is no web build on disk to heal (an installer builds it)"
    return 1
  fi
  tree="$(tree_commit "$dir")" || tree=""
  built="$(build_commit "$build" "$dir")"
  if [ -n "$tree" ] && [ "$built" = "$tree" ]; then
    # The build IS the tree, so it uses whatever the tree uses. The ordinary
    # healthy boot ends at the sudoers check below without reading the build.
    tree_uses_launcher "$dir" && uses=1 || uses=0
  else
    build_uses_launcher "$dir" && uses=1 || uses=0
    if [ "$uses" = "0" ]; then
      local b_name="unknown commit" t_name="unknown commit"
      [ -z "$built" ] || b_name="$(short "$built")"
      [ -z "$tree" ] || t_name="$(short "$tree")"
      if ! tree_uses_launcher "$dir"; then
        echo "healthy: the build ($b_name) and the code on disk ($t_name) both predate the root-step launcher"
        return 1
      fi
      echo "stale-build: the web build ($b_name) predates the root-step launcher, but the code on disk ($t_name) uses it — an update moved the code and never landed its rebuild"
      return 0
    fi
  fi
  if [ "$uses" = "1" ]; then
    if [ ! -x "$LAUNCHER" ]; then
      echo "root-contract-missing: the web build starts root steps through $LAUNCHER, which is not installed"
      return 0
    fi
    if ! sudoers_grants_launcher; then
      echo "root-contract-missing: the web build starts root steps through $LAUNCHER, which $SUDOERS_DROPIN does not grant"
      return 0
    fi
  fi
  echo "healthy: the web build and the root side of this box agree on how root steps start"
  return 1
}

# ── The attempt record ───────────────────────────────────────────────────────
# key=value lines, parsed (never sourced), written through a temp file and a
# rename inside a root-owned directory.
state_get() {
  local key="$1"
  [ -f "$STATE_FILE" ] && [ ! -L "$STATE_FILE" ] || return 0
  sed -n "s/^$key=//p" "$STATE_FILE" | head -n 1
}

state_write() {
  local tmp
  install -d -o root -g root -m 0755 "$STATE_DIR" 2>/dev/null || mkdir -p "$STATE_DIR" || return 1
  tmp="$(mktemp "$STATE_DIR/.build-heal.XXXXXX")" || return 1
  {
    echo "# clawbox-build-heal.sh's record of its attempts (TASK-1316). Safe to delete: the next boot starts counting again."
    printf 'tree=%s\n' "$1"
    printf 'kind=%s\n' "$2"
    printf 'attempts=%s\n' "$3"
    printf 'last_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'last_result=%s\n' "$(printf '%s' "$4" | tr -d '\n')"
    printf 'reason=%s\n' "$(printf '%s' "$5" | tr -d '\n')"
  } > "$tmp" && chmod 0644 "$tmp" && mv -f "$tmp" "$STATE_FILE"
}

boot() {
  local reason kind tree attempts=0 prev_tree prev_kind prev_attempts rc result
  if ! reason="$(heal_reason "$PROJECT_DIR")"; then
    echo "clawbox-build-heal: nothing to do — ${reason#healthy: }"
    return 0
  fi
  kind="${reason%%:*}"
  tree="$(tree_commit "$PROJECT_DIR")" || tree=""
  tree="${tree:-unknown}"

  prev_tree="$(state_get tree)"
  prev_kind="$(state_get kind)"
  prev_attempts="$(state_get attempts)"
  case "$prev_attempts" in ''|*[!0-9]*) prev_attempts=0 ;; esac
  if [ "$prev_tree" = "$tree" ] && [ "$prev_kind" = "$kind" ]; then
    attempts="$prev_attempts"
  fi
  if [ "$attempts" -ge "$MAX_ATTEMPTS" ]; then
    echo "clawbox-build-heal: NOT retrying — $attempts attempt(s) at $kind already made for $(short "$tree"), the last ending: $(state_get last_result)."
    echo "clawbox-build-heal: $reason"
    echo "clawbox-build-heal: repair by hand: sudo bash $PROJECT_DIR/install.sh --step heal_build"
    return 0
  fi
  attempts=$((attempts + 1))
  state_write "$tree" "$kind" "$attempts" "started" "$reason" \
    || echo "clawbox-build-heal: WARNING: could not record this attempt in $STATE_FILE" >&2
  echo "clawbox-build-heal: attempt $attempts of $MAX_ATTEMPTS — $reason"

  if [ ! -x "$DISPATCHER" ]; then
    rc=65
    result="not started: $DISPATCHER is missing — repair with: sudo bash $PROJECT_DIR/install.sh --step systemd_services"
  else
    "$DISPATCHER" heal_build
    rc=$?
    case "$rc" in
      0) result="healed" ;;
      64|65) result="refused by the root-step dispatcher (exit $rc) — the code on disk does not match what root recorded; repair with: sudo bash $PROJECT_DIR/install.sh --step heal_build" ;;
      *) result="failed (exit $rc) — see: journalctl -b -u clawbox-build-heal" ;;
    esac
  fi
  state_write "$tree" "$kind" "$attempts" "$result" "$reason" \
    || echo "clawbox-build-heal: WARNING: could not record the outcome in $STATE_FILE" >&2
  echo "clawbox-build-heal: $result"
  return "$rc"
}

case "${1:-}" in
  --check)
    heal_reason "${2:-$PROJECT_DIR}"
    ;;
  --build-uses-launcher)
    build_uses_launcher "${2:-$PROJECT_DIR}"
    ;;
  "")
    if [ "$(id -u)" != "0" ]; then
      echo "clawbox-build-heal: must run as root (it is started by clawbox-build-heal.service)" >&2
      exit 64
    fi
    boot
    ;;
  *)
    echo "usage: $0 [--check [PROJECT_DIR] | --build-uses-launcher [PROJECT_DIR]]" >&2
    exit 64
    ;;
esac
