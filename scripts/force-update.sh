#!/usr/bin/env bash
# scripts/force-update.sh
#
# Self-heal a ClawBox device that can't update through the UI because the
# updater itself is broken. First restores the updater UI, then hands off to
# the existing authenticated update route so the normal full updater owns
# OpenClaw installation, reboot continuation, and gateway verification.
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

echo "[force-update] Destructive cleanup begins in 5 seconds..."
sleep 5

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
if ! systemctl is-active --quiet clawbox-setup; then
  echo "[force-update] WARNING: clawbox-setup failed to come up. Check 'sudo journalctl -u clawbox-setup -n 50'." >&2
  exit 1
fi

echo "[force-update] Updater UI restored at $TARGET_BRANCH @ $HEAD_SHA."
echo "[force-update] This is NOT a completed system update; OpenClaw has not yet been verified."

MCP_TOKEN_FILE="$PROJECT_DIR/data/.mcp-token"

echo "[force-update] Waiting for the restored local updater API..."
SETUP_READY=0
for _attempt in $(seq 1 60); do
  # Require the exact 200 from the local setup-status route. curl otherwise
  # treats a 307/login redirect as success, which could make us hand off to an
  # app that is not actually ready.
  SETUP_STATUS="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1/setup-api/setup/status" 2>/dev/null || true)"
  if [ "$SETUP_STATUS" = "200" ]; then
    SETUP_READY=1
    break
  fi
  sleep 1
done
if [ "$SETUP_READY" -ne 1 ]; then
  echo "[force-update] ERROR: updater UI was rebuilt, but its API did not become ready." >&2
  echo "[force-update] Full update NOT started; OpenClaw was NOT updated." >&2
  exit 1
fi
if [ ! -s "$MCP_TOKEN_FILE" ]; then
  echo "[force-update] ERROR: local updater credential is missing: $MCP_TOKEN_FILE" >&2
  echo "[force-update] Full update NOT started; OpenClaw was NOT updated." >&2
  exit 1
fi

MCP_TOKEN="$(tr -d '\r\n' < "$MCP_TOKEN_FILE")"
AUTH_HEADER_FILE="$(mktemp)"
chmod 600 "$AUTH_HEADER_FILE"
trap 'rm -f "$AUTH_HEADER_FILE"' EXIT
printf 'Authorization: Bearer %s\n' "$MCP_TOKEN" > "$AUTH_HEADER_FILE"
unset MCP_TOKEN
HANDOFF_RESPONSE=""
# Reuse the exact route/UI state machine used by the setup wizard. `force`
# deliberately bypasses a stale update_completed flag on an already-current
# checkout. The route remains protected by the existing per-install MCP
# bearer and startUpdate's running lock makes duplicate in-flight requests
# idempotently reject; no reusable unauthenticated recovery endpoint is added.
if ! HANDOFF_RESPONSE="$(curl -fsS --max-time 10 \
  -H "@$AUTH_HEADER_FILE" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  --data-binary '{"force":true}' \
  "http://127.0.0.1/setup-api/update/run")"; then
  echo "[force-update] ERROR: updater UI is available, but the authenticated full-update handoff failed." >&2
  echo "[force-update] Full update NOT confirmed started; OpenClaw was NOT updated." >&2
  exit 1
fi
if ! printf '%s' "$HANDOFF_RESPONSE" | grep -Eq '"started"[[:space:]]*:[[:space:]]*true'; then
  # An already-deployed continuation helper can win the race on a device
  # carrying a valid post-reboot flag. Treat that as accepted only after an
  # authenticated status read proves the normal updater is actually running.
  UPDATE_STATUS_RESPONSE=""
  if printf '%s' "$HANDOFF_RESPONSE" | grep -q 'Update already in progress'; then
    UPDATE_STATUS_RESPONSE="$(curl -fsS --max-time 10 \
      -H "@$AUTH_HEADER_FILE" \
      -H "Accept: application/json" \
      "http://127.0.0.1/setup-api/update/status" 2>/dev/null || true)"
  fi
  if ! printf '%s' "$UPDATE_STATUS_RESPONSE" | grep -Eq '"phase"[[:space:]]*:[[:space:]]*"running"'; then
    echo "[force-update] ERROR: full updater rejected the authenticated handoff: $HANDOFF_RESPONSE" >&2
    echo "[force-update] OpenClaw was NOT updated by this bootstrap step." >&2
    exit 1
  fi
fi

echo "[force-update] Full updater handoff accepted."
echo "[force-update] The normal workflow is now updating OpenClaw, rebuilding ClawBox,"
echo "[force-update] continuing after reboot, and verifying the gateway. This shell may disconnect."
echo "[force-update] Full update is complete ONLY when the System Update UI reports completion."
