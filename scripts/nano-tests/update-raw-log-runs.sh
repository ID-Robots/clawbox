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
