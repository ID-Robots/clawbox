#!/usr/bin/env bash
# timeout: 900
# covers: src/lib/project-folder.ts src/lib/store-install.ts src/lib/store-install-receipt.ts src/lib/store-search.ts
# covers: src/lib/app-proxy.ts src/lib/app-server-start.ts src/lib/webapp-icon.ts scripts/app-port.js
# covers: src/app/setup-api/apps/* src/app/setup-api/webapps/* src/app/apps/*
#
# A ClawBox server app from the Store (Audiobook Player) on a box whose owner
# never chose a project folder — the state a fresh or factory-reset box is in:
#
#   1. The project folder in force is ~/Projects (no config key at all).
#   2. The Store's search finds the app by its slug, hyphens and all.
#   3. It installs with no "set a project folder first" refusal, into
#      ~/Projects/<id>, carrying the Store's receipt.
#   4. Its desktop address sends the frame on to /apps/<id>/ with a redirect,
#      and that document opens with the owner's session — not the box's login
#      page — once the app answers; without a session it still asks to log in.
#   5. Uninstall removes it, and a reinstall answers ok again, into the same
#      folder, with the same redirect (its build is not waited for a second
#      time: one build of a Next app is most of the deadline on a Nano).
#
# NOT `parallel:` — it changes config.json and installs an app. The owner's own
# project folder, if the board has one, is put back on the way out, and the
# app is uninstalled. The owner's cookie exists only on the board. Skipped when
# the Store does not list the app.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# shellcheck disable=SC2016  # expanded on the board
FLOW='
say() { printf "RESULT %s\n" "$*"; }
SECRET_FILE="$REPO/data/.session-secret"
CONFIG="$REPO/data/config.json"
APP=audiobook-player
FOLDER="$HOME/Projects/$APP"

owner_cookie() {
  node -e "
    const fs = require(\"fs\"), crypto = require(\"crypto\");
    const secret = fs.readFileSync(process.argv[1], \"utf8\").trim();
    let gen = 0;
    try { const c = JSON.parse(fs.readFileSync(process.argv[2], \"utf8\")); if (Number.isFinite(c.session_generation)) gen = c.session_generation; } catch {}
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, gen })).toString(\"base64url\");
    process.stdout.write(payload + \".\" + crypto.createHmac(\"sha256\", secret).update(payload).digest(\"hex\"));
  " "$SECRET_FILE" "$CONFIG"
}

# call METHOD PATH [BODY] [MAX_TIME] — as the signed-in owner.
call() {
  local method=$1 path=$2 body=${3:-} max=${4:-120} out code extra=()
  [ -n "$body" ] && extra=(-H "Content-Type: application/json" --data-binary "$body")
  out=$(mktemp)
  code=$(printf "header = \"Cookie: clawbox_session=%s\"\nheader = \"Origin: http://127.0.0.1\"\n" "$COOKIE" \
    | curl -sS -o "$out" -w "%{http_code}" -X "$method" --max-time "$max" "${extra[@]}" -K - "$DASHBOARD$path" 2>/dev/null)
  printf "%s\n" "${code:-000}"; cat "$out"; rm -f "$out"
}
status_of() { printf "%s\n" "$1" | head -n1; }
body_of() { printf "%s\n" "$1" | tail -n +2; }
py() { python3 -c "import json,sys; j=json.load(sys.stdin); a=sys.argv[2:]; print(eval(sys.argv[1]))" "$@" 2>/dev/null; }

# doc PATH [cookie|none] — what a desktop window loading PATH gets: "<status> <redirect>".
doc() {
  local jar=""
  [ "${2:-cookie}" = cookie ] && jar="header = \"Cookie: clawbox_session=$COOKIE\""
  printf "%s\n" "$jar" | curl -sS -o /dev/null -w "%{http_code} %{redirect_url}" --max-time 30 -K - \
    -H "Sec-Fetch-Dest: iframe" -H "Sec-Fetch-Mode: navigate" -H "Sec-Fetch-Site: same-origin" -H "Accept: text/html" \
    "$DASHBOARD$1" 2>/dev/null
}

# set_folder VALUE — "" removes the key, the way a factory reset leaves config.json.
set_folder() {
  python3 -c "
import json, os, sys
p, v = sys.argv[1], sys.argv[2]
c = json.load(open(p))
if v: c[\"coding_agent_default_directory\"] = v
else: c.pop(\"coding_agent_default_directory\", None)
t = p + \".nano-tmp\"
open(t, \"w\").write(json.dumps(c, indent=2))
os.chmod(t, 0o600)
os.replace(t, p)
" "$CONFIG" "$1"
}

uninstall() { call POST /setup-api/apps/uninstall "{\"appId\":\"$APP\"}" 60; }
# install MAX_SECONDS
install() { call POST /setup-api/apps/install "{\"appId\":\"$APP\",\"source\":\"clawbox\"}" "$1"; }
T0=$(date +%s)
left() { local n=$(( T0 + $1 - $(date +%s) )); [ "$n" -lt 30 ] && n=30; echo "$n"; }

# wait_open UNTIL — poll the desktop address until /apps/<id>/ answers 200 (the
# app builds and starts after install), at most until T0+UNTIL; echoes the last answer.
wait_open() {
  local end=$(( T0 + $1 )) first second
  while :; do
    first=$(doc "/setup-api/webapps?app=$APP")
    second=$(doc "/apps/$APP/")
    case "$second" in 200*) break ;; esac
    [ "$(date +%s)" -ge "$end" ] && break
    sleep 10
  done
  printf "%s | %s\n" "$first" "$second"
}

if [ ! -r "$SECRET_FILE" ]; then say "not ok - $SECRET_FILE is not readable as the box account"; exit 0; fi
COOKIE=$(owner_cookie)
SAVED=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(\"coding_agent_default_directory\") or \"\")" "$CONFIG" 2>/dev/null)
cleanup() {
  uninstall >/dev/null 2>&1
  [ -n "$SAVED" ] && set_folder "$SAVED"
}
trap cleanup EXIT

r=$(call GET "/setup-api/apps/store?limit=200&q=audiobook%20player")
if [ "$(status_of "$r")" != 200 ] || [ "$(body_of "$r" | py "any(a.get(\"slug\") == sys.argv[2] for a in j.get(\"apps\", []))" "$APP")" != True ]; then
  say "skip the Store does not list $APP here: HTTP $(status_of "$r")"; exit 0
fi

uninstall >/dev/null 2>&1
set_folder ""
r=$(call GET /setup-api/coding-agent/status)
DIR=$(body_of "$r" | py "j.get(\"defaultDirectory\")")
[ "$DIR" = "$HOME/Projects" ] && say "ok - with no folder chosen the project folder in force is ~/Projects" \
  || say "not ok - with no folder chosen the status names \"$DIR\" (HTTP $(status_of "$r"))"

r=$(call GET "/setup-api/apps/store?limit=200&q=$APP")
[ "$(body_of "$r" | py "[a.get(\"slug\") for a in j.get(\"apps\", [])].count(sys.argv[2])" "$APP")" = 1 ] \
  && say "ok - the Store search finds $APP by its slug, hyphens and all" \
  || say "not ok - the Store search for \"$APP\" did not list it once: HTTP $(status_of "$r") $(body_of "$r" | head -c 200)"

for round in install reinstall; do
  if [ "$round" = install ]; then r=$(install "$(left 480)"); else r=$(install "$(left 840)"); fi
  if [ "$(status_of "$r")" = 200 ] && [ "$(body_of "$r" | py "j.get(\"ok\")")" = True ]; then
    say "ok - $round: the Store installed $APP with no project folder chosen"
  else
    say "not ok - $round: the install answered HTTP $(status_of "$r") $(body_of "$r" | py "j.get(\"error\")" | head -c 300)"; exit 0
  fi
  [ -f "$FOLDER/clawbox.json" ] && [ -f "$FOLDER/.clawbox/store-app.json" ] \
    && say "ok - $round: it is in ~/Projects/$APP with the Store receipt, owned by $(stat -c %U "$FOLDER")" \
    || say "not ok - $round: ~/Projects/$APP has no clawbox.json or no Store receipt"
  if [ "$round" = install ]; then
    OPEN=$(wait_open 640)
    case "$OPEN" in
      "302 "*"/apps/$APP/ | 200 "*) say "ok - $round: the desktop address redirects to /apps/$APP/, which opens with the owner session" ;;
      *"/login"*) say "not ok - $round: the app window lands on the login page: $OPEN" ;;
      *) say "not ok - $round: the app window did not open: $OPEN" ;;
    esac
  else
    OPEN="$(doc "/setup-api/webapps?app=$APP") | $(doc "/apps/$APP/")"
    case "$OPEN" in
      "302 "*"/apps/$APP/ | "*"/login"*) say "not ok - $round: the app window lands on the login page: $OPEN" ;;
      "302 "*"/apps/$APP/ | "*) say "ok - $round: the desktop address redirects to /apps/$APP/ again ($OPEN)" ;;
      *) say "not ok - $round: the desktop address did not redirect to /apps/$APP/: $OPEN" ;;
    esac
  fi
  ANON=$(doc "/apps/$APP/" none)
  case "$ANON" in 307*"/login"*) say "ok - $round: without a session /apps/$APP/ still asks to log in" ;; *) say "not ok - $round: without a session /apps/$APP/ answered $ANON" ;; esac
  if [ "$round" = install ]; then
    r=$(uninstall)
    [ "$(status_of "$r")" = 200 ] && [ ! -e "$FOLDER" ] && say "ok - uninstall removed $APP and its folder" \
      || say "not ok - uninstall answered HTTP $(status_of "$r"), folder $( [ -e "$FOLDER" ] && echo still there || echo gone)"
  fi
done
'

out=$(board "$FLOW")
results=$(printf '%s\n' "$out" | grep '^RESULT ' | sed 's/^RESULT //')
if [ -z "$results" ]; then
  not_ok "the Store server-app flow printed nothing on the board"
  printf '%s\n' "$out" | tail -n 20 | while IFS= read -r line; do note "$line"; done
else
  printf '%s\n' "$results" | while IFS= read -r line; do
    case "$line" in
      "ok - "*) ok "${line#ok - }" ;;
      "not ok - "*) printf 'not ok - %s\n' "${line#not ok - }" ;;
      "skip "*) skip "${line#skip }" ;;
      *) note "$line" ;;
    esac
  done
  printf '%s\n' "$results" | grep -q '^not ok - ' && NANO_TEST_FAILED=1
fi
finish
