#!/usr/bin/env bash
# timeout: 600
#
# A second ClawBox user, for real, on the board:
#
#   1. The owner adds a user through POST /setup-api/users — the real root
#      step (useradd, chpasswd, the clawbox-users group) — and the listing
#      says other users can sign in (the root-owned sign-in helper answers).
#   2. The user signs in through /login-api with THEIR password (unix_chkpwd
#      through the helper), and a wrong one is refused.
#   3. With the user's cookie the owner's desktop is theirs: the routes that
#      used to answer `owner_only` answer them; the exceptions still do not
#      (the owner's password, the gateway's console); ws-config hands them no
#      gateway token.
#   4. Their chat goes through the user relay: the hello names their own main
#      key, asking for the owner's main history is refused, and a real turn on
#      their key is answered without a single frame of another session.
#   5. The owner removes them: the Linux account is gone and their password
#      no longer signs in.
#
# Both session cookies are minted ON the board from data/.session-secret —
# the box's own secret, never printed and never leaving the board — because
# Settings → Users answers a person's session, never the MCP bearer.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# The whole flow runs on the board in one script: the user's password and
# both cookies exist only there. It prints TAP-shaped `RESULT ok|not ok - …`
# lines this side turns into the test's own.
# shellcheck disable=SC2016  # expanded on the board, not here
FLOW='
USER_NAME="nanoci$(tr -dc a-z0-9 </dev/urandom | head -c 6)"
USER_PASS="$(tr -dc A-Za-z0-9 </dev/urandom | head -c 24)"
SECRET_FILE="$REPO/data/.session-secret"
say() { printf "RESULT %s\n" "$*"; }

owner_cookie() {
  node -e '"'"'
    const fs = require("fs"), crypto = require("crypto");
    const secret = fs.readFileSync(process.argv[1], "utf8").trim();
    let gen = 0;
    try { const c = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); if (Number.isFinite(c.session_generation)) gen = c.session_generation; } catch {}
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 1200, gen })).toString("base64url");
    process.stdout.write(payload + "." + crypto.createHmac("sha256", secret).update(payload).digest("hex"));
  '"'"' "$SECRET_FILE" "$REPO/data/config.json"
}

# call METHOD PATH COOKIE [BODY] -> status on the first line, body after. The
# cookie goes to curl on stdin as a config line, never on a command line.
call() {
  local method=$1 path=$2 cookie=$3 body=${4:-} out code extra=()
  [ -n "$body" ] && extra=(-H "Content-Type: application/json" --data-binary "$body")
  out=$(mktemp)
  code=$(printf "header = \"Cookie: clawbox_session=%s\"\nheader = \"Origin: http://127.0.0.1\"\n" "$cookie" \
    | curl -sS -o "$out" -w "%{http_code}" -X "$method" --max-time 120 "${extra[@]}" -K - "$DASHBOARD$path" 2>/dev/null)
  printf "%s\n" "${code:-000}"; cat "$out"; rm -f "$out"
}
status_of() { printf "%s\n" "$1" | head -n1; }
body_of() { printf "%s\n" "$1" | tail -n +2; }

# python3, not jq: a stock board has no jq.
# json_ok EXPR [ARG]: true when the Python expression EXPR is True for the JSON
# on stdin, as `j` (ARG as `arg`); false for anything else, invalid JSON included.
json_ok() {
  python3 -c "import json,sys; j=json.load(sys.stdin); arg=(sys.argv[2:] or [None])[0]; sys.exit(0 if eval(sys.argv[1]) is True else 1)" "$@" 2>/dev/null
}
# json_field NAME: the top-level field NAME of the JSON on stdin, compact; nothing for invalid JSON.
json_field() {
  python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin).get(sys.argv[1]), separators=(\",\", \":\")))" "$1" 2>/dev/null
}

remove_user() {
  call DELETE /setup-api/users "$OWNER" "{\"username\":\"$USER_NAME\"}" >/dev/null 2>&1 || true
}

if [ ! -r "$SECRET_FILE" ]; then say "not ok - $SECRET_FILE is not readable as the box account"; exit 0; fi
OWNER=$(owner_cookie)
trap remove_user EXIT

# 1. Create.
r=$(call POST /setup-api/users "$OWNER" "{\"username\":\"$USER_NAME\",\"password\":\"$USER_PASS\"}")
if [ "$(status_of "$r")" = 201 ]; then
  say "ok - the owner added a user through Settings → Users"
else
  say "not ok - creating a user answered $(status_of "$r"): $(body_of "$r" | head -c 400)"
  exit 0
fi
if getent passwd "$USER_NAME" >/dev/null && id -nG "$USER_NAME" | tr " " "\n" | grep -qx clawbox-users; then
  say "ok - the user is a Linux account in clawbox-users"
else
  say "not ok - no Linux account in clawbox-users for the new user"
fi
if id -nG "$USER_NAME" | tr " " "\n" | grep -Eqx "sudo|adm|admin|wheel"; then
  say "not ok - the new account is in an administrator group"
fi
listing=$(body_of "$(call GET /setup-api/users "$OWNER")")
if printf "%s" "$listing" | json_ok "j[\"signIn\"][\"available\"] is True"; then
  say "ok - the listing says other users can sign in"
else
  say "not ok - the listing says sign-in is unavailable: $(printf "%s" "$listing" | json_field signIn || printf "(not JSON)")"
fi

# 2. Sign in with their own password; a wrong one is refused.
wrong=$(curl -sS -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" --max-time 60 \
  --data-binary "{\"username\":\"$USER_NAME\",\"password\":\"not-their-password\",\"duration\":1200}" "$DASHBOARD/login-api")
[ "$wrong" = 401 ] && say "ok - a wrong password is refused (401)" || say "not ok - a wrong password answered $wrong"
jar=$(mktemp)
login=$(printf "%s" "{\"username\":\"$USER_NAME\",\"password\":\"$USER_PASS\",\"duration\":1200}" \
  | curl -sS -c "$jar" -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" --max-time 60 --data-binary @- "$DASHBOARD/login-api")
USER_COOKIE=$(awk '"'"'$6 == "clawbox_session" { print $7 }'"'"' "$jar"); rm -f "$jar"
if [ "$login" = 200 ] && [ -n "$USER_COOKIE" ]; then
  say "ok - the user signed in with their own password"
else
  say "not ok - signing the user in answered $login"
  exit 0
fi
me=$(body_of "$(call GET /setup-api/users/me "$USER_COOKIE")")
printf "%s" "$me" | json_ok "j[\"username\"] == arg and j[\"isOwner\"] is False" "$USER_NAME" \
  && say "ok - users/me names the user, not the owner" || say "not ok - users/me answered $(printf "%s" "$me" | head -c 200)"

# 3. The owner desktop is theirs, except the three exceptions.
opened=0; refused=""
for path in "/setup-api/preferences?all=1" "/setup-api/kv?key=ui:pending-actions" "/setup-api/coding-agent/runs" \
            "/setup-api/files" "/setup-api/apps/store" "/setup-api/vnc" "/setup-api/clawkeep" "/setup-api/prime-radiant/status" \
            "/setup-api/users" "/setup-api/wifi/status" "/setup-api/ai-models/status"; do
  r=$(call GET "$path" "$USER_COOKIE")
  if printf "%s" "$(body_of "$r")" | grep -q "\"owner_only\""; then refused="$refused $path"; else opened=$((opened + 1)); fi
done
[ -z "$refused" ] && say "ok - $opened routes that were the owner'"'"'s answer the user" || say "not ok - still owner-only for the user:$refused"
page=$(status_of "$(call GET / "$USER_COOKIE")")
[ "$page" = 200 ] && say "ok - the desktop page serves the user" || say "not ok - the desktop page answered $page"
cred=$(status_of "$(call POST /setup-api/system/credentials "$USER_COOKIE" "{\"password\":\"x\",\"currentPassword\":\"y\"}")")
[ "$cred" = 403 ] && say "ok - the owner'"'"'s password stays the owner'"'"'s (403)" || say "not ok - the owner'"'"'s password route answered the user $cred"
console=$(status_of "$(call GET /setup-api/gateway "$USER_COOKIE")")
[ "$console" = 403 ] && say "ok - the gateway console page with its token stays the owner'"'"'s (403)" || say "not ok - the gateway console answered the user $console"
ws=$(body_of "$(call GET /setup-api/gateway/ws-config "$USER_COOKIE")")
if printf "%s" "$ws" | json_ok "j[\"token\"] == \"\" and j[\"relayed\"] is True"; then
  say "ok - ws-config hands the user no gateway token"
else
  say "not ok - ws-config answered the user a token or no relay mark"
fi

# 4. Their own chat, through the relay, with the cookie the browser would send.
chat=$(cd "$REPO" && USER_COOKIE="$USER_COOKIE" USER_NAME="$USER_NAME" timeout 300 node -e '"'"'
  const WebSocket = require("ws");
  const ws = new WebSocket("ws://127.0.0.1/", { headers: { cookie: "clawbox_session=" + process.env.USER_COOKIE, origin: "http://127.0.0.1" } });
  const out = (s) => console.log("RESULT " + s);
  const mine = "agent:main:clawbox-user-" + process.env.USER_NAME;
  let main = "", foreign = 0, done = false;
  const finish = (line) => { if (done) return; done = true; out(line); if (main) out(foreign === 0 ? "ok - no frame of another session reached the user" : "not ok - " + foreign + " frame(s) of another session reached the user"); ws.close(); setTimeout(() => process.exit(0), 200); };
  setTimeout(() => finish("not ok - no answer to the user\u2019s turn within 240 s"), 240000);
  ws.on("error", (e) => finish("not ok - the chat socket failed: " + e.message));
  ws.on("message", (raw) => {
    const f = JSON.parse(String(raw));
    if (f.type === "event" && f.event === "connect.challenge") {
      ws.send(JSON.stringify({ type: "req", id: "c", method: "connect", params: { auth: { token: "" } } }));
      return;
    }
    if (f.type === "event") {
      const key = f.payload && f.payload.sessionKey;
      if (key && key.toLowerCase() !== mine) foreign++;
      if (f.event === "chat" && key && key.toLowerCase() === mine && f.payload.state === "final") finish("ok - a real turn on the user\u2019s own key was answered");
      return;
    }
    if (f.id === "c") {
      main = f.ok && f.payload && f.payload.snapshot && f.payload.snapshot.sessionDefaults && f.payload.snapshot.sessionDefaults.mainSessionKey;
      out(main === mine ? "ok - the hello names the user\u2019s own main key" : "not ok - the hello named " + main);
      out(f.payload && f.payload.auth ? "not ok - the hello carried the relay\u2019s device token" : "ok - the hello carries no device token");
      ws.send(JSON.stringify({ type: "req", id: "peek", method: "chat.history", params: { sessionKey: "agent:main:main", limit: 5 } }));
      return;
    }
    if (f.id === "peek") {
      out(!f.ok && f.error && f.error.code === "FORBIDDEN" ? "ok - the owner\u2019s history is refused to the user" : "not ok - the owner\u2019s history answered the user");
      ws.send(JSON.stringify({ type: "req", id: "send", method: "chat.send", params: { sessionKey: mine, message: "Reply with exactly this text and nothing else: NANO-USER-OK", deliver: false, idempotencyKey: "nano-user-" + Date.now() } }));
      return;
    }
    if (f.id === "send" && !f.ok) finish("not ok - the user\u2019s turn was refused: " + JSON.stringify(f.error));
  });
'"'"' 2>&1)
printf "%s\n" "$chat" | grep "^RESULT " || say "not ok - the chat check printed nothing: $(printf "%s" "$chat" | tail -n 3 | tr "\n" " ")"

# 5. The owner removes them.
trap - EXIT
r=$(call DELETE /setup-api/users "$OWNER" "{\"username\":\"$USER_NAME\"}")
[ "$(status_of "$r")" = 200 ] && say "ok - the owner removed the user" || say "not ok - removing the user answered $(status_of "$r"): $(body_of "$r" | head -c 300)"
if getent passwd "$USER_NAME" >/dev/null; then say "not ok - the Linux account is still there"; else say "ok - the Linux account is gone"; fi
after=$(curl -sS -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" --max-time 60 \
  --data-binary "{\"username\":\"$USER_NAME\",\"password\":\"$USER_PASS\",\"duration\":1200}" "$DASHBOARD/login-api")
[ "$after" = 401 ] && say "ok - the removed user can no longer sign in" || say "not ok - the removed user'"'"'s password answered $after"
'

out=$(board "$FLOW")
results=$(printf '%s\n' "$out" | grep '^RESULT ' | sed 's/^RESULT //')
if [ -z "$results" ]; then
  not_ok "the multi-user flow printed nothing on the board"
  printf '%s\n' "$out" | tail -n 20 | while IFS= read -r line; do note "$line"; done
else
  printf '%s\n' "$results" | while IFS= read -r line; do
    case "$line" in
      "ok - "*) ok "${line#ok - }" ;;
      "not ok - "*) printf 'not ok - %s\n' "${line#not ok - }" ;;
      *) note "$line" ;;
    esac
  done
  printf '%s\n' "$results" | grep -q '^not ok - ' && NANO_TEST_FAILED=1
fi
finish
