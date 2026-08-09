#!/usr/bin/env bash
# Propagate the canonical shared identity to both harnesses. Run on
# harness-switch and whenever ~/.clawbox/agent-identity/* changes (a systemd
# path unit or the harness/select route can invoke it).
#
#   * OpenClaw: refresh the REAL copies (its scanner ignores symlinks) and
#     restart the gateway so the workspace-file scan re-reads the new content
#     (OpenClaw caches injected file content at gateway start).
#   * Hermes: its identity files are symlinks (already live), but its state.db
#     FTS5 recall must re-index to see external markdown edits.
#
# Canonical is authoritative (edit there). Edits made from inside a harness are
# NOT auto-propagated back in this version — that reverse sync is future work.
set -euo pipefail

HOME_DIR="${HOME:-/home/clawbox}"
CANON="$HOME_DIR/.clawbox/agent-identity"
OC_WS="$HOME_DIR/.openclaw/workspace"

# Optional target harness ("openclaw" | "hermes"). The harness/select route
# passes the harness it is switching TO; the systemd path unit (canonical
# changed) invokes us with no argument.
#
# The gateway restart below exists only to make a RUNNING OpenClaw gateway
# re-read the refreshed workspace files (it caches them at start). Restarting it
# is pointless — and harmful — when OpenClaw isn't the harness in play: on a
# switch to Hermes it would bounce the gateway for ~30 s, during which OpenClaw
# reports itself "not available" and switching back is rejected. So restart the
# gateway only when OpenClaw is the target (or, for the no-arg path-unit case,
# the currently active harness). The on-disk copies are refreshed either way, so
# the next switch back to OpenClaw still starts it with current identity.
TARGET_HARNESS="${1:-}"
CONFIG_JSON="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/data/config.json"

resolve_active_harness() {
  node -e 'try{const c=require(process.argv[1]);process.stdout.write(String(c.active_harness||"openclaw"))}catch(e){process.stdout.write("openclaw")}' "$CONFIG_JSON" 2>/dev/null || echo openclaw
}

should_refresh_openclaw() {
  if [ "$TARGET_HARNESS" = "openclaw" ]; then
    return 0
  elif [ -z "$TARGET_HARNESS" ] && [ "$(resolve_active_harness)" = "openclaw" ]; then
    return 0
  fi
  return 1
}

# Self-heal: if the shared-identity bridge was never established (e.g. the very
# first harness switch on a device), bootstrap it now so the sync has a source.
if [ ! -d "$CANON" ]; then
  echo "[identity-sync] canonical dir missing — bootstrapping via setup-shared-identity.sh"
  bash "$(dirname "$0")/setup-shared-identity.sh" || {
    echo "[identity-sync] bootstrap failed; nothing to sync" >&2
    exit 1
  }
fi

# 1. OpenClaw ← canonical (real copies). Always refresh the on-disk copies so
# the next OpenClaw start reads current identity; only bounce the running
# gateway when OpenClaw is actually the harness in play (see above).
if [ -d "$OC_WS" ]; then
  for f in SOUL USER MEMORY; do
    [ -f "$CANON/$f.md" ] && cp "$CANON/$f.md" "$OC_WS/$f.md"
  done
  if should_refresh_openclaw; then
    # Refresh the gateway's cached workspace-file scan (best-effort).
    sudo -n /usr/bin/systemctl restart clawbox-gateway.service 2>/dev/null || \
      systemctl --user restart clawbox-gateway 2>/dev/null || true
  fi
fi

# 2. Hermes ← canonical: the symlinks placed by setup-shared-identity.sh ARE the
# sync. Hermes's built-in memory (MEMORY.md/USER.md) is always active and read
# directly from those files — in this Hermes there is NO separate recall index
# to rebuild. `hermes memory` only manages external provider plugins
# (honcho/mem0/…) and exposes just setup/status/off/reset; there is no
# `reindex`/`sync` memory subcommand. The previous `hermes memory reindex ||
# hermes sync` therefore invoked a non-existent command (and the unrelated
# skill-`sync`), which under the service environment failed `set -e` and blocked
# every harness switch with "Identity synchronization failed". The symlinks are
# authoritative and live, so there is nothing further to do for Hermes here.

echo "[identity-sync] done"
