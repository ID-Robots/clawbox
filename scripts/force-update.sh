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

# One attempt is a coin flip: GitHub refuses anonymous git-upload-pack POSTs
# from an address that has made too many, ~2 in 3 when measured (TASK-655).
# install.sh's git_with_retry is not sourceable from here (that file is an
# installer, not a library), so this is the same three-attempt shape inline.
fetch_with_retry() {
  local attempt=1 max="${CLAWBOX_GIT_RETRIES:-3}" delay="${CLAWBOX_GIT_RETRY_DELAY:-3}" out
  while :; do
    if out="$(run_as_clawbox "$GIT fetch origin" 2>&1)"; then
      [ -z "$out" ] || printf '%s\n' "$out" >&2
      return 0
    fi
    [ "$attempt" -ge "$max" ] && break
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
run_as_clawbox "cd $PROJECT_DIR && $BUN_BIN run build"

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
