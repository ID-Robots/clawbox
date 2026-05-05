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
run_as_clawbox "cd $PROJECT_DIR && $BUN_BIN run build"

echo "[force-update] Restarting clawbox-setup..."
sudo systemctl restart clawbox-setup
sleep 5
if systemctl is-active --quiet clawbox-setup; then
  echo "[force-update] Done. Reload http://clawbox.local in your browser."
else
  echo "[force-update] WARNING: clawbox-setup failed to come up. Check 'sudo journalctl -u clawbox-setup -n 50'." >&2
  exit 1
fi
