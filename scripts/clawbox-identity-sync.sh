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

# The gateway restart, and whether it actually happened.
#
# This restart is not a nicety attached to the sync - for OpenClaw it IS the
# sync. The copies below land on disk in a directory the gateway already scanned
# and cached at start, so until it restarts, OpenClaw keeps answering as whoever
# it was before. The old form ended `|| true`, which turned "the identity did not
# change" into "[identity-sync] done" and exit 0 - and left the caller's own
# guard unreachable: /setup-api/harness/select refuses to switch harnesses when
# this script fails, and this script could not fail.
#
# System unit first, user unit as the fallback for a dev box; a non-zero return
# means NEITHER worked.
restart_openclaw_gateway() {
  sudo -n /usr/bin/systemctl restart clawbox-gateway.service 2>/dev/null && return 0
  systemctl --user restart clawbox-gateway 2>/dev/null && return 0
  return 1
}

# Is there a systemd MANAGER to talk to — not merely a systemctl binary?
#
# `command -v systemctl` is not that question. Plenty of containers ship
# /usr/bin/systemctl with no manager behind it, and on one of those every
# restart attempt fails for a reason that is not the device's: the harness
# switch would 502 on a box where there is no gateway to refresh in the first
# place. That is the false-FAILURE twin of the bug this file is fixing.
#
# `is-system-running` answers by TEXT, not by exit status, because the status is
# non-zero for `degraded` — an ordinary state on these devices, and one where
# systemd is very much running. Only "no answer at all" and an explicit
# `offline` mean there is no manager.
systemd_scope_running() {
  local answer
  case "$1" in
    user) answer="$(systemctl --user is-system-running 2>/dev/null)" ;;
    *)    answer="$(systemctl is-system-running 2>/dev/null)" ;;
  esac
  case "$answer" in
    ""|offline|unknown) return 1 ;;
    *) return 0 ;;
  esac
}

# BOTH scopes, because restart_openclaw_gateway tries both. A host with an
# offline system manager and a reachable USER manager that refused the unit has
# had its refresh refused, not skipped — and reporting that as "nothing to do
# here" is the same silence this file exists to remove, one level up.
systemd_manager_available() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemd_scope_running system && return 0
  systemd_scope_running user && return 0
  return 1
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
    if restart_openclaw_gateway; then
      echo "[identity-sync] clawbox-gateway restarted; OpenClaw has re-read the identity files"
    elif ! systemd_manager_available; then
      # No init to ask - a dev checkout, or a container with the binary but no
      # manager. There is no running gateway holding a stale copy either, so
      # nothing was left undone.
      echo "[identity-sync] no systemd manager on this host; skipping the gateway refresh"
    else
      echo "[identity-sync] could not restart clawbox-gateway: OpenClaw would keep" >&2
      echo "  answering as whoever it was before this sync. Refusing to report success." >&2
      exit 1
    fi
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
