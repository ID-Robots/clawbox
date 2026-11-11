#!/usr/bin/env bash
# Which update run is which, for scripts/nano-tests/tests/92-update-raw-log.sh,
# read off the box's own record of the run it started last
# (data/update-logs/latest, src/lib/update-raw-log.ts) — by run identity, never
# by comparing the runner's clock with the board's.
#
# Sourced. Needs a `board SCRIPT [ARG...]` function (lib.sh's runs the script on
# the board with $REPO set; src/tests/unit/nano-update-raw-log-runs.test.ts
# runs it locally against a fixture folder).

# latest_run — prints the id of the run the box started last ("" when the box
# has no pointer yet) and returns 0; returns 1, printing nothing, when the
# pointer could not be READ: the hop failed, the file is there and unreadable,
# or a folder on the way cannot be searched (where "no such file" would only
# mean "cannot see"). A read error is never an empty answer.
latest_run() {
  local out
  # shellcheck disable=SC2016  # expanded on the board
  out=$(board '
d="$REPO/data/update-logs"; f="$d/latest"
if [ -e "$f" ]; then
  if id=$(cat "$f" 2>/dev/null); then printf "POINTER %s\n" "$(printf %s "$id" | tr -d "[:space:]")"
  else echo "POINTER_UNREADABLE"; fi
elif [ -d "$d" ] && [ -x "$d" ] && [ -r "$d" ]; then echo "POINTER"
elif [ ! -e "$d" ] && [ -d "$REPO/data" ] && [ -x "$REPO/data" ] && [ -r "$REPO/data" ]; then echo "POINTER"
else echo "POINTER_UNREADABLE"
fi') || return 1
  # Only a hop that ended well answers: one that failed after printing a
  # valid-looking line is a failed read all the same.
  out=$(printf '%s\n' "$out" | grep -E '^POINTER( |$)' | tail -n 1)
  [ -n "$out" ] || return 1
  out=${out#POINTER}
  printf '%s' "${out# }"
}

# read_baseline TRIES — sets BEFORE_RUN to the run the box started last, read
# for certain: up to TRIES reads, a few seconds apart. Returns 1 when none
# could be read, so the caller stops instead of comparing with an empty
# baseline that would make the previous run look new.
BEFORE_RUN=
read_baseline() {
  local try id
  for ((try = 1; try <= $1; try++)); do
    if id=$(latest_run); then
      BEFORE_RUN=$id
      return 0
    fi
    [ "$try" -lt "$1" ] && sleep "${BASELINE_RETRY_S:-5}"
  done
  return 1
}

# new_run_finished — the box has started a run since BEFORE_RUN was read, and
# that run is marked finished: a completion the test never saw running is this
# test's run, not an earlier update's "completed". An unchanged pointer, an
# unfinished run, a pointer that cannot be read and a hop to the board that
# ended badly (whatever it printed first) all answer no.
new_run_finished() {
  local id finished
  id=$(latest_run) || return 1
  [ -n "$id" ] && [ "$id" != "$BEFORE_RUN" ] || return 1
  # shellcheck disable=SC2016  # expanded on the board
  finished=$(board 'python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(\"finished\") is True)" "$REPO/data/update-logs/$1.json" 2>/dev/null' "$id") || return 1
  [ "$(printf '%s\n' "$finished" | tail -n 1)" = True ]
}

# log_limit_ok — reads `systemctl show -p LogRateLimitIntervalUSec -p
# LogRateLimitBurst -p NeedDaemonReload <unit>` on stdin and succeeds when
# systemd will hand journald a limit no update step reaches: a positive
# interval (0, or unset, is journald's own default of 10000 lines per 30 s,
# which dropped a rebuild's lines by the thousand), a burst of at least
# LOG_BURST_MIN lines, and the unit loaded as it is on disk. Otherwise it says
# why on stdout and fails.
#
# For a unit that is running, the input may also carry what systemd handed
# journald for it — the /run/systemd/units/log-rate-limit-{interval,burst}:<unit>
# links journald reads — as `Exported_interval=<usec|none>` and
# `Exported_burst=<lines|none>`: then those must be that limit too, since a
# limit loaded after the unit started never reaches journald for it.
LOG_BURST_MIN=1000000
log_limit_ok() {
  local line interval="" burst="" reload="" exported_interval="" exported_burst=""
  while IFS= read -r line; do
    case "$line" in
      LogRateLimitIntervalUSec=*) interval=${line#*=} ;;
      LogRateLimitBurst=*) burst=${line#*=} ;;
      NeedDaemonReload=*) reload=${line#*=} ;;
      Exported_interval=*) exported_interval=${line#*=} ;;
      Exported_burst=*) exported_burst=${line#*=} ;;
    esac
  done
  if [ -n "$exported_interval$exported_burst" ]; then
    case "$exported_interval" in
      '' | none | 0 | *[!0-9]*)
        echo "journald was handed no interval for the running unit (${exported_interval:-unset}): its default applies"
        return 1
        ;;
    esac
    case "$exported_burst" in
      '' | none | *[!0-9]*)
        echo "journald was handed no burst for the running unit (${exported_burst:-unset}): its default applies"
        return 1
        ;;
    esac
    if [ "$exported_burst" -lt "$LOG_BURST_MIN" ]; then
      echo "journald was handed a burst of $exported_burst lines for the running unit, under $LOG_BURST_MIN"
      return 1
    fi
  fi
  if [ -z "$interval" ] || [ "$interval" = 0 ]; then
    echo "LogRateLimitIntervalUSec=${interval:-unset}: journald applies its default limit to it"
    return 1
  fi
  case "$burst" in
    '' | *[!0-9]*) echo "LogRateLimitBurst=${burst:-unset} is not a line count"; return 1 ;;
  esac
  if [ "$burst" -lt "$LOG_BURST_MIN" ]; then
    echo "LogRateLimitBurst=$burst is under $LOG_BURST_MIN lines"
    return 1
  fi
  if [ "$reload" != no ]; then
    echo "NeedDaemonReload=${reload:-unset}: systemd has not loaded the unit file on disk"
    return 1
  fi
}

# rebuild_unit_shown — asks the board about clawbox-root-update@rebuild_reboot:
# while it runs, prints RUNNING, then its `systemctl show` lines for
# log_limit_ok and what systemd handed journald for it (Exported_*; or
# `Exported=unreadable`); prints nothing while it does not run. A oneshot unit
# is "activating" for as long as its step runs — it is never "active" — so both
# count. Fails when the hop to the board failed.
rebuild_unit_shown() {
  # shellcheck disable=SC2016  # expanded on the board
  board 'u=clawbox-root-update@rebuild_reboot.service
case "$(systemctl is-active "$u" 2>/dev/null)" in
  active | activating | reloading) ;;
  *) exit 0 ;;
esac
echo RUNNING
systemctl show -p ActiveState -p LogRateLimitIntervalUSec -p LogRateLimitBurst -p NeedDaemonReload -p DropInPaths "$u"
if [ -r /run/systemd/units ] && [ -x /run/systemd/units ]; then
  for k in interval burst; do printf "Exported_%s=%s\n" "$k" "$(readlink "/run/systemd/units/log-rate-limit-$k:$u" 2>/dev/null || echo none)"; done
else
  echo "Exported=unreadable"
fi'
}
