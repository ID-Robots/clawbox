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
#   CLAWBOX_GIT_RETRIES     — attempts for the fetch (default: 3).
#   CLAWBOX_GIT_RETRY_DELAY — seconds before the first retry, doubling (default: 3).
#   A value that is not a whole number is replaced with the default and a line
#   is printed saying so. Same two knobs, same rule, as install.sh.

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

echo "[force-update] Fixing .git ownership (any root-owned bits left by install.sh)..."
sudo chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/.git"

echo "[force-update] Hard-syncing $PROJECT_DIR to $UPSTREAM..."
fetch_with_retry
run_as_clawbox "$GIT reset --hard HEAD"
run_as_clawbox "$GIT checkout $TARGET_BRANCH 2>/dev/null || $GIT checkout -b $TARGET_BRANCH $UPSTREAM"
run_as_clawbox "$GIT reset --hard $UPSTREAM"
run_as_clawbox "$GIT clean -fd"

HEAD_SHA=$(run_as_clawbox "$GIT rev-parse --short HEAD")
echo "[force-update] Now at $TARGET_BRANCH @ $HEAD_SHA"

echo "[force-update] Rebuilding (this takes 1-3 minutes on Jetson)..."
BUN_BIN="/home/$CLAWBOX_USER/.bun/bin/bun"
if [ ! -x "$BUN_BIN" ]; then
  BUN_BIN="$(command -v bun || echo bun)"
fi
run_as_clawbox "cd $PROJECT_DIR && $BUN_BIN install"

# ONE retry, and only for the mid-build file-trace race — the same guard
# `run_next_build` carries in install.sh, copied rather than shared because
# this script is standalone by design (it is what an operator runs when the
# in-app updater is already broken) and has its own helper names. See that
# function for why the race exists and why one rebuild is the whole repair.
#
# It matters MORE here than there: `git reset --hard` and `git clean -fd` run
# a few lines above, `next build` wipes `.next/standalone` before it copies
# anything, and this path parks NO previous build — so a mid-copy ENOENT
# leaves the box with no standalone entry and nothing to fall back on.
# A private `mktemp -d` directory, never a predictable path — this script runs
# as root and a fixed name under TMPDIR is a symlink a local user can plant.
# See run_next_build in install.sh.
BUILD_LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/clawbox-force-update-XXXXXX" 2>/dev/null || true)"
BUILD_LOG=""
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
if [ -n "$BUILD_LOG_DIR" ]; then rm -rf "$BUILD_LOG_DIR"; fi
if [ "$BUILD_RC" -ne 0 ]; then
  echo "[force-update] Build failed (exit $BUILD_RC)." >&2
  exit "$BUILD_RC"
fi

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
