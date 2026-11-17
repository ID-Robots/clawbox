#!/usr/bin/env bash
# timeout: 900
# covers: scripts/user-limits.js src/lib/user-limits*.ts src/lib/home-usage.ts src/lib/user-upload-guard.ts src/lib/audit-log.ts src/app/setup-api/settings/user-limits/* src/app/setup-api/settings/audit-log/* scripts/nano-tests/board/multi-user-limits.mjs
#
# The owner's limits for every other user, and the audit log (TASK-2446), for
# real, on whichever agent runtime the board runs:
#
#   1. The owner adds a user A (who signs in, and fails once with a wrong
#      password) and sets the limits: 1 MB per upload, a 2 MB home quota, one
#      chat message a minute. A may not read or change them.
#   2. Upload size: A's 2 MB upload to Files and 1.5 MB chat attachment are
#      refused 413 `upload_too_large`, naming the limit, and nothing lands;
#      their small ones go through; the owner's 2 MB upload goes through.
#   3. Chat: A's first turn is taken, the second within the minute is refused
#      by the box (OpenClaw: the relay's RATE_LIMITED; Hermes: 429
#      `rate_limited`), the owner's two turns both run, and A may send again a
#      minute later (scripts/nano-tests/board/multi-user-limits.mjs).
#   4. Home quota: with organisation mode on, A's Files Home is their own
#      home; two 900 KB uploads fit, a third is refused 507 `quota_exceeded`,
#      the owner sees A's usage, and after a delete A may upload again.
#   5. The audit log: the owner reads A's sign-in and failed sign-in, the user
#      added, the limits set and the switch; A is refused it; the file under
#      data/ is 0600.
#
# The limits, the switch and the user are put back on any way out.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# shellcheck disable=SC2016  # expanded on the board, not here
FLOW='
MARK="nanoci$(tr -dc a-z0-9 </dev/urandom | head -c 8)"
A_NAME="nanocil$(tr -dc a-z0-9 </dev/urandom | head -c 5)"
A_PASS="$(tr -dc A-Za-z0-9 </dev/urandom | head -c 24)"
SECRET_FILE="$REPO/data/.session-secret"
WORK=$(mktemp -d)
say() { printf "RESULT %s\n" "$*"; }
if systemctl is-active -q clawbox-gateway.service; then RUNTIME=openclaw; else RUNTIME=hermes; fi
ok_() { say "ok - [$RUNTIME] $*"; }
no_() { say "not ok - [$RUNTIME] $*"; }

owner_cookie() {
  node -e '"'"'
    const fs = require("fs"), crypto = require("crypto");
    const secret = fs.readFileSync(process.argv[1], "utf8").trim();
    let gen = 0;
    try { const c = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); if (Number.isFinite(c.session_generation)) gen = c.session_generation; } catch {}
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200, gen })).toString("base64url");
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
body_of() { printf "%s\n" "$1" | tail -n +2; }
field() { python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get(sys.argv[1], \"\"))" "$1" 2>/dev/null; }

# put_file COOKIE DIR NAME BYTES -> status on the first line, body after.
put_file() {
  local cookie=$1 dir=$2 name=$3 bytes=$4 out code
  head -c "$bytes" /dev/zero > "$WORK/body"
  out=$(mktemp)
  code=$(printf "header = \"Cookie: clawbox_session=%s\"\nheader = \"Origin: http://127.0.0.1\"\n" "$cookie" \
    | curl -sS -o "$out" -w "%{http_code}" -X PUT -H "Content-Type: application/octet-stream" --data-binary "@$WORK/body" --max-time 180 -K - "$DASHBOARD/setup-api/files?dir=$dir&name=$name" 2>/dev/null)
  printf "%s\n" "${code:-000}"; cat "$out"; rm -f "$out"
}

# attach COOKIE FILE -> status on the first line, body after (a picture, so either runtime takes it).
attach() {
  local cookie=$1 file=$2 out code
  out=$(mktemp)
  code=$(printf "header = \"Cookie: clawbox_session=%s\"\nheader = \"Origin: http://127.0.0.1\"\n" "$cookie" \
    | curl -sS -o "$out" -w "%{http_code}" -X POST -F "file=@$file;type=image/png" --max-time 180 -K - "$DASHBOARD/setup-api/chat/attachments" 2>/dev/null)
  printf "%s\n" "${code:-000}"; cat "$out"; rm -f "$out"
}

sign_in() {
  local name=$1 pass=$2 jar login cookie
  jar=$(mktemp)
  login=$(printf "%s" "{\"username\":\"$name\",\"password\":\"$pass\",\"duration\":21600}" \
    | curl -sS -c "$jar" -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" --max-time 60 --data-binary @- "$DASHBOARD/login-api")
  cookie=$(awk '"'"'$6 == "clawbox_session" { print $7 }'"'"' "$jar"); rm -f "$jar"
  [ "$login" = 200 ] && printf "%s" "$cookie"
}

ORIGINAL_LIMITS=""
ORIGINAL_ORG=""
cleanup() {
  local r
  [ -n "$ORIGINAL_LIMITS" ] && r=$(call POST /setup-api/settings/user-limits "$OWNER" "$ORIGINAL_LIMITS") && CLEANUP="limits:$(status_of "$r")"
  # The switch as the test found it, whatever it was.
  r=$(call POST /setup-api/settings/org-mode "$OWNER" "{\"orgMode\":${ORIGINAL_ORG:-false}}" 2>/dev/null || true)
  CLEANUP="$CLEANUP org-restored:$(status_of "$r")"
  r=$(call DELETE /setup-api/users "$OWNER" "{\"username\":\"$A_NAME\"}" 2>/dev/null || true)
  CLEANUP="$CLEANUP delete-user:$(status_of "$r")"
  rm -rf "$HOME/$MARK" "$WORK"
}

if [ ! -r "$SECRET_FILE" ]; then say "not ok - $SECRET_FILE is not readable as the box account"; exit 0; fi
OWNER=$(owner_cookie)
printf "NOTE [%s] runtime under test: %s\n" "$RUNTIME" "$RUNTIME"

# The limits as they were, to put back.
r=$(call GET /setup-api/settings/user-limits "$OWNER")
if [ "$(status_of "$r")" != 200 ]; then no_ "the owner could not read the limits ($(status_of "$r"))"; echo "FLOW-END"; exit 0; fi
ORIGINAL_LIMITS=$(body_of "$r" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)[\"limits\"]))")
r=$(call GET /setup-api/settings/org-mode "$OWNER")
ORIGINAL_ORG=$(body_of "$r" | python3 -c "import json,sys; print(\"true\" if json.load(sys.stdin).get(\"orgMode\") is True else \"false\")" 2>/dev/null)
[ "$ORIGINAL_ORG" = true ] || [ "$ORIGINAL_ORG" = false ] || { no_ "the owner could not read the organisation switch ($(status_of "$r"))"; echo "FLOW-END"; exit 0; }
printf "NOTE [%s] before the test: limits %s, organisation mode %s\n" "$RUNTIME" "$ORIGINAL_LIMITS" "$ORIGINAL_ORG"
trap cleanup EXIT
# Only audit lines written from here on belong to this run.
AUDIT_SINCE=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

# 1. The user, their sign-ins, and the limits.
r=$(call POST /setup-api/users "$OWNER" "{\"username\":\"$A_NAME\",\"password\":\"$A_PASS\"}")
[ "$(status_of "$r")" = 201 ] || { no_ "creating the test user answered $(status_of "$r")"; echo "FLOW-END"; exit 0; }
[ -z "$(sign_in "$A_NAME" "wrong-$A_PASS")" ] && ok_ "a wrong password for A is refused" || no_ "a wrong password for A signed in"
A_COOKIE=$(sign_in "$A_NAME" "$A_PASS")
[ -n "$A_COOKIE" ] || { no_ "A could not sign in"; echo "FLOW-END"; exit 0; }
r=$(call POST /setup-api/settings/user-limits "$OWNER" "{\"uploadMaxMb\":1,\"homeQuotaMb\":2,\"chatPerMinute\":1,\"chatPerHour\":0}")
if [ "$(status_of "$r")" = 200 ]; then ok_ "the owner sets 1 MB uploads, a 2 MB home quota and one chat message a minute"; else no_ "setting the limits answered $(status_of "$r") $(body_of "$r")"; fi
ra=$(call GET /setup-api/settings/user-limits "$A_COOKIE"); rb=$(call POST /setup-api/settings/user-limits "$A_COOKIE" "{\"uploadMaxMb\":0}")
if [ "$(status_of "$ra")" = 403 ] && [ "$(status_of "$rb")" = 403 ]; then ok_ "A may neither read nor change the limits (403/403)"; else no_ "A reading/changing the limits answered $(status_of "$ra")/$(status_of "$rb")"; fi

# 2. Upload size, on a home box: A writes into the owner folders, held to 1 MB.
r=$(call POST /setup-api/settings/org-mode "$OWNER" "{\"orgMode\":false}")
[ "$(status_of "$r")" = 200 ] || no_ "turning organisation mode off for the home-box phase answered $(status_of "$r")"
r=$(put_file "$A_COOKIE" "$MARK" big.bin 2097152)
code=$(body_of "$r" | field code); limit=$(body_of "$r" | field limitBytes)
if [ "$(status_of "$r")" = 413 ] && [ "$code" = upload_too_large ] && [ "$limit" = 1048576 ] && [ ! -e "$HOME/$MARK/big.bin" ]; then
  ok_ "A 2 MB Files upload by A is refused 413 upload_too_large naming the 1 MB limit, and nothing lands"
else no_ "A 2 MB Files upload by A answered $(status_of "$r") $(body_of "$r")"; fi
printf "NOTE [%s] Files refusal: %s\n" "$RUNTIME" "$(body_of "$r" | field error)"
r=$(put_file "$A_COOKIE" "$MARK" small.bin 524288)
[ "$(status_of "$r")" = 200 ] && ok_ "A 512 KB Files upload by A goes through" || no_ "A 512 KB Files upload by A answered $(status_of "$r")"
r=$(put_file "$OWNER" "$MARK" owner.bin 2097152)
[ "$(status_of "$r")" = 200 ] && ok_ "the owner 2 MB Files upload goes through (the owner is never limited)" || no_ "the owner 2 MB upload answered $(status_of "$r")"
{ printf "\x89PNG\r\n\x1a\n"; head -c 1572864 /dev/zero; } > "$WORK/big.png"
printf "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" | base64 -d > "$WORK/tiny.png"
r=$(attach "$A_COOKIE" "$WORK/big.png")
if [ "$(status_of "$r")" = 413 ] && [ "$(body_of "$r" | field code)" = upload_too_large ]; then ok_ "A 1.5 MB chat attachment by A is refused 413 upload_too_large"; else no_ "A 1.5 MB chat attachment by A answered $(status_of "$r") $(body_of "$r")"; fi
r=$(attach "$A_COOKIE" "$WORK/tiny.png")
[ "$(status_of "$r")" = 200 ] && ok_ "A small chat attachment by A goes through" || no_ "A small chat attachment by A answered $(status_of "$r") $(body_of "$r")"

# 3. Chat turns, one a minute (the driver prints its own RESULT lines).
# A member opening their chat asks ws-config first, as the desktop does.
call GET /setup-api/gateway/ws-config "$A_COOKIE" >/dev/null
DRIVER_OUT=$(mktemp)
cd "$REPO" && A_COOKIE="$A_COOKIE" OWNER_COOKIE="$OWNER" MARK="$MARK" RUNTIME="$RUNTIME" REPO="$REPO" \
  timeout 600 node "$REPO/scripts/nano-tests/board/multi-user-limits.mjs" >"$DRIVER_OUT" 2>&1
DRIVER_RC=$?
grep -E "^(RESULT|NOTE) " "$DRIVER_OUT" || no_ "the chat driver printed nothing"
[ "$DRIVER_RC" = 0 ] || no_ "the chat driver ended with status $DRIVER_RC (124: it ran out of time)"
rm -f "$DRIVER_OUT"

# 4. The home quota: an organisation box serves A their own home as Home.
r=$(call POST /setup-api/settings/org-mode "$OWNER" "{\"orgMode\":true}")
[ "$(status_of "$r")" = 200 ] || no_ "turning organisation mode on answered $(status_of "$r")"
call GET "/setup-api/files?dir=" "$A_COOKIE" >/dev/null
q1=$(status_of "$(put_file "$A_COOKIE" Home "$MARK-1.bin" 921600)")
q2=$(status_of "$(put_file "$A_COOKIE" Home "$MARK-2.bin" 921600)")
r=$(put_file "$A_COOKIE" Home "$MARK-3.bin" 921600)
code=$(body_of "$r" | field code)
if [ "$q1:$q2" = 200:200 ] && [ "$(status_of "$r")" = 507 ] && [ "$code" = quota_exceeded ] && [ ! -e "/home/$A_NAME/$MARK-3.bin" ]; then
  ok_ "two 900 KB uploads into A own home fit the 2 MB quota, a third is refused 507 quota_exceeded and does not land"
else no_ "the quota uploads answered $q1/$q2/$(status_of "$r") $(body_of "$r")"; fi
printf "NOTE [%s] quota refusal: %s\n" "$RUNTIME" "$(body_of "$r" | field error)"
r=$(call GET /setup-api/settings/user-limits "$OWNER")
used=$(body_of "$r" | python3 -c "import json,sys; u=[x for x in json.load(sys.stdin)[\"users\"] if x[\"username\"]==sys.argv[1]]; print(u[0][\"usedBytes\"] if u else \"\")" "$A_NAME" 2>/dev/null)
if [ -n "$used" ] && [ "$used" != None ] && [ "$used" -ge 1843200 ] && [ "$used" -le 2097152 ]; then ok_ "the owner sees A home usage ($used bytes) beside the quota"; else no_ "the owner sees A usage as \"$used\""; fi
d=$(status_of "$(call DELETE "/setup-api/files/Home/$MARK-1.bin" "$A_COOKIE")")
r=$(put_file "$A_COOKIE" Home "$MARK-3.bin" 921600)
if [ "$d" = 200 ] && [ "$(status_of "$r")" = 200 ]; then ok_ "after a delete A may upload into their home again"; else no_ "delete $d, then upload $(status_of "$r")"; fi
r=$(call POST /setup-api/settings/org-mode "$OWNER" "{\"orgMode\":false}")
[ "$(status_of "$r")" = 200 ] || no_ "turning organisation mode off answered $(status_of "$r")"

# 5. The audit log.
r=$(call GET "/setup-api/settings/audit-log?limit=200" "$OWNER")
seen=$(body_of "$r" | python3 -c "
import json,sys
a=sys.argv[1]; e=[x for x in json.load(sys.stdin)[\"entries\"] if x[\"ts\"] >= sys.argv[2]]
want={\"login\":lambda x:x.get(\"actor\")==a, \"login_failed\":lambda x:x.get(\"actor\")==a, \"user_create\":lambda x:x.get(\"target\")==a, \"user_limits\":lambda x:(x.get(\"detail\") or {}).get(\"chatPerMinute\")==1, \"org_mode\":lambda x:(x.get(\"detail\") or {}).get(\"on\") is True}
print(\" \".join(k for k,f in want.items() if any(x[\"event\"]==k and f(x) for x in e)))
" "$A_NAME" "$AUDIT_SINCE" 2>/dev/null)
if [ "$(status_of "$r")" = 200 ] && [ "$seen" = "login login_failed user_create user_limits org_mode" ]; then
  ok_ "the owner audit log holds A sign-in and failed sign-in, the user added, the limits set and the switch"
else no_ "the audit log answered $(status_of "$r"), found: $seen"; fi
body_of "$r" | python3 -c "import json,sys; [print(\"NOTE [$RUNTIME] audit:\", x[\"ts\"], x[\"event\"], x.get(\"actor\"), x.get(\"target\",\"\"), json.dumps(x.get(\"detail\",{}))) for x in json.load(sys.stdin)[\"entries\"][:8]]" 2>/dev/null
ra=$(status_of "$(call GET /setup-api/settings/audit-log "$A_COOKIE")")
[ "$ra" = 403 ] && ok_ "A is refused the audit log (403)" || no_ "A reading the audit log answered $ra"
mode=$(stat -c %a "$REPO/data/audit-log.jsonl" 2>/dev/null)
[ "$mode" = 600 ] && ok_ "the audit log file under data/ is 0600" || no_ "the audit log file mode is \"$mode\""

trap - EXIT
cleanup
bad=""
for step in $CLEANUP; do [ "${step##*:}" = 200 ] || bad="$bad $step"; done
[ -z "$bad" ] && ok_ "the limits, the switch and the user are put back" || no_ "cleanup answered:$bad"
echo "FLOW-END"
'

out=$(board "$FLOW")
board_rc=$?
results=$(printf '%s\n' "$out" | grep -E '^(RESULT|NOTE) ')
# A flow cut short (the connection dropped, the board rebooted) has not proved
# what it never reached, however good the part that did come back looks.
if [ "$board_rc" != 0 ] || ! printf '%s\n' "$out" | grep -qx 'FLOW-END'; then
  not_ok "the multi-user limits flow did not run to its end on the board (status $board_rc)"
fi
if [ -z "$results" ]; then
  not_ok "the multi-user limits flow printed nothing on the board"
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
