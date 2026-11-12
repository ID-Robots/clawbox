#!/usr/bin/env bash
# timeout: 3300
# tier: long
# covers: config/org-staff-policy.json scripts/org-staff-policy.js scripts/gateway-user-relay.js src/lib/org-staff-*.ts src/lib/hermes-staff-profile.ts scripts/openclaw-plugins/clawbox-staff-guard/* scripts/hermes-plugins/clawbox_staff_guard/* src/app/setup-api/hermes/chat/route.ts scripts/nano-tests/board/org-mode-staff.mjs src/lib/staff-mcp*.ts src/app/setup-api/staff-mcp/* src/app/setup-api/settings/staff-mcp/* scripts/nano-tests/board/org-mode-staff-mcp.mjs src/lib/files-scope*.ts src/app/setup-api/files/*
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
#   5. Files (TASK-2377): each member sees only their own home and Shared —
#      not the owner's checkout or another member's home, not through a
#      traversal, an absolute path or a link out of their home.
#   6. Staff MCP tools (TASK-2377, scripts/nano-tests/board/org-mode-staff-mcp.mjs):
#      a stub MCP server that echoes the credential; on OpenClaw the owner
#      grants it, A's call carries A's credential, B without one gets none,
#      then B's carries B's, and the owner's assistant uses its own entry; on
#      Hermes the grant is refused and A's ask reaches nothing.
#   7. The owner turns the switch off and removes both users: the staff agents
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
  login=$(printf "%s" "{\"username\":\"$name\",\"password\":\"$pass\",\"duration\":21600}" \
    | curl -sS -c "$jar" -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" --max-time 60 --data-binary @- "$DASHBOARD/login-api")
  cookie=$(awk '"'"'$6 == "clawbox_session" { print $7 }'"'"' "$jar"); rm -f "$jar"
  [ "$login" = 200 ] && printf "%s" "$cookie"
}

# Staff agents left on the roster, in either shape (agents.entries, or the
# legacy agents.list); "?" when the config cannot be read, which is not zero.
staff_on_roster() {
  python3 -c "import json,sys; a=json.load(open(sys.argv[1])).get(\"agents\") or {}; ids=list((a.get(\"entries\") or {}).keys())+[x.get(\"id\") for x in (a.get(\"list\") or []) if isinstance(x,dict)]; print(len([k for k in ids if isinstance(k,str) and k.startswith(\"clawbox-staff-\")]))" "$HOME/.openclaw/openclaw.json" 2>/dev/null || echo "?"
}

# Switch off and remove both users; what each step answered is kept in
# CLEANUP_STATUS ("org-off:200 delete-<name>:200 ..."), so the flow can check
# it. Safe to run twice: a second run answers for users already gone.
cleanup() {
  CLEANUP_SINCE=$(date +%s)
  local r u
  r=$(call POST /setup-api/settings/org-mode "$OWNER" "{\"orgMode\":false}" 2>/dev/null || true)
  CLEANUP_STATUS="org-off:$(status_of "$r")"
  for u in "$A_NAME" "$B_NAME"; do
    r=$(call DELETE /setup-api/users "$OWNER" "{\"username\":\"$u\"}" 2>/dev/null || true)
    CLEANUP_STATUS="$CLEANUP_STATUS delete-$u:$(status_of "$r")"
  done
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
# Its own exit status counts: a driver that was killed or crashed midway has
# not proved the checks it never reached.
DRIVER_OUT=$(mktemp)
cd "$REPO" && A_NAME="$A_NAME" A_COOKIE="$A_COOKIE" B_NAME="$B_NAME" B_COOKIE="$B_COOKIE" OWNER_COOKIE="$OWNER" MARK="$MARK" RUNTIME="$RUNTIME" REPO="$REPO" \
  timeout 1900 node "$REPO/scripts/nano-tests/board/org-mode-staff.mjs" >"$DRIVER_OUT" 2>&1
DRIVER_RC=$?
grep -E "^(RESULT|NOTE) " "$DRIVER_OUT" || say "not ok - [$RUNTIME] the chat driver printed nothing"
[ "$DRIVER_RC" = 0 ] || say "not ok - [$RUNTIME] the chat driver ended with status $DRIVER_RC (124: it ran out of time)"
rm -f "$DRIVER_OUT"

# 5. Files: their own home and Shared, nothing else of the box.
fl=$(call GET "/setup-api/files?dir=" "$A_COOKIE")
top=$(printf "%s\n" "$fl" | tail -n +2 | python3 -c "import json,sys; print(\",\".join(sorted(f[\"name\"] for f in json.load(sys.stdin)[\"files\"])))" 2>/dev/null || echo "?")
if [ "$(status_of "$fl")" = 200 ] && [ "$top" = "Home,Shared" ]; then say "ok - [$RUNTIME] A'"'"'s Files shows only Home and Shared"; else say "not ok - [$RUNTIME] A'"'"'s Files top folder: $(status_of "$fl") $top"; fi
up=$(printf "from %s" "$A_NAME" | curl -sS -o /dev/null -w "%{http_code}" -X PUT -H "Cookie: clawbox_session=$A_COOKIE" -H "Origin: http://127.0.0.1" --data-binary @- "$DASHBOARD/setup-api/files?dir=Home&name=$MARK.txt")
if [ "$up" = 200 ] && [ -f "/home/$A_NAME/$MARK.txt" ]; then say "ok - [$RUNTIME] A uploads into their own Linux home"; else say "not ok - [$RUNTIME] A'"'"'s upload into Home answered $up"; fi
hl=$(call GET "/setup-api/files?dir=Home" "$B_COOKIE")
case "$(printf "%s\n" "$hl" | tail -n +2)" in *"$MARK.txt"*) say "not ok - [$RUNTIME] B sees A'"'"'s file in their Home" ;; *) say "ok - [$RUNTIME] B'"'"'s Home is B'"'"'s own, not A'"'"'s" ;; esac
sh=$(printf "shared by %s" "$A_NAME" | curl -sS -o /dev/null -w "%{http_code}" -X PUT -H "Cookie: clawbox_session=$A_COOKIE" -H "Origin: http://127.0.0.1" --data-binary @- "$DASHBOARD/setup-api/files?dir=Shared&name=$MARK-shared.txt")
sb=$(call GET "/setup-api/files?dir=Shared" "$B_COOKIE")
case "$sh:$(status_of "$sb"):$(printf "%s\n" "$sb" | tail -n +2)" in 200:200:*"$MARK-shared.txt"*) say "ok - [$RUNTIME] A writes into Shared and B reads it" ;; *) say "not ok - [$RUNTIME] Shared answered $sh / $(status_of "$sb")" ;; esac
ln -sfn "$REPO" "/home/$A_NAME/$MARK-link" 2>/dev/null || sudo -n ln -sfn "$REPO" "/home/$A_NAME/$MARK-link" 2>/dev/null || true
bad=""
for p in "dir=.." "dir=Home/.." "dir=Home/../.." "dir=$REPO" "dir=clawbox" "dir=Home/$MARK-link" "dir=Shared/.." "dir=/etc"; do
  c=$(status_of "$(call GET "/setup-api/files?$p" "$A_COOKIE")"); [ "$c" = 400 ] || bad="$bad $p:$c"
done
c=$(status_of "$(call GET "/setup-api/files/Home/$MARK-link/package.json" "$A_COOKIE")"); [ "$c" = 400 ] || bad="$bad link-download:$c"
c=$(status_of "$(call GET "/setup-api/files/..%2F..%2Fclawbox%2Fpackage.json" "$A_COOKIE")"); [ "$c" = 400 ] || [ "$c" = 403 ] || [ "$c" = 404 ] || bad="$bad encoded-traversal:$c"
if [ -z "$bad" ]; then say "ok - [$RUNTIME] A cannot reach the owner'"'"'s files: traversal, absolute paths and a link out of Home are refused"; else say "not ok - [$RUNTIME] A reached outside their folders:$bad"; fi
ol=$(call GET "/setup-api/files?dir=" "$OWNER")
case "$(printf "%s\n" "$ol" | tail -n +2)" in *"\"clawbox\""*) say "ok - [$RUNTIME] the owner'"'"'s Files is unchanged (their home, the checkout included)" ;; *) say "not ok - [$RUNTIME] the owner'"'"'s Files top folder changed" ;; esac
printf "NOTE [%s] files: A top=%s upload=%s shared=%s\n" "$RUNTIME" "$top" "$up" "$sh"
rm -f "$REPO/../Shared/$MARK-shared.txt" "$HOME/Shared/$MARK-shared.txt" 2>/dev/null || true

# 6. Staff MCP tools, each call with the member own credential.
MCP_OUT=$(mktemp)
cd "$REPO" && A_NAME="$A_NAME" A_COOKIE="$A_COOKIE" B_NAME="$B_NAME" B_COOKIE="$B_COOKIE" OWNER_COOKIE="$OWNER" MARK="$MARK" RUNTIME="$RUNTIME" REPO="$REPO" \
  timeout 1500 node "$REPO/scripts/nano-tests/board/org-mode-staff-mcp.mjs" >"$MCP_OUT" 2>&1
MCP_RC=$?
grep -E "^(RESULT|NOTE) " "$MCP_OUT" || say "not ok - [$RUNTIME] the staff MCP driver printed nothing"
[ "$MCP_RC" = 0 ] || say "not ok - [$RUNTIME] the staff MCP driver ended with status $MCP_RC (124: it ran out of time)"
rm -f "$MCP_OUT"

# 7. Off, and the users gone — both of them, by what the box answered and by
# what it now lists.
trap - EXIT
cleanup
bad=""
for step in $CLEANUP_STATUS; do [ "${step##*:}" = 200 ] || bad="$bad $step"; done
if [ -z "$bad" ]; then
  say "ok - [$RUNTIME] the switch goes off and both members are removed"
else
  say "not ok - [$RUNTIME] cleanup answered:$bad"
fi
# Only a 200 carrying a `users` list is a list: an error answer is unreadable.
r=$(call GET /setup-api/users "$OWNER" 2>/dev/null || true)
listed="?"
if [ "$(status_of "$r")" = 200 ]; then
  listed=$(printf "%s\n" "$r" | tail -n +2 | python3 -c "import json,sys; u=json.load(sys.stdin).get(\"users\"); assert isinstance(u, list); print(\" \".join(str(x.get(\"username\",\"\")) for x in u if isinstance(x, dict)))" 2>/dev/null || echo "?")
fi
if [ "$listed" = "?" ]; then
  say "not ok - [$RUNTIME] the user list could not be read after cleanup"
else
  case " $listed " in
    *" $A_NAME "*|*" $B_NAME "*) say "not ok - [$RUNTIME] a test member is still listed: $listed" ;;
    *) say "ok - [$RUNTIME] neither test member is listed any more" ;;
  esac
fi
if [ "$RUNTIME" = openclaw ]; then
  left=$(staff_on_roster)
  if [ "$left" = 0 ]; then
    say "ok - [$RUNTIME] the switch off takes every staff agent off the roster"
  else
    say "not ok - [$RUNTIME] $left staff agent(s) still on the roster"
    # Why: what the web server said about the roster and its config writes.
    journalctl -u clawbox-setup.service --since "@$CLEANUP_SINCE" --no-pager -o cat 2>/dev/null \
      | grep -E "\[org-staff\]|\[openclaw-config\]" | tail -n 20 | sed "s/^/NOTE [$RUNTIME] server: /"
  fi
  if [ ! -e "$HOME/.openclaw/staff/$A_NAME" ] && [ ! -e "$HOME/.openclaw/staff/$B_NAME" ]; then
    say "ok - [$RUNTIME] a removed member'"'"'s workspace goes with them (both members)"
  else
    say "not ok - [$RUNTIME] a removed member'"'"'s workspace is still there"
  fi
else
  # Their memory, folder and config go. The dashboard may seed a bare state.db
  # back into a profile it still serves (tui_gateway/server.py
  # _bootstrap_served_profile_store) — an empty store, listed here as evidence.
  left=""
  for u in "$A_NAME" "$B_NAME"; do
    P="$HOME/.hermes/profiles/clawbox-staff-$u"
    if [ -e "$P/memories" ] || [ -e "$P/workspace" ] || [ -e "$P/config.yaml" ] || [ -e "$P/.env" ]; then left="$left $u"; fi
    [ -e "$P" ] && find "$P" -maxdepth 2 -printf "NOTE [$RUNTIME] left in the removed profile of $u: %P (%s bytes)\n" 2>/dev/null | head -n 10
  done
  if [ -z "$left" ]; then
    say "ok - [$RUNTIME] a removed member'"'"'s memory, folder and profile config go with them (both members)"
  else
    say "not ok - [$RUNTIME] memory, folder or profile config still there for:$left"
  fi
fi
echo "FLOW-END"
'

out=$(board "$FLOW")
board_rc=$?
results=$(printf '%s\n' "$out" | grep -E '^(RESULT|NOTE) ')
# A flow cut short (the connection dropped, the board rebooted) has not proved
# what it never reached, however good the part that did come back looks.
if [ "$board_rc" != 0 ] || ! printf '%s\n' "$out" | grep -qx 'FLOW-END'; then
  not_ok "the organisation-mode staff flow did not run to its end on the board (status $board_rc)"
fi
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
