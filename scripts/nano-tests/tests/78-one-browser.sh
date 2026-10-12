#!/usr/bin/env bash
# timeout: 240
#
# One browser per box. The Chromium on the remote desktop and the browser the
# assistant drives are the same process on the same profile, kept running by
# the web server (src/lib/shared-browser.ts). A box used to have two: the
# gateway started a hidden Chromium of its own, on a profile of its own, when
# the desktop one was not open.
#
# Runs after 75-full-reboot, so the browser this finds is one the box brought
# back by itself after a reboot.
#
#   * Exactly one browser process serves a DevTools port, on the profile the
#     Browser app reports, and none runs on a gateway-managed profile.
#   * The gateway's config points its browser tool at that browser and forbids
#     it to launch one (attach-only), on an edition that has the gateway.
#   * Close in the Browser app is refused for it and the process is still
#     there afterwards, with the same pid.
#
# Skips where Chromium is not installed, and where the owner chose the
# isolated assistant browser (CLAWBOX_BROWSER_AGENT_ISOLATED=1).
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

board_api GET /setup-api/browser/manage
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

# "top <pid> <profile>" per top-level browser process serving a DevTools port
# (a renderer or helper carries --type=), then "managed <n>" for processes on a
# gateway-managed profile, then "gateway <absent|attachOnly cdpUrl default>".
# The keeper looks every twenty seconds, so a board fresh from a reboot is
# given ninety to show its browser.
# shellcheck disable=SC2016  # expanded on the board
SURVEY='
  # The command line is read as ONE string: a running Chromium rewrites the
  # command lines of its child processes into a single space-joined argument,
  # so a per-argument match would miss their --type= and count every renderer.
  survey() {
    for d in /proc/[0-9]*; do
      [ -r "$d/cmdline" ] || continue
      args=" $(tr "\0" " " < "$d/cmdline" 2>/dev/null)"
      case "$args" in *" --remote-debugging-port="*) ;; *) continue ;; esac
      case "$args" in *" --type="*) continue ;; esac
      prof=$(grep -o -- "--user-data-dir=[^ ]*" <<<"$args" | head -n 1)
      echo "top ${d#/proc/} ${prof#--user-data-dir=}"
    done
  }
  for _ in $(seq 1 18); do
    [ -n "$(survey)" ] && break
    sleep 5
  done
  survey
  echo "managed $(pgrep -fc -- "--user-data-dir=[^ ]*/\.openclaw/browser/" 2>/dev/null || echo 0)"
  cfg="$HOME/.openclaw/openclaw.json"
  if [ -f "$cfg" ]; then
    python3 - "$cfg" <<PY
import json, sys
try:
    b = json.load(open(sys.argv[1])).get("browser") or {}
except Exception as e:
    print("gateway unreadable", e); raise SystemExit
p = (b.get("profiles") or {}).get("clawbox") or {}
print("gateway", p.get("attachOnly"), p.get("cdpUrl"), b.get("defaultProfile"))
PY
  else
    echo "gateway absent"
  fi
'
ANSWER=$(board "$SURVEY")
TOPS=$(grep '^top ' <<<"$ANSWER")
COUNT=$(grep -c '^top ' <<<"$ANSWER")
while IFS= read -r line; do [ -z "$line" ] || note "browser: $line"; done <<<"$TOPS"

if [ "$COUNT" -eq 1 ]; then
  ok "exactly one browser process serves a DevTools port"
else
  not_ok "$COUNT browser processes serve a DevTools port, not one"
fi
read -r _ PID FOUND_PROFILE <<<"$(head -n 1 <<<"$TOPS")"
if [ "${FOUND_PROFILE%/}" = "${PROFILE%/}" ]; then
  ok "it runs on the profile the Browser app reports"
else
  not_ok "it runs on '${FOUND_PROFILE:-?}', not on $PROFILE"
fi
MANAGED=$(sed -n 's/^managed //p' <<<"$ANSWER" | head -n 1)
if [ "${MANAGED:-0}" = 0 ]; then
  ok "no browser runs on a gateway-managed profile"
else
  not_ok "$MANAGED process(es) still run on a gateway-managed browser profile"
fi

GATEWAY=$(sed -n 's/^gateway //p' <<<"$ANSWER" | head -n 1)
case "$GATEWAY" in
  absent) note "no gateway config on this board: nothing to attach" ;;
  "True http://127.0.0.1:$PORT clawbox") ok "the gateway attaches to that browser and never launches one" ;;
  *) not_ok "the gateway's browser config is '$GATEWAY', not attach-only on port $PORT as the default profile" ;;
esac

board_api POST /setup-api/browser/manage '{"action":"close-browser"}'
if [ "$API_STATUS" = 409 ] && [ "$(api_json '.code')" = shared_browser ]; then
  ok "Close is refused for the shared browser"
else
  not_ok "close-browser answered $API_STATUS $(api_json '.code'), not 409 shared_browser"
fi
# shellcheck disable=SC2016  # expanded on the board
STILL=$(board 'sleep 3; [ -d "/proc/$1" ] && echo alive || echo gone' "${PID:-0}")
if [ "$(head -n 1 <<<"$STILL")" = alive ]; then
  ok "the browser is still running after Close, same pid"
else
  not_ok "the browser (pid ${PID:-?}) was gone after Close"
fi

finish
