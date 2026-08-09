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

[ -d "$CANON" ] || { echo "[identity-sync] no canonical dir; run setup-shared-identity.sh first" >&2; exit 1; }

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
if command -v hermes >/dev/null 2>&1; then
  # `hermes memory reindex` rebuilds the recall index from the markdown; fall
  # back to `sync` on older builds. Non-fatal if neither exists.
  hermes memory reindex >/dev/null 2>&1 || hermes sync >/dev/null 2>&1 || true
fi

echo "[identity-sync] done"
