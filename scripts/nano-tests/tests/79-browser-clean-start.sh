#!/usr/bin/env bash
# timeout: 420
# covers: src/lib/shared-browser*.ts src/lib/browser-*.ts src/lib/desktop-browser-config.ts src/lib/chromium-sandbox.ts src/lib/cdp-probe.ts src/app/setup-api/browser/* scripts/launch-browser.sh scripts/lib/browser-clean-start.sh config/clawbox-browser.service mcp/tools/browser.ts
# covers: src/components/* src/hooks/* public/* src/app/*page.tsx src/app/*layout.tsx src/app/globals.css src/lib/*-translations*.ts src/lib/edition-translations/* src/lib/i18n.tsx
#
# The shared browser starts clean (scripts/lib/browser-clean-start.sh): the
# window on the remote desktop no longer collects tabs across restarts.
#
#   * With three tabs open, the browser is stopped — once cleanly (its unit
#     stopped, as a reboot does), once hard (SIGKILL, as a crash or a power cut
#     does: a "Crashed" exit in its preferences) — and its profile is set to
#     bring the last session back. Started again with the Browser app's Open it
#     comes back with exactly ONE tab, none of the three, and with
#     --hide-crash-restore-bubble on its command line. (Before the clean start,
#     the clean stop brought back all three plus another blank tab.)
#   * Started a second time while it runs — Open again, and the unit's own
#     launch script — it is the same process and still has one tab.
#
# Skips where Chromium is not installed, and where the owner chose the
# isolated assistant browser (CLAWBOX_BROWSER_AGENT_ISOLATED=1).
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

for _ in 1 2 3 4 5 6; do
  board_api GET /setup-api/browser/manage
  [ "$API_STATUS" = 200 ] && break
  sleep 10
done
if [ "$API_STATUS" != 200 ]; then
  not_ok "GET /setup-api/browser/manage answered $API_STATUS: $(api_error)"
  finish
fi
if [ "$(api_json '.chromium.installed')" != true ]; then
  skip "Chromium is not installed on this board"
  finish
fi
if [ "$(api_json '.sharedWithAssistant')" != true ]; then
  skip "this board runs the isolated assistant browser (CLAWBOX_BROWSER_AGENT_ISOLATED)"
  finish
fi
PROFILE=$(api_json '.profileDir')
PORT=$(api_json '.cdpPort')
note "the Browser app names profile $PROFILE, DevTools port $PORT"

# Prepended to the board scripts below. `main_pid PROFILE` prints the browser
# process on the profile (a renderer or helper carries --type=; the command
# line is read as ONE string, see 78-one-browser); `wait_cdp PORT SECONDS`
# waits for the DevTools port; `tabs PORT` prints its target list as JSON.
# shellcheck disable=SC2016  # expanded on the board
FNS='
  main_pid() {
    for d in /proc/[0-9]*; do
      args=" $(tr "\0" " " < "$d/cmdline" 2>/dev/null)"
      case "$args" in *" --user-data-dir=$1 "*|*" --user-data-dir=$1/ "*) ;; *) continue ;; esac
      case "$args" in *" --type="*) continue ;; esac
      echo "${d#/proc/}"
      return 0
    done
    return 1
  }
  wait_cdp() {
    for _ in $(seq 1 "$2"); do
      curl -s -m 2 "http://127.0.0.1:$1/json/version" >/dev/null 2>&1 && return 0
      sleep 1
    done
    return 1
  }
  tabs() { curl -s -m 5 "http://127.0.0.1:$1/json/list" 2>/dev/null; }
'
# The tabs a person sees: page targets, never DevTools' own.
count_tabs() { jq -r '[.[]? | select(.type == "page" and ((.url // "") | startswith("devtools://") | not))] | length' 2>/dev/null <<<"$1"; }

# restart_case NAME HOW — one stop and start of the browser, checked.
#
#   1. Up, with three tabs of our own — the session a restore would bring back.
#   2. Stopped HOW (`stop`: the unit stopped, Chromium ends its session
#      cleanly — what a reboot does; `kill`: SIGKILL, what a crash or a power
#      cut does), then its profile set to restore the last session: the way a
#      box came back with every earlier tab, plus one more blank one, after
#      each restart. In one board script, so the keeper (every 20 s) does not
#      start it again in between.
#   3. Started again the way the owner does it, with Open: one tab, none of
#      the three, a new process, and no "Restore pages?" bubble.
# Sets NEW_PID.
NEW_PID=
restart_case() {
  local name=$1 how=$2 up old_pid before stopped after list tabs
  # shellcheck disable=SC2016  # expanded on the board
  up=$(board "$FNS"'
    wait_cdp "$2" 90 || { echo "down"; exit 0; }
    for i in 1 2 3; do
      curl -s -m 5 -X PUT "http://127.0.0.1:$2/json/new?http%3A%2F%2F127.0.0.1%2Flogin%3Fnano-ci-tab%3D$3-$i" >/dev/null 2>&1
    done
    # Chromium writes its session a few seconds after a change.
    sleep 10
    echo "pid $(main_pid "$1")"
    tabs "$2"
  ' "$PROFILE" "$PORT" "$how")
  if [ "$(head -n 1 <<<"$up")" = down ]; then
    not_ok "$name: the shared browser did not answer on port $PORT within 90 s"
    return 1
  fi
  old_pid=$(sed -n 's/^pid //p' <<<"$up" | head -n 1)
  before=$(count_tabs "$(sed -n '/^\[/,$p' <<<"$up")")
  note "$name: browser pid ${old_pid:-?} with ${before:-?} tabs before it was stopped"
  if [ -z "$old_pid" ] || [ "${before:-0}" -lt 3 ]; then
    not_ok "$name: could not set the test up: pid '${old_pid:-}', ${before:-no} tabs"
    return 1
  fi

  # shellcheck disable=SC2016  # expanded on the board
  stopped=$(board "$FNS"'
    if [ "$3" = kill ]; then
      kill -KILL "$2" 2>/dev/null
    else
      sudo -n /usr/bin/systemctl stop clawbox-browser.service 2>&1 | head -n 2
    fi
    for _ in $(seq 1 60); do main_pid "$1" >/dev/null || break; sleep 0.25; done
    if main_pid "$1" >/dev/null; then echo "running again before the edit"; exit 0; fi
    python3 - "$1/Default/Preferences" <<PY
import json, os, sys
path = sys.argv[1]
with open(path) as f:
    prefs = json.load(f)
print("exit_type", (prefs.get("profile") or {}).get("exit_type"))
prefs.setdefault("session", {})["restore_on_startup"] = 1
with open(path + ".nano-ci", "w") as f:
    json.dump(prefs, f, separators=(",", ":"))
os.replace(path + ".nano-ci", path)
print("restore set")
PY
  ' "$PROFILE" "$old_pid" "$how")
  while IFS= read -r line; do [ -z "$line" ] || note "$name: $line"; done <<<"$stopped"
  if grep -q 'running again before the edit' <<<"$stopped"; then
    note "$name: the keeper started the browser again before its profile could be set to restore; the restart is still checked"
  elif ! grep -qx 'restore set' <<<"$stopped"; then
    not_ok "$name: could not set the stopped browser's profile to restore its session"
  elif [ "$how" = kill ]; then
    if grep -qx 'exit_type Crashed' <<<"$stopped"; then
      ok "$name: the profile records a crashed exit"
    else
      not_ok "$name: the profile does not record a crashed exit: $(grep '^exit_type' <<<"$stopped")"
    fi
  fi

  board_api POST /setup-api/browser/manage '{"action":"open-browser"}'
  [ "$API_STATUS" = 200 ] || not_ok "$name: Open answered $API_STATUS: $(api_error)"
  # shellcheck disable=SC2016  # expanded on the board
  after=$(board "$FNS"'
    wait_cdp "$2" 60 || { echo "down"; exit 0; }
    # Long enough for a restore to have happened, had there been one.
    sleep 8
    pid=$(main_pid "$1")
    echo "pid $pid"
    echo "args $(tr "\0" " " < "/proc/$pid/cmdline" 2>/dev/null)"
    tabs "$2"
  ' "$PROFILE" "$PORT")
  if [ "$(head -n 1 <<<"$after")" = down ]; then
    not_ok "$name: the browser did not come back on port $PORT within 60 s of Open"
    return 1
  fi
  NEW_PID=$(sed -n 's/^pid //p' <<<"$after" | head -n 1)
  list=$(sed -n '/^\[/,$p' <<<"$after")
  tabs=$(count_tabs "$list")
  note "$name: browser pid ${NEW_PID:-?} after the restart, tabs: $(jq -r '[.[]? | select(.type == "page") | .url] | join(" ")' 2>/dev/null <<<"$list")"
  if [ -z "$NEW_PID" ] || [ "$NEW_PID" = "$old_pid" ]; then
    not_ok "$name: no new browser process (pid '${NEW_PID:-}', was $old_pid)"
  fi
  if [ "$tabs" = 1 ]; then
    ok "$name, started again: exactly one tab"
  else
    not_ok "$name, started again: ${tabs:-no} tabs, not one"
  fi
  if grep -q "nano-ci-tab=$how-" <<<"$list"; then
    not_ok "$name: the last session's tabs came back"
  else
    ok "$name: none of the last session's tabs came back"
  fi
  if grep -q -- ' --hide-crash-restore-bubble ' <<<"$(sed -n 's/^args //p' <<<"$after") "; then
    ok "$name: it runs with --hide-crash-restore-bubble"
  else
    not_ok "$name: its command line has no --hide-crash-restore-bubble"
  fi
}

restart_case "after a clean stop" stop
restart_case "after a hard kill" kill

# 4. Started a second time while it runs: Open, then the unit's launch script.
board_api POST /setup-api/browser/manage '{"action":"open-browser"}'
if [ "$API_STATUS" = 200 ] && [ "$(api_json '.alreadyRunning')" = true ]; then
  ok "Open on the running browser brings it forward"
else
  not_ok "Open on the running browser answered $API_STATUS alreadyRunning=$(api_json '.alreadyRunning')"
fi
# shellcheck disable=SC2016  # expanded on the board
AGAIN=$(board "$FNS"'
  out=$(bash "$REPO/scripts/launch-browser.sh" 2>&1); echo "launch rc=$? $out" | head -n 3
  sleep 3
  echo "pid $(main_pid "$1")"
  tabs "$2"
' "$PROFILE" "$PORT")
note "$(grep '^launch ' <<<"$AGAIN")"
AGAIN_PID=$(sed -n 's/^pid //p' <<<"$AGAIN" | head -n 1)
AGAIN_TABS=$(count_tabs "$(sed -n '/^\[/,$p' <<<"$AGAIN")")
grep -q '^launch rc=0 ' <<<"$AGAIN" || not_ok "the launch script on the running browser did not exit 0"
if [ "$AGAIN_TABS" = 1 ] && [ "$AGAIN_PID" = "$NEW_PID" ]; then
  ok "started twice more while running: the same browser, still one tab"
else
  not_ok "after starting it again while running: ${AGAIN_TABS:-no} tabs, pid '${AGAIN_PID:-}' (was $NEW_PID)"
fi

finish
