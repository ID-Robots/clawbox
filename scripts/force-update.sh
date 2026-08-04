#!/usr/bin/env bash
# scripts/force-update.sh
#
# Self-heal a ClawBox device that can't update through the UI because the
# updater itself is broken. This script deliberately stops after restoring
# the setup UI so the operator can review and start the normal full updater
# from there. It does not update OpenClaw, reboot, or verify the gateway.
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

cat <<'WARNING'

!!!!!!!!!!!!!!!!!!!!!!!!!! DESTRUCTIVE RECOVERY !!!!!!!!!!!!!!!!!!!!!!!!!!
The ClawBox checkout is about to be hard-reset and cleaned.

  * ALL changes to tracked files will be discarded.
  * ALL untracked, non-ignored files and directories will be deleted.
  * ClawBox has no supported backup/restore hook for checkout-local
    extensions. Move anything you need to keep outside the checkout now.
  * Git-ignored device state (including data/, .env*, .update-branch,
    node_modules/, and .next/) is outside `git clean -fd` and is preserved.

Press Ctrl-C now if that is not what you intend.
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

WARNING

echo "[force-update] Destructive cleanup begins in 10 seconds..."
sleep 10

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
  cat <<EOF

[force-update] Updater UI restored at $TARGET_BRANCH @ $HEAD_SHA.

RECOVERY IS INCOMPLETE.
The full ClawBox updater has NOT run.
OpenClaw has NOT been updated.
The device has NOT rebooted.
Post-update gateway verification has NOT run.

Next step:
  1. Reload http://clawbox.local and sign in.
  2. Open Settings, then System Update.
  3. Click "Update everything" and wait for the UI to report "Update complete".

Only the normal System Update workflow performs the remaining update, reboot,
and gateway verification steps.
EOF
else
  echo "[force-update] WARNING: clawbox-setup failed to come up. Check 'sudo journalctl -u clawbox-setup -n 50'." >&2
  exit 1
fi
