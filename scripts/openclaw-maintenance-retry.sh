#!/usr/bin/env bash
# Run one OpenClaw CLI command, and ask again while the core answers that its
# state is under offline maintenance. The shell twin of
# src/lib/openclaw-maintenance.ts, which says why at length.
#
#   openclaw-maintenance-retry.sh <openclaw> <args...>
#
# The pinned core (2026.10.6, as 2026.10.3) refuses every command that reads its
# config while another process holds the state as `sqlite-maintenance` — a
# gateway start's own CLI bootstrap, a `doctor --fix` — with "…undergoing offline
# maintenance; retry when it finishes." (2026.10.3 also printed "…retry after
# maintenance finishes." for a half-written owner record; 2026.10.6 says "restart
# the Gateway" there, which is not a retry and is not matched). It refuses
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

out="$(mktemp 2>/dev/null)" || exec "$@"
err="$(mktemp 2>/dev/null)" || { rm -f "$out"; exec "$@"; }
trap 'rm -f "$out" "$err"' EXIT
# A caller's `timeout` signals this script and the ask together: what the ask
# had printed is still handed on, as it would have been without the wrapper.
trap 'cat "$out"; cat "$err" >&2; exit 143' TERM INT

# The window is counted on the box's monotonic clock, /proc/uptime (`read` is
# a builtin: no fork). bash's SECONDS is wall clock, and the gateway's pre-start
# calls this at boot, the minute timesyncd steps the clock of a box with no RTC
# forward — half a day after a night off — which ended the window at once.
# SECONDS only where /proc/uptime cannot be read, and then for the whole run:
# the first reading latches the clock, and a run begun on /proc/uptime that
# loses it carries on by SECONDS from its last uptime reading (`offset`), so the
# window never compares one clock with the other.
clock=""
offset=0
now_s() {
  local up rest
  if [ "$clock" != "seconds" ]; then
    read -r up rest 2>/dev/null </proc/uptime || up=""
    up="${up%%.*}"
    if [[ "$up" =~ ^[0-9]+$ ]]; then
      now="$up"
      clock=uptime
      offset=$(( up - SECONDS ))
      return 0
    fi
    [ -n "$clock" ] || clock=seconds
  fi
  now=$(( SECONDS + offset ))
}
now_s
started=$now
while :; do
  rc=0
  "$@" >"$out" 2>"$err" || rc=$?
  if [ "$rc" -ne 0 ] && grep -qiE 'retry (when it|after maintenance) finishes' "$out" "$err"; then
    now_s
    if [ $((now - started + pause)) -le "$window" ]; then
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
