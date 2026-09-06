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
  if [ "$(id -un)" = "$CLAWBOX_USER" ]; then
    bash -c "$1"
  else
    sudo -u "$CLAWBOX_USER" bash -c "$1"
  fi
}

GIT="git -c safe.directory=$PROJECT_DIR -C $PROJECT_DIR"

echo "[force-update] Fixing .git ownership (any root-owned bits left by install.sh)..."
sudo chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/.git"

echo "[force-update] Hard-syncing $PROJECT_DIR to $UPSTREAM..."
run_as_clawbox "$GIT fetch origin"
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
BUILD_LOG="${TMPDIR:-/tmp}/clawbox-force-update-build.log"
: > "$BUILD_LOG" 2>/dev/null || BUILD_LOG=""
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
if [ -n "$BUILD_LOG" ]; then rm -f "$BUILD_LOG"; fi
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
