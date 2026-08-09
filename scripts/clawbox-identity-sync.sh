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

# Self-heal: if the shared-identity bridge was never established (e.g. the very
# first harness switch on a device), bootstrap it now so the sync has a source.
if [ ! -d "$CANON" ]; then
  echo "[identity-sync] canonical dir missing — bootstrapping via setup-shared-identity.sh"
  bash "$(dirname "$0")/setup-shared-identity.sh" || {
    echo "[identity-sync] bootstrap failed; nothing to sync" >&2
    exit 1
  }
fi

# 1. OpenClaw ← canonical (real copies).
if [ -d "$OC_WS" ]; then
  for f in SOUL USER MEMORY; do
    [ -f "$CANON/$f.md" ] && cp "$CANON/$f.md" "$OC_WS/$f.md"
  done
  # Refresh the gateway's cached workspace-file scan (best-effort).
  sudo -n /usr/bin/systemctl restart clawbox-gateway.service 2>/dev/null || \
    systemctl --user restart clawbox-gateway 2>/dev/null || true
fi

# 2. Hermes ← canonical (symlinks already live) → reindex FTS5.
# Prefer the configured Hermes CLI (HERMES_BIN, matching src/lib/harness.ts's
# default), falling back to PATH. `hermes memory reindex` rebuilds the recall
# index from the markdown; fall back to `sync` on older builds. Non-fatal.
HERMES="${HERMES_BIN:-$HOME_DIR/.local/bin/hermes}"
[ -x "$HERMES" ] || HERMES="$(command -v hermes || true)"
if [ -n "$HERMES" ] && [ -x "$HERMES" ]; then
  # Surface a reindex failure to the caller (the select route reports it) rather
  # than swallowing it: a stale FTS5 index means Hermes won't see refreshed
  # memory. `set -e` propagates a non-zero exit if BOTH reindex and the sync
  # fallback fail.
  "$HERMES" memory reindex >/dev/null 2>&1 || "$HERMES" sync >/dev/null 2>&1
fi

echo "[identity-sync] done"
