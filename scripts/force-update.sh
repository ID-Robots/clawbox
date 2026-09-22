#!/usr/bin/env bash
# scripts/force-update.sh
#
# Self-heal a ClawBox device that can't update through the UI because the
# updater itself is broken. Runs the same hard-sync the modern updater
# now does, but bypasses the in-process route — so even if the running
# Next.js bundle still has the old broken updater code, this script can
# still recover the device.
#
# Symptom this fixes:
#
#   "Updating ClawBox and restarting: Command failed: git ... checkout
#    -B main FETCH_HEAD ... error: Your local changes to the following
#    files would be overwritten by checkout: ... Please commit your
#    changes or stash them before you switch branches. Aborting"
#
# Run from the device's Terminal app or via SSH:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/id-robots/clawbox/main/scripts/force-update.sh)

set -euo pipefail

# Environment:
#   CLAWBOX_ROOT / CLAWBOX_BRANCH — as below.
#   CLAWBOX_BUN             — the bun binary (default: the clawbox user's
#                             ~/.bun/bin/bun, then whatever `bun` is on PATH).
#   CLAWBOX_GIT_RETRIES     — attempts for the fetch (default: 3).
#   CLAWBOX_GIT_RETRY_DELAY — seconds before the first retry, doubling (default: 3).
#   A value that is not a whole number is replaced with the default and a line
#   is printed saying so. Same two knobs, same rule, as install.sh.
#
# A build that fails is never served, and never leaves the checkout ahead of
# what is served: the serving build is parked before `next build` runs and put
# back if the new one fails, the checkout goes back to the commit it was on,
# nothing is restarted, and the script exits non-zero with the tail of the
# build's output. Before this, a failed build left `git HEAD` on the new commit
# while the service kept serving the old one — and `.next` half-deleted under
# it, so the next restart had nothing to load.

PROJECT_DIR="${CLAWBOX_ROOT:-/home/clawbox/clawbox}"
TARGET_BRANCH="${CLAWBOX_BRANCH:-main}"
UPSTREAM="origin/${TARGET_BRANCH}"
CLAWBOX_USER="clawbox"

# Validate inputs — both values are interpolated into `bash -c` strings
# downstream, and the script runs steps as root via sudo. Mirrors the
# SAFE_BRANCH regex in src/lib/updater.ts to block command-injection
# via a malicious CLAWBOX_BRANCH or CLAWBOX_ROOT env value.
if ! [[ "$PROJECT_DIR" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "Error: invalid CLAWBOX_ROOT '$PROJECT_DIR' (allowed: A-Z a-z 0-9 . _ / -)" >&2
  exit 1
fi
if ! [[ "$TARGET_BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "Error: invalid CLAWBOX_BRANCH '$TARGET_BRANCH' (allowed: A-Z a-z 0-9 . _ / -)" >&2
  exit 1
fi

if [ ! -d "$PROJECT_DIR/.git" ]; then
  echo "Error: $PROJECT_DIR is not a git repository" >&2
  exit 1
fi

# Resolved before anything moves, and held to the same rule as the two values
# above: it is interpolated into the same `bash -c` strings.
BUN_BIN="${CLAWBOX_BUN:-}"
if [ -z "$BUN_BIN" ]; then
  BUN_BIN="/home/$CLAWBOX_USER/.bun/bin/bun"
  if [ ! -x "$BUN_BIN" ]; then
    BUN_BIN="$(command -v bun || echo bun)"
  fi
fi
if ! [[ "$BUN_BIN" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "Error: invalid bun path '$BUN_BIN' (allowed: A-Z a-z 0-9 . _ / -)" >&2
  exit 1
fi

run_as_clawbox() {
  # GIT_TERMINAL_PROMPT=0 is git's own switch, and it is load-bearing HERE more
  # than anywhere else: this script is run by hand over SSH, so git HAS a tty
  # and a refused anonymous fetch blocks on `Username for 'https://github.com':`
  # instead of failing — the recovery script hanging on the box it is recovering
  # (TASK-655). The updater sets the same variable for the same reason.
  # The export goes INSIDE the command string, not in front of `sudo`'s target:
  # sudo resets the environment, so `sudo -u x VAR=1 cmd` needs a `setenv` the
  # sudoers drop-in does not grant — and it would change the argv shape
  # scripts/check-sudoers-coverage.sh resolves this call site by.
  if [ "$(id -un)" = "$CLAWBOX_USER" ]; then
    bash -c "export GIT_TERMINAL_PROMPT=0; $1"
  else
    sudo -u "$CLAWBOX_USER" bash -c "export GIT_TERMINAL_PROMPT=0; $1"
  fi
}

# Same list, same reason, as install.sh's git_retryable_failure: asking again
# only helps a refusal that is about the moment, not about the remote. This is
# the script an owner runs when they are already stuck, so 3 s + 6 s of backoff
# over a broken origin is time taken from someone waiting at the box.
#
# The list must stay byte-identical to install.sh's — a test asserts it — so
# any change belongs in both.
#
# `Could not resolve host` is DELIBERATELY retryable here and deliberately not
# in src/lib/updater.ts, which is the only case where the three classifiers
# disagree. A run of this script or of install.sh happens once, with someone
# waiting, and can race NetworkManager still coming up — one more ask can land.
# The version check in updater.ts is polled by four surfaces, where the same
# retry is dead time on every poll over a question already answered.
git_retryable_failure() {
  case "$1" in
    *"could not read Username"*|*"could not read Password"*|*"Repository not found"*) return 0 ;;
    *"Authentication failed"*|*"terminal prompts disabled"*) return 0 ;;
    *"Could not resolve host"*|*"Connection timed out"*|*"Connection reset"*) return 0 ;;
    *"early EOF"*|*"RPC failed"*|*"unable to access"*) return 0 ;;
  esac
  return 1
}

# One attempt is a coin flip: GitHub refuses anonymous git-upload-pack POSTs
# from an address that has made too many, ~2 in 3 when measured (TASK-655).
# install.sh's git_with_retry is not sourceable from here (that file is an
# installer, not a library), so this is the same three-attempt shape inline.
fetch_with_retry() {
  local attempt=1 max="${CLAWBOX_GIT_RETRIES:-3}" delay="${CLAWBOX_GIT_RETRY_DELAY:-3}" out
  # Both knobs are operator input and both are used as numbers — see
  # install.sh's git_with_retry: a non-numeric `max` makes the break
  # unreachable and a non-numeric `delay` is an unbound-variable error under
  # `set -u`. Replaced with the default, and said out loud.
  case "$max" in
    ''|*[!0-9]*) echo "[force-update] CLAWBOX_GIT_RETRIES is not a number, using 3" >&2; max=3 ;;
  esac
  case "$delay" in
    ''|*[!0-9]*) echo "[force-update] CLAWBOX_GIT_RETRY_DELAY is not a number, using 3" >&2; delay=3 ;;
  esac
  while :; do
    if out="$(run_as_clawbox "$GIT fetch origin" 2>&1)"; then
      [ -z "$out" ] || printf '%s\n' "$out" >&2
      return 0
    fi
    [ "$attempt" -ge "$max" ] && break
    git_retryable_failure "$out" || break
    echo "[force-update] fetch attempt $attempt/$max failed, retrying in ${delay}s..." >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
  printf '%s\n' "$out" >&2
  case "$out" in
    *"could not read Username"*|*"could not read Password"*|*"Repository not found"*)
      echo "[force-update] GitHub refused this device's anonymous request for the repository." >&2
      echo "[force-update] It is public and needs no password — GitHub answers 401 to anonymous git" >&2
      echo "[force-update] requests from an address that has made too many. Wait a few minutes and re-run." >&2
      ;;
  esac
  return 1
}

GIT="git -c safe.directory=$PROJECT_DIR -C $PROJECT_DIR"

BUILD_DIR="$PROJECT_DIR/.next"
KEPT_DIR="$PROJECT_DIR/.next-old"

# What a failure has to undo, set as each thing happens. give_up reads them.
PREV_HEAD=""     # the commit checked out before this run
PREV_BRANCH=""   # the branch it was on; empty for a detached HEAD
MOVED=0          # the checkout may have left PREV_HEAD
INSTALLED=0      # `bun install` ran against the new commit's lockfile
PARKED=0         # the serving build is parked at $KEPT_DIR
NO_FALLBACK=0    # too little space to park: the build runs over the serving one
BUILD_LOG_DIR=""
BUILD_LOG=""

# Same test as install.sh's build_entry_present: `-L` too, because postbuild's
# nested layout makes the entry a symlink to an absolute path that dangles
# while its tree is parked.
build_entry_present() {
  [ -e "$1/standalone/server.js" ] || [ -L "$1/standalone/server.js" ]
}

# The same question install.sh's verify_build_present asks after its build —
# the file the service loads exists, and the build on disk names the commit
# that is checked out (scripts/verify-build-identity.sh, the one copy of that
# logic). Copied rather than shared for the reason the fetch retry above is:
# this script must run when install.sh and the in-app updater cannot.
verify_build_present() {
  if [ ! -f "$BUILD_DIR/standalone/server.js" ]; then
    echo "[force-update] No $BUILD_DIR/standalone/server.js — the build produced nothing the dashboard can load" >&2
    return 1
  fi
  if [ ! -f "$PROJECT_DIR/scripts/verify-build-identity.sh" ]; then
    echo "[force-update] WARNING: scripts/verify-build-identity.sh is missing — the build's identity was not checked" >&2
    return 0
  fi
  if ! bash "$PROJECT_DIR/scripts/verify-build-identity.sh" --project-dir "$PROJECT_DIR" --quiet; then
    echo "[force-update] The build on disk does not name the checked-out commit" >&2
    return 1
  fi
}

# Next prints this line, and only this line, on the way out of a build that
# failed. The exit status is the first verdict; this is the second, so that a
# status lost anywhere between `next build` and this shell can never be read as
# a build that worked. One awk, for the reason given at the retry below.
build_error_in_log() {
  awk '/Build error occurred/ { hit = 1 } END { exit hit ? 0 : 1 }' "$1"
}

# Park the serving build at $KEPT_DIR so a failed build can be undone — the
# same move install.sh's set_previous_build_aside makes, and read that function
# for the reasoning; only the shape is repeated here.
#
#   - A build a killed update left parked is the box's ONLY build when `.next`
#     has no entry, so it is put back before anything deletes it.
#   - A filesystem that cannot hold two builds gets no park: the build then
#     runs over the serving one exactly as it always did here, and says so.
#   - The parked tree is stamped with this shell's PID, the boot id and this
#     process's start time: production-server.js refuses its boot-time reclaim
#     of `.next-old` only while that stamp names a live process, so a service
#     restart during the build cannot pull the parked tree out from under it,
#     and a stamp left by a killed run is ignored.
park_serving_build() {
  local need avail boot_id="" start_time=""
  if ! build_entry_present "$BUILD_DIR" && build_entry_present "$KEPT_DIR"; then
    echo "[force-update] Putting back the build an interrupted update left at $KEPT_DIR..."
    if ! rm -rf "$BUILD_DIR" || ! mv -T "$KEPT_DIR" "$BUILD_DIR"; then
      echo "[force-update] Could not put the parked build back" >&2
      return 1
    fi
    rm -f "$BUILD_DIR/.rebuild-pid" || true
  fi
  if ! rm -rf "$KEPT_DIR"; then
    echo "[force-update] Could not clear $KEPT_DIR before parking the build" >&2
    return 1
  fi
  [ -d "$BUILD_DIR" ] || return 0
  need="$(du -sk "$BUILD_DIR" 2>/dev/null | awk '{print $1}')"
  avail="$(df -Pk "$BUILD_DIR" 2>/dev/null | awk 'NR==2 {print $4}')"
  case "$need"  in ''|*[!0-9]*) need="" ;; esac
  case "$avail" in ''|*[!0-9]*) avail="" ;; esac
  if [ -n "$need" ] && [ -n "$avail" ] && [ "$avail" -lt "$((need * 2))" ]; then
    echo "[force-update] Only ${avail}K free for a ${need}K build — building over the current one, so a failed build has nothing to fall back on" >&2
    NO_FALLBACK=1
    return 0
  fi
  boot_id="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" || boot_id=""
  start_time="$(sed -e 's/^.*) //' "/proc/$$/stat" 2>/dev/null | awk '{print $20}')" || start_time=""
  case "$start_time" in ''|*[!0-9]*) start_time="" ;; esac
  if [ -z "$boot_id" ] || [ -z "$start_time" ] \
     || ! printf '%s %s %s\n' "$$" "$boot_id" "$start_time" > "$BUILD_DIR/.rebuild-pid"; then
    echo "[force-update] Warning: could not stamp the parked build as this run's — a dashboard restarting mid-build may reclaim it" >&2
  fi
  echo "[force-update] Setting the serving build aside..."
  # `-T`: with $KEPT_DIR present a bare `mv` would move the build inside it.
  if ! mv -T "$BUILD_DIR" "$KEPT_DIR"; then
    rm -f "$BUILD_DIR/.rebuild-pid" || true
    echo "[force-update] Could not set the serving build aside" >&2
    return 1
  fi
  PARKED=1
}

restore_serving_build() {
  [ "$PARKED" -eq 1 ] || return 0
  if [ ! -d "$KEPT_DIR" ]; then
    echo "[force-update] The parked build is gone from $KEPT_DIR — there is no previous build to put back" >&2
    return 1
  fi
  if ! rm -rf "$BUILD_DIR" || ! mv -T "$KEPT_DIR" "$BUILD_DIR"; then
    echo "[force-update] Could not put the previous build back — it is still at $KEPT_DIR" >&2
    return 1
  fi
  # The stamp said "a rebuild owns this tree"; it must not ride along into the
  # build the box serves.
  rm -f "$BUILD_DIR/.rebuild-pid" || true
  PARKED=0
  echo "[force-update] Put the previous build back."
}

roll_back_checkout() {
  [ "$MOVED" -eq 1 ] || return 0
  if [ -z "$PREV_HEAD" ]; then
    echo "[force-update] The commit checked out before this run could not be read, so the checkout stays where it is" >&2
    return 1
  fi
  if [ -n "$PREV_BRANCH" ]; then
    if ! run_as_clawbox "$GIT checkout -f $PREV_BRANCH" || ! run_as_clawbox "$GIT reset --hard $PREV_HEAD"; then
      echo "[force-update] Could not move the checkout back to $PREV_BRANCH @ ${PREV_HEAD:0:7}" >&2
      return 1
    fi
  elif ! run_as_clawbox "$GIT checkout -f --detach $PREV_HEAD"; then
    echo "[force-update] Could not move the checkout back to ${PREV_HEAD:0:7}" >&2
    return 1
  fi
  MOVED=0
  echo "[force-update] Checkout rolled back to ${PREV_BRANCH:-a detached HEAD} @ ${PREV_HEAD:0:7}."
  # node_modules was installed for the lockfile of the commit that failed; put
  # it back in step with the one that is checked out again. Best-effort: the
  # restored build carries its own traced node_modules in .next/standalone.
  if [ "$INSTALLED" -eq 1 ] && ! run_as_clawbox "cd $PROJECT_DIR && $BUN_BIN install"; then
    echo "[force-update] Warning: bun install for the restored commit failed — run it again before the next build" >&2
  fi
}

# Undo, say what happened, exit non-zero. Every failure after the checkout
# starts to move ends here, and so does an interrupt (an SSH session dropping
# mid-build is SIGHUP), so no path out of this script leaves HEAD on a commit
# whose build is not the one being served.
give_up() {
  local why="$1" code="$2"
  set +e
  trap - HUP INT TERM
  echo "[force-update] $why — rolling back." >&2
  restore_serving_build
  roll_back_checkout
  if [ -n "$BUILD_LOG" ] && [ -s "$BUILD_LOG" ]; then
    echo "[force-update] Last 30 lines of the build output:" >&2
    tail -n 30 "$BUILD_LOG" >&2
  fi
  if [ -n "$BUILD_LOG_DIR" ]; then rm -rf "$BUILD_LOG_DIR"; fi
  # Nothing is restarted onto a build that failed. The service was never
  # stopped, so it is still up on the build that was put back — unless it went
  # down while that build was parked, and then it is brought back on it.
  if systemctl is-active --quiet clawbox-setup; then
    echo "[force-update] clawbox-setup was not restarted: it is still serving the previous build." >&2
  else
    echo "[force-update] clawbox-setup is not running — starting it again on the previous build." >&2
    sudo systemctl restart clawbox-setup || true
  fi
  if [ "$MOVED" -eq 1 ] || [ "$PARKED" -eq 1 ]; then
    echo "[force-update] FAILED (exit $code), and the rollback did not complete — see the lines above." >&2
  elif [ "$NO_FALLBACK" -eq 1 ]; then
    echo "[force-update] FAILED (exit $code). The checkout is back, but there was no room to keep the previous build: the dashboard has nothing to load on its next restart until a build succeeds." >&2
  else
    echo "[force-update] FAILED (exit $code). Nothing was updated." >&2
  fi
  exit "$code"
}
trap 'give_up "Interrupted (SIGHUP)" 129' HUP
trap 'give_up "Interrupted (SIGINT)" 130' INT
trap 'give_up "Interrupted (SIGTERM)" 143' TERM

echo "[force-update] Fixing .git ownership (any root-owned bits left by install.sh)..."
sudo chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/.git"

# Where the rollback goes back to. A SHA is hex and nothing else; a branch name
# git accepts can still hold characters the `bash -c` strings must not see, so
# one outside the safe set is rolled back to as a detached HEAD instead.
PREV_HEAD="$(run_as_clawbox "$GIT rev-parse --verify --quiet HEAD" 2>/dev/null || true)"
if ! [[ "$PREV_HEAD" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
  PREV_HEAD=""
  echo "[force-update] Warning: could not read the commit checked out now — a failed build cannot be rolled back" >&2
fi
PREV_BRANCH="$(run_as_clawbox "$GIT symbolic-ref --quiet --short HEAD" 2>/dev/null || true)"
if ! [[ "$PREV_BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]]; then PREV_BRANCH=""; fi

echo "[force-update] Hard-syncing $PROJECT_DIR to $UPSTREAM..."
fetch_with_retry
MOVED=1
if ! run_as_clawbox "$GIT reset --hard HEAD" \
   || ! run_as_clawbox "$GIT checkout $TARGET_BRANCH 2>/dev/null || $GIT checkout -b $TARGET_BRANCH $UPSTREAM" \
   || ! run_as_clawbox "$GIT reset --hard $UPSTREAM" \
   || ! run_as_clawbox "$GIT clean -fd"; then
  give_up "Could not sync the checkout to $UPSTREAM" 1
fi

HEAD_SHA=$(run_as_clawbox "$GIT rev-parse --short HEAD") || HEAD_SHA="?"
echo "[force-update] Now at $TARGET_BRANCH @ $HEAD_SHA"

echo "[force-update] Rebuilding (this takes 1-3 minutes on Jetson)..."
INSTALLED=1
if ! run_as_clawbox "cd $PROJECT_DIR && $BUN_BIN install"; then
  give_up "bun install failed" 1
fi

if ! park_serving_build; then
  give_up "Could not set the serving build aside" 1
fi

# ONE retry, and only for the mid-build file-trace race — the same guard
# `run_next_build` carries in install.sh, copied rather than shared because
# this script is standalone by design (it is what an operator runs when the
# in-app updater is already broken) and has its own helper names. See that
# function for why the race exists and why one rebuild is the whole repair.
#
# `tee` truncates the log on every attempt, so what the checks below read is
# the LAST attempt's output — a retry that worked is judged on its own run.
# A private `mktemp -d` directory, never a predictable path — this script runs
# as root and a fixed name under TMPDIR is a symlink a local user can plant.
# See run_next_build in install.sh.
BUILD_LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/clawbox-force-update-XXXXXX" 2>/dev/null || true)"
if [ -n "$BUILD_LOG_DIR" ]; then BUILD_LOG="$BUILD_LOG_DIR/build.log"; fi
BUILD_RC=0
for BUILD_ATTEMPT in 1 2; do
  if [ -n "$BUILD_LOG" ]; then
    if run_as_clawbox "cd $PROJECT_DIR && $BUN_BIN run build" 2>&1 | tee "$BUILD_LOG"; then
      BUILD_RC=0
      break
    fi
    # The BUILD's status, never the pipeline's: a log this script could not
    # write must not turn a build that worked into a failed recovery.
    BUILD_RC=${PIPESTATUS[0]}
    if [ "$BUILD_RC" -eq 0 ]; then break; fi
  else
    if run_as_clawbox "cd $PROJECT_DIR && $BUN_BIN run build"; then BUILD_RC=0; else BUILD_RC=$?; fi
    break
  fi
  if [ "$BUILD_ATTEMPT" -eq 2 ]; then break; fi
  # One awk, not two greps in a pipe — see run_next_build in install.sh.
  awk '/ENOENT.*copyfile/ && !/Failed to copy traced files for/ { hit = 1 } END { exit hit ? 0 : 1 }' "$BUILD_LOG" || break
  echo "[force-update] A file the build was tracing changed while it ran — building once more"
done

# Three verdicts, and the build has to pass all of them before anything is
# restarted onto it: its exit status, its own output, and what it left on disk.
if [ "$BUILD_RC" -ne 0 ]; then
  give_up "Build failed (exit $BUILD_RC)" "$BUILD_RC"
fi
if [ -n "$BUILD_LOG" ] && build_error_in_log "$BUILD_LOG"; then
  give_up "Build failed (it exited 0, but printed \"Build error occurred\")" 1
fi
if ! verify_build_present; then
  give_up "Build failed (it exited 0, but left no build the dashboard can serve)" 1
fi

if [ -n "$BUILD_LOG_DIR" ]; then rm -rf "$BUILD_LOG_DIR"; fi
BUILD_LOG=""
if [ "$PARKED" -eq 1 ]; then
  # The new build passed; the parked one is only disk now. A tree left behind
  # is harmless — the next park clears it — so this does not fail the run.
  rm -rf "$KEPT_DIR" || echo "[force-update] Warning: could not remove the previous build at $KEPT_DIR" >&2
  PARKED=0
fi
MOVED=0
trap - HUP INT TERM

echo "[force-update] Restarting clawbox-setup..."
sudo systemctl restart clawbox-setup
sleep 5
if systemctl is-active --quiet clawbox-setup; then
  echo "[force-update] The ClawBox interface is restored."
  echo "[force-update] IMPORTANT: this recovered the UI only. OpenClaw and system"
  echo "[force-update]   services may still be on the OLD version — the interface"
  echo "[force-update]   being current does NOT mean the update finished."
  echo "[force-update] To finish: open http://clawbox.local, launch the System Update"
  echo "[force-update]   app (Settings -> About -> System Update), open 'Advanced"
  echo "[force-update]   options' and click 'Force full update'. The device reboots"
  echo "[force-update]   when it completes."
else
  echo "[force-update] WARNING: clawbox-setup failed to come up. Check 'sudo journalctl -u clawbox-setup -n 50'." >&2
  exit 1
fi
