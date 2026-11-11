#!/usr/bin/env bash
# timeout: 2100
# tier: long
# covers: config/org-staff-policy.json scripts/org-staff-policy.js scripts/gateway-user-relay.js src/lib/org-staff-*.ts src/lib/hermes-staff-profile.ts scripts/openclaw-plugins/clawbox-staff-guard/* scripts/hermes-plugins/clawbox_staff_guard/* src/app/setup-api/hermes/chat/route.ts scripts/nano-tests/board/org-mode-staff.mjs
#
# An organisation box's limited assistant and private memory (TASK-2444,
# TASK-2445), for real, on whichever agent runtime the board runs:
#
#   1. The owner adds two users and turns organisation mode on — on OpenClaw
#      each gets their own agent on the roster with the staff tool policy, on
#      Hermes their own profile on their first turn.
#   2. As member of staff A: a web search, an e-mail, a scheduled job, a shell
#      command, flipping the box's tools.profile, and changing the model —
#      each refused (no such tool ran; the command never reached the runtime).
#   3. As the owner: the same requests — each allowed (the tool ran; the
#      command reached the runtime). The job the owner's request made is
#      removed again.
#   4. Memory: A asks the assistant to remember a fact; it is in A's own
#      workspace/profile, B cannot get it back, the owner's MEMORY.md is
#      unchanged.
#   5. The owner turns the switch off and removes both users: the staff agents
#      leave the roster and their folders go with them.
#
# Long tier: a dozen real model turns per runtime. A pull request touching the
# files above gets it with `long` ticked (docs/nano-hardware-tests.md).
#
# The transcripts (what each asked, which tools ran, what the assistant said)
# are NOTE lines in this test's log. Cookies are minted on the board from
# data/.session-secret and never leave it; scripts/nano-tests/board/
# org-mode-staff.mjs drives the chats.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# shellcheck disable=SC2016  # expanded on the board, not here
FLOW='
MARK="nanoci$(tr -dc a-z0-9 </dev/urandom | head -c 8)"
A_NAME="nanocia$(tr -dc a-z0-9 </dev/urandom | head -c 5)"
B_NAME="nanocib$(tr -dc a-z0-9 </dev/urandom | head -c 5)"
A_PASS="$(tr -dc A-Za-z0-9 </dev/urandom | head -c 24)"
B_PASS="$(tr -dc A-Za-z0-9 </dev/urandom | head -c 24)"
SECRET_FILE="$REPO/data/.session-secret"
say() { printf "RESULT %s\n" "$*"; }
if systemctl is-active -q clawbox-gateway.service; then RUNTIME=openclaw; else RUNTIME=hermes; fi

owner_cookie() {
  node -e '"'"'
    const fs = require("fs"), crypto = require("crypto");
    const secret = fs.readFileSync(process.argv[1], "utf8").trim();
    let gen = 0;
    try { const c = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); if (Number.isFinite(c.session_generation)) gen = c.session_generation; } catch {}
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, gen })).toString("base64url");
    process.stdout.write(payload + "." + crypto.createHmac("sha256", secret).update(payload).digest("hex"));
  '"'"' "$SECRET_FILE" "$REPO/data/config.json"
}

# call METHOD PATH COOKIE [BODY] -> status on the first line, body after.
call() {
  local method=$1 path=$2 cookie=$3 body=${4:-} out code extra=()
  [ -n "$body" ] && extra=(-H "Content-Type: application/json" --data-binary "$body")
  out=$(mktemp)
  code=$(printf "header = \"Cookie: clawbox_session=%s\"\nheader = \"Origin: http://127.0.0.1\"\n" "$cookie" \
    | curl -sS -o "$out" -w "%{http_code}" -X "$method" --max-time 180 "${extra[@]}" -K - "$DASHBOARD$path" 2>/dev/null)
  printf "%s\n" "${code:-000}"; cat "$out"; rm -f "$out"
}
status_of() { printf "%s\n" "$1" | head -n1; }

sign_in() {
  local name=$1 pass=$2 jar login cookie
  jar=$(mktemp)
  login=$(printf "%s" "{\"username\":\"$name\",\"password\":\"$pass\",\"duration\":3600}" \
    | curl -sS -c "$jar" -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" --max-time 60 --data-binary @- "$DASHBOARD/login-api")
  cookie=$(awk '"'"'$6 == "clawbox_session" { print $7 }'"'"' "$jar"); rm -f "$jar"
  [ "$login" = 200 ] && printf "%s" "$cookie"
}

staff_on_roster() {
  python3 -c "import json,sys; c=json.load(open(sys.argv[1])); e=(c.get(\"agents\") or {}).get(\"entries\") or {}; print(len([k for k in e if k.startswith(\"clawbox-staff-\")]))" "$HOME/.openclaw/openclaw.json" 2>/dev/null || echo 0
}

cleanup() {
  call POST /setup-api/settings/org-mode "$OWNER" "{\"orgMode\":false}" >/dev/null 2>&1 || true
  call DELETE /setup-api/users "$OWNER" "{\"username\":\"$A_NAME\"}" >/dev/null 2>&1 || true
  call DELETE /setup-api/users "$OWNER" "{\"username\":\"$B_NAME\"}" >/dev/null 2>&1 || true
}

if [ ! -r "$SECRET_FILE" ]; then say "not ok - $SECRET_FILE is not readable as the box account"; exit 0; fi
OWNER=$(owner_cookie)
trap cleanup EXIT
printf "NOTE [%s] runtime under test: %s\n" "$RUNTIME" "$RUNTIME"

# 1. Two users, signed in, and the switch on.
for pair in "$A_NAME:$A_PASS" "$B_NAME:$B_PASS"; do
  r=$(call POST /setup-api/users "$OWNER" "{\"username\":\"${pair%%:*}\",\"password\":\"${pair#*:}\"}")
  [ "$(status_of "$r")" = 201 ] || { say "not ok - [$RUNTIME] creating a user answered $(status_of "$r")"; exit 0; }
done
A_COOKIE=$(sign_in "$A_NAME" "$A_PASS"); B_COOKIE=$(sign_in "$B_NAME" "$B_PASS")
[ -n "$A_COOKIE" ] && [ -n "$B_COOKIE" ] || { say "not ok - [$RUNTIME] the two users could not sign in"; exit 0; }
r=$(call POST /setup-api/settings/org-mode "$OWNER" "{\"orgMode\":true}")
if [ "$(status_of "$r")" = 200 ]; then say "ok - [$RUNTIME] the owner turned organisation mode on"; else say "not ok - [$RUNTIME] turning organisation mode on answered $(status_of "$r")"; exit 0; fi
# A member opening their chat asks ws-config first, as the desktop does.
call GET /setup-api/gateway/ws-config "$A_COOKIE" >/dev/null
call GET /setup-api/gateway/ws-config "$B_COOKIE" >/dev/null

# 2-4. The chats.
cd "$REPO" && A_NAME="$A_NAME" A_COOKIE="$A_COOKIE" B_NAME="$B_NAME" B_COOKIE="$B_COOKIE" OWNER_COOKIE="$OWNER" MARK="$MARK" RUNTIME="$RUNTIME" REPO="$REPO" \
  timeout 1900 node "$REPO/scripts/nano-tests/board/org-mode-staff.mjs" 2>&1 | grep -E "^(RESULT|NOTE) " || say "not ok - [$RUNTIME] the chat driver printed nothing"

# 5. Off, and the users gone.
trap - EXIT
cleanup
if [ "$RUNTIME" = openclaw ]; then
  left=$(staff_on_roster)
  [ "$left" = 0 ] && say "ok - [$RUNTIME] the switch off takes every staff agent off the roster" || say "not ok - [$RUNTIME] $left staff agent(s) still on the roster"
  [ ! -e "$HOME/.openclaw/staff/$A_NAME" ] && say "ok - [$RUNTIME] a removed member'"'"'s workspace goes with them" || say "not ok - [$RUNTIME] the removed member'"'"'s workspace is still there"
else
  [ ! -e "$HOME/.hermes/profiles/clawbox-staff-$A_NAME" ] && say "ok - [$RUNTIME] a removed member'"'"'s profile goes with them" || say "not ok - [$RUNTIME] the removed member'"'"'s profile is still there"
fi
'

out=$(board "$FLOW")
results=$(printf '%s\n' "$out" | grep -E '^(RESULT|NOTE) ')
if [ -z "$results" ]; then
  not_ok "the organisation-mode staff flow printed nothing on the board"
  printf '%s\n' "$out" | tail -n 20 | while IFS= read -r line; do note "$line"; done
else
  while IFS= read -r line; do
    case "$line" in
      "RESULT ok - "*) ok "${line#RESULT ok - }" ;;
      "RESULT not ok - "*) printf 'not ok - %s\n' "${line#RESULT not ok - }" ;;
      "NOTE "*) note "${line#NOTE }" ;;
    esac
  done <<<"$results"
  grep -q '^RESULT not ok - ' <<<"$results" && NANO_TEST_FAILED=1
fi
finish
