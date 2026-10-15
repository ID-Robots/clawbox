#!/usr/bin/env bash
# Run one OpenClaw CLI command, and ask again while the core answers that its
# state is under offline maintenance. The shell twin of
# src/lib/openclaw-maintenance.ts, which says why at length.
#
#   openclaw-maintenance-retry.sh <openclaw> <args...>
#
# The pinned core (2026.10.3) refuses every command that reads its config while
# another process holds the state as `sqlite-maintenance` — a gateway start's
# own CLI bootstrap, a `doctor --fix` — with "…undergoing offline maintenance;
# retry when it finishes." (or "…retry after maintenance finishes."). It refuses
# before the command acts, so asking again is safe, and the core offers no flag,
# variable or exit code to wait for it.
#
# Bounded twice: CLAWBOX_OPENCLAW_MAINTENANCE_WINDOW_S (25) from the first ask,
# and by whatever `timeout` the caller wraps this script in, which ends it with
# the command. The LAST ask's stdout and stderr are replayed on the same streams
# when it ends, so a caller reads what it always read. Exit: the last ask's
# status, or 75 (EX_TEMPFAIL) when the core was still refusing for maintenance at
# the end of the window — "the core is busy", never "the core said no".
#
# Not for a command fed on stdin: each ask inherits this script's stdin. Not for
# a long runner whose output should stream (`doctor --fix`): output is replayed
# when an ask ends, or when `timeout` signals this script, never live.
set -uo pipefail

window="${CLAWBOX_OPENCLAW_MAINTENANCE_WINDOW_S:-25}"
pause="${CLAWBOX_OPENCLAW_MAINTENANCE_PAUSE_S:-2}"

[ "$#" -ge 1 ] || { echo "usage: $0 <openclaw> <args...>" >&2; exit 64; }

out="$(mktemp 2>/dev/null)" && err="$(mktemp 2>/dev/null)" || exec "$@"
trap 'rm -f "$out" "$err"' EXIT
# A caller's `timeout` signals this script and the ask together: what the ask
# had printed is still handed on, as it would have been without the wrapper.
trap 'cat "$out"; cat "$err" >&2; exit 143' TERM INT

started=$SECONDS
while :; do
  rc=0
  "$@" >"$out" 2>"$err" || rc=$?
  if [ "$rc" -ne 0 ] && grep -qiE 'retry (when it|after maintenance) finishes' "$out" "$err"; then
    if [ $((SECONDS - started + pause)) -le "$window" ]; then
      sleep "$pause"
      continue
    fi
    cat "$out"
    cat "$err" >&2
    echo "openclaw-maintenance-retry: OpenClaw was still finishing maintenance on its state after ${window}s" >&2
    exit 75
  fi
  cat "$out"
  cat "$err" >&2
  exit "$rc"
done
