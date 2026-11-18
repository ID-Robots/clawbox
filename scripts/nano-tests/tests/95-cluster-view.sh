#!/usr/bin/env bash
# timeout: 900
# covers: src/lib/cluster-view.ts src/lib/cluster-shared.ts src/app/setup-api/system/cluster/*
# covers: src/components/ClusterPanel.tsx src/lib/non-owner-scope.ts src/lib/update-channel.ts
#
# Settings → System → Cluster (TASK-2670) on the box's own runtime — OpenClaw or
# Hermes, whichever it runs; the suite's Hermes pass switches the runtime and
# runs it again. A lab board is not a Workstation, so this is the "other" half
# of the feature, plus the half that needs a cluster to fail. It checks the
# route (the API); the tab itself is drawn by Settings from that answer, and is
# covered by the component tests.
#
#   1. A box that is not a Workstation: the owner's `GET system/cluster` says
#      `enabled: false`, the System page and its figures still load, and listing
#      peers does not turn the view on.
#   2. A staff user (a real second account, as 55-multi-user does) is answered
#      403 `owner_only` by the cluster route in both its forms, and a request
#      with no session 401.
#   3. With a FAKE cluster configuration in the checkout's .env, and the web
#      server restarted to read it — CLAWBOX_CLUSTER_VIEW=on, two peers that can
#      never answer (a documentation address that drops packets and a name that
#      never resolves), and CLAWBOX_CLUSTER_ENGINE_URL pointed at a loopback
#      fixture of this test's own that holds every request open (so the read is
#      slow by design, and an engine the board may have saved is never asked):
#        - the owner's answer arrives inside 15 s and says this Spark is online
#          and both peers are offline with a reason — it does not hang;
#        - the web server answers system/stats while the cluster read is still
#          waiting (the fixture is holding it), before the cluster answer;
#        - the engine is the fixture, reported offline, and no key was sent to it;
#        - the second answer is served from memory: the same readings.
#   4. The staff user still gets 403 with peers configured, and nothing was
#      read for them.
#
# The .env is put back, and the web server restarted onto it, even when the
# test fails half way; the second account is removed and the fixture stopped.
# A cleanup step that fails is reported, and what it could not undo is kept
# (the .env backup, the account's name) in the test's folder on the board.
# Nothing is installed on or sent to any other machine: the two peers do not
# exist, and the engine is on this board's loopback.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

RUNTIME=$(board_runtime)
RUN=${NANO_RUN_ID:-$$}
DIR="/tmp/nano-cluster-$RUN"
note "agent runtime: $RUNTIME"

# The fixture peers. 192.0.2.0/24 is TEST-NET-1 (RFC 5737) and .invalid never
# resolves (RFC 6761): neither can ever be a machine.
PEERS="192.0.2.1 no-such-peer.invalid"

# shellcheck disable=SC2016  # expanded on the board
SETUP='
DIR=$1
mkdir -p "$DIR" && chmod 700 "$DIR" && echo OK
'
if [ "$(board "$SETUP" "$DIR" | tail -n1)" != OK ]; then
  not_ok "could not make the test folder on the board"
  finish
fi

# Put the checkout's .env back as it was and restart the web server onto it,
# stop the engine fixture, remove the second account. Each step says how it
# went; the folder (with the .env backup and the account's name) is removed
# only when every step worked. SC2317: run by the EXIT trap.
# shellcheck disable=SC2016,SC2317
restore() {
  local out line
  out=$(board '
    DIR=$1
    ENV_FILE="$REPO/.env"
    if [ -s "$DIR/engine.pid" ]; then
      kill "$(cat "$DIR/engine.pid")" 2>/dev/null
      rm -f "$DIR/engine.pid"
    fi
    env_ok=1
    if [ -e "$DIR/env.absent" ]; then
      if rm -f "$ENV_FILE"; then echo "ENV removed (there was none)"; else echo "ENV_FAIL could not remove the test .env"; env_ok=0; fi
    elif [ -e "$DIR/env.orig" ]; then
      if cat "$DIR/env.orig" > "$ENV_FILE" && cmp -s "$DIR/env.orig" "$ENV_FILE"; then echo "ENV restored"; else echo "ENV_FAIL could not write the .env back"; env_ok=0; fi
    else
      echo "ENV untouched"
    fi
    if [ -e "$DIR/env.touched" ]; then
      if sudo -n /usr/bin/systemctl restart clawbox-setup.service; then
        echo "RESTART ok"
      else
        echo "RESTART_FAIL the web server could not be restarted onto the restored .env"; env_ok=0
      fi
    fi
    if [ "$env_ok" = 1 ]; then rm -f "$DIR/env.orig" "$DIR/env.absent" "$DIR/env.new" "$DIR/env.touched"; fi
    # The account: only once the dashboard answers again, and its marker goes
    # only when the removal is confirmed (200, or 404: already gone).
    user_ok=1
    if [ -s "$DIR/user" ]; then
      name=$(cat "$DIR/user")
      for _ in $(seq 1 60); do
        [ "$(owner_api GET "/setup-api/system/cluster?availability=1" | head -n1)" = 200 ] && break
        sleep 5
      done
      code=$(owner_api DELETE /setup-api/users "{\"username\":\"$name\"}" | head -n1)
      if [ "$code" = 200 ] || [ "$code" = 404 ]; then
        echo "USER removed ($code)"
        rm -f "$DIR/user" "$DIR/user-cookie"
      else
        echo "USER_FAIL removing the second account answered $code; its name is kept in $DIR/user"
        user_ok=0
      fi
    fi
    if [ "$env_ok" = 1 ] && [ "$user_ok" = 1 ]; then
      rm -rf "$DIR"
      echo "CLEAN"
    else
      echo "KEPT $DIR"
    fi
  ' "$DIR" 2>&1)
  while IFS= read -r line; do
    case "$line" in
      ENV_FAIL*|RESTART_FAIL*|USER_FAIL*) not_ok "cleanup: ${line#* }" ;;
      KEPT*) note "cleanup: kept ${line#KEPT } on the board for a retry" ;;
      ENV*|RESTART*|USER*|CLEAN) note "cleanup: $line" ;;
    esac
  done <<< "$out"
  case "$out" in
    *CLEAN*|*KEPT*) ;;
    *) not_ok "cleanup: the board did not answer the cleanup step: $(printf '%s' "$out" | tail -n 3 | head -c 300)" ;;
  esac
  wait_gateway_health 240 >/dev/null 2>&1 || true
  exit "$NANO_TEST_FAILED"
}
trap restore EXIT

# --- the second account (a real one, as 55-multi-user makes) -----------------
# shellcheck disable=SC2016
USER_OUT=$(board '
  DIR=$1
  NAME="nanoci$(tr -dc a-z0-9 </dev/urandom | head -c 6)"
  PASS="$(tr -dc A-Za-z0-9 </dev/urandom | head -c 24)"
  printf "%s" "$NAME" > "$DIR/user"
  r=$(owner_api POST /setup-api/users "{\"username\":\"$NAME\",\"password\":\"$PASS\"}")
  code=$(printf "%s\n" "$r" | head -n1)
  if [ "$code" != 201 ]; then printf "FAIL create %s %s\n" "$code" "$(printf "%s\n" "$r" | tail -n +2 | head -c 200)"; exit 0; fi
  jar=$(mktemp)
  login=$(printf "%s" "{\"username\":\"$NAME\",\"password\":\"$PASS\",\"duration\":3000}" \
    | curl -sS -c "$jar" -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" --max-time 60 --data-binary @- "$DASHBOARD/login-api")
  cookie=$(awk "\$6 == \"clawbox_session\" { print \$7 }" "$jar"); rm -f "$jar"
  if [ "$login" != 200 ] || [ -z "$cookie" ]; then printf "FAIL login %s\n" "$login"; exit 0; fi
  umask 077
  printf "%s" "$cookie" > "$DIR/user-cookie"
  printf "OK\n"
' "$DIR" | tail -n1)
case "$USER_OUT" in
  OK) ok "a second (staff) account exists and is signed in" ;;
  *) not_ok "could not make the second account: $USER_OUT"; finish ;;
esac

# call_as WHO PATH — one request on the board as the owner, as the staff user
# ("staff") or with no session ("none"): the status, then the body, then the
# seconds it took. The cookie reaches curl on its stdin only.
# shellcheck disable=SC2016
CALL='
DIR=$1; who=$2; path=$3
cookie=""
case "$who" in
  owner) cookie=$(node -e "const fs = require(\"fs\"), crypto = require(\"crypto\");
    const secret = fs.readFileSync(process.argv[1], \"utf8\").trim();
    let gen = 0;
    try { const c = JSON.parse(fs.readFileSync(process.argv[2], \"utf8\")); if (Number.isFinite(c.session_generation)) gen = c.session_generation; } catch {}
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 1200, gen })).toString(\"base64url\");
    process.stdout.write(payload + \".\" + crypto.createHmac(\"sha256\", secret).update(payload).digest(\"hex\"));
  " "$REPO/data/.session-secret" "$REPO/data/config.json") ;;
  staff) cookie=$(cat "$DIR/user-cookie") ;;
esac
out=$(mktemp)
start=$(date +%s)
if [ -n "$cookie" ]; then
  code=$(printf "header = \"Cookie: clawbox_session=%s\"\nheader = \"Origin: http://127.0.0.1\"\n" "$cookie" \
    | curl -sS -o "$out" -w "%{http_code}" --max-time 60 -K - "$DASHBOARD$path" 2>/dev/null)
else
  code=$(curl -sS -o "$out" -w "%{http_code}" --max-time 60 "$DASHBOARD$path" 2>/dev/null)
fi
end=$(date +%s)
printf "%s\n%s\n" "${code:-000}" "$((end - start))"
cat "$out"
rm -f "$out"
'
CALL_STATUS=000
CALL_SECONDS=0
CALL_BODY=
call_as() {
  local out
  out=$(board "$CALL" "$DIR" "$1" "$2")
  CALL_STATUS=$(printf '%s\n' "$out" | sed -n 1p)
  CALL_SECONDS=$(printf '%s\n' "$out" | sed -n 2p)
  CALL_BODY=$(printf '%s\n' "$out" | tail -n +3)
  case "$CALL_STATUS" in [0-9][0-9][0-9]) ;; *) CALL_STATUS=000 ;; esac
}
body_json() { printf '%s' "$CALL_BODY" | jq -r "$@" 2>/dev/null; }

# --- 1. a box that is not a Workstation -------------------------------------
call_as owner "/setup-api/system/cluster?availability=1"
if [ "$CALL_STATUS" = 200 ] && [ "$(body_json '.enabled')" = false ]; then
  ok "a box that is not a Workstation: the availability API answers enabled: false"
else
  not_ok "availability on a box with no cluster answered $CALL_STATUS: $(printf '%s' "$CALL_BODY" | head -c 200)"
fi
call_as owner "/setup-api/system/cluster"
if [ "$CALL_STATUS" = 200 ] && [ "$(body_json '.enabled')" = false ] && [ "$(body_json 'has("sparks")')" = false ]; then
  ok "the cluster route answers { enabled: false } with no Sparks, and reads nothing"
else
  not_ok "the cluster route on a box with no cluster answered $CALL_STATUS: $(printf '%s' "$CALL_BODY" | head -c 200)"
fi
call_as owner "/app/settings?section=system"
if [ "$CALL_STATUS" = 200 ]; then
  ok "the Settings page (System) still loads"
else
  not_ok "the Settings page answered $CALL_STATUS"
fi
call_as owner "/setup-api/system/stats"
if [ "$CALL_STATUS" = 200 ] && [ -n "$(body_json '.overview.hostname // empty')" ]; then
  ok "System's own figures still load"
else
  not_ok "system/stats answered $CALL_STATUS"
fi

# --- 2. who may ask ----------------------------------------------------------
for path in "/setup-api/system/cluster" "/setup-api/system/cluster?availability=1"; do
  call_as staff "$path"
  if [ "$CALL_STATUS" = 403 ] && [ "$(body_json '.code // empty')" = owner_only ]; then
    ok "a staff user is answered 403 owner_only by $path"
  else
    not_ok "a staff user asking $path was answered $CALL_STATUS: $(printf '%s' "$CALL_BODY" | head -c 200)"
  fi
done
call_as none "/setup-api/system/cluster"
if [ "$CALL_STATUS" = 401 ]; then
  ok "a request with no session is refused 401"
else
  not_ok "a request with no session answered $CALL_STATUS (a Setup API request with no session must be 401, not a redirect)"
fi

# --- 3. a fake cluster configuration ----------------------------------------
# The engine fixture: on this board's loopback, on a port of its own, it notes
# every request (and whether it carried a key) and answers none of them — the
# box gives up on each after its own timeout, so the cluster read is slow by
# design. It stops itself after 15 minutes if the cleanup never comes.
# shellcheck disable=SC2016
FIXTURE='
DIR=$1
cat > "$DIR/engine-fixture.cjs" <<"JS"
const http = require("http");
const fs = require("fs");
const [hits, portFile, pidFile] = process.argv.slice(2);
const server = http.createServer((req, res) => {
  fs.appendFileSync(hits, `${Date.now()} ${req.method} ${req.url} key=${req.headers.authorization ? "yes" : "no"}\n`);
  // Never answered: the box stops waiting on its own.
  setTimeout(() => { try { res.writeHead(503); res.end(); } catch {} }, 60000).unref();
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(pidFile, String(process.pid));
  fs.writeFileSync(portFile, String(server.address().port));
});
setTimeout(() => process.exit(0), 15 * 60 * 1000);
JS
: > "$DIR/engine-hits"
setsid -f node "$DIR/engine-fixture.cjs" "$DIR/engine-hits" "$DIR/engine-port" "$DIR/engine.pid" </dev/null >"$DIR/engine.log" 2>&1
for _ in $(seq 1 50); do
  [ -s "$DIR/engine-port" ] && break
  sleep 0.2
done
port=$(cat "$DIR/engine-port" 2>/dev/null)
case "$port" in
  ""|*[!0-9]*) echo "FAIL the engine fixture did not start: $(head -c 200 "$DIR/engine.log")" ;;
  *) echo "PORT $port" ;;
esac
'
FIXTURE_OUT=$(board "$FIXTURE" "$DIR" | tail -n1)
# Under a path: the box then asks the path's own /metrics and the origin's one
# after it, each until its own timeout, which keeps the read waiting ~5 s.
case "$FIXTURE_OUT" in
  "PORT "*) ENGINE_URL="http://127.0.0.1:${FIXTURE_OUT#PORT }/fixture/v1"; ok "the engine fixture listens on the board's loopback" ;;
  *) not_ok "${FIXTURE_OUT:-the engine fixture did not start}"; finish ;;
esac

# WRITE_ENV DIR MODE PEERS ENGINE_URL — the checkout's .env as it was, without
# any CLAWBOX_CLUSTER_* line, plus the test's own; then the web server restarted
# onto it. The original is backed up (and checked) before the first write, and
# every step must work, or nothing more is done: "OK" is printed only then.
# shellcheck disable=SC2016
WRITE_ENV='
DIR=$1; mode=$2; peers=$3; engine=$4
ENV_FILE="$REPO/.env"
if [ ! -e "$DIR/env.orig" ] && [ ! -e "$DIR/env.absent" ]; then
  if [ -e "$ENV_FILE" ]; then
    if ! { cp -p "$ENV_FILE" "$DIR/env.orig.part" && cmp -s "$ENV_FILE" "$DIR/env.orig.part" && mv "$DIR/env.orig.part" "$DIR/env.orig"; }; then
      rm -f "$DIR/env.orig.part"
      echo "FAIL could not back the .env up; it was not changed"
      exit 0
    fi
  elif ! : > "$DIR/env.absent"; then
    echo "FAIL could not note that there was no .env; nothing was changed"
    exit 0
  fi
fi
base="$DIR/env.orig"
[ -e "$DIR/env.absent" ] && base=/dev/null
grep -v -E "^[[:space:]]*(export[[:space:]]+)?CLAWBOX_CLUSTER_(PEERS|VIEW|ENGINE_URL)=" "$base" > "$DIR/env.new"
[ $? -le 1 ] || { echo "FAIL could not read the .env backup"; exit 0; }
if ! {
  { [ -z "$peers" ] || printf "CLAWBOX_CLUSTER_PEERS=\"%s\"\n" "$peers"; } \
  && { [ -z "$mode" ] || printf "CLAWBOX_CLUSTER_VIEW=%s\n" "$mode"; } \
  && { [ -z "$engine" ] || printf "CLAWBOX_CLUSTER_ENGINE_URL=%s\n" "$engine"; }
} >> "$DIR/env.new"; then
  echo "FAIL could not write the new .env"
  exit 0
fi
: > "$DIR/env.touched"
if ! cat "$DIR/env.new" > "$ENV_FILE"; then echo "FAIL could not write $ENV_FILE"; exit 0; fi
if ! sudo -n /usr/bin/systemctl restart clawbox-setup.service; then echo "FAIL could not restart the web server"; exit 0; fi
echo OK
'
# restart_with MODE PEERS — write the .env and wait for the NEW web server to
# answer the owner. Polling starts only once the write and the restart worked.
RESTART_ERROR=
restart_with() {
  local out i
  out=$(board "$WRITE_ENV" "$DIR" "$1" "$2" "$ENGINE_URL" 2>&1 | tail -n1)
  if [ "$out" != OK ]; then
    RESTART_ERROR=${out:-the board did not answer the .env step}
    return 1
  fi
  # The dashboard goes down for the restart and comes back: wait for it.
  sleep 5
  for i in $(seq 1 60); do
    call_as owner "/setup-api/system/cluster?availability=1"
    [ "$CALL_STATUS" = 200 ] && return 0
    sleep 5
  done
  RESTART_ERROR="the web server did not come back after the restart"
  return 1
}

# Peers listed on a box that is not a Workstation, the view left on `auto`.
if restart_with "" "$PEERS"; then
  if [ "$(body_json '.enabled')" = false ]; then
    ok "peers alone do not turn the view on: this box is not a Workstation"
  else
    not_ok "peers configured on a box that is not a Workstation turned the Cluster view on: $(printf '%s' "$CALL_BODY" | head -c 200)"
  fi
else
  not_ok "the fake peers could not be put in place: $RESTART_ERROR"
  finish
fi

if ! restart_with on "$PEERS"; then
  not_ok "CLAWBOX_CLUSTER_VIEW=on could not be put in place: $RESTART_ERROR"
  finish
fi
if [ "$(body_json '.enabled')" = true ]; then
  ok "with the view forced on and peers listed, the cluster is available"
else
  not_ok "the cluster is not available with the view on: $(printf '%s' "$CALL_BODY" | head -c 200)"
  finish
fi

# The first read: this Spark, two peers that can never answer and the engine
# fixture, which holds the read open. A web server restart empties the memory,
# so this one really waits. Once the fixture has the cluster read's request —
# so the read is certainly still waiting — system/stats is asked, and must be
# answered before the cluster answer comes.
# shellcheck disable=SC2016
CONCURRENT='
DIR=$1
out=$(mktemp)
ms() { echo $(( $(date +%s%N) / 1000000 )); }
: > "$DIR/engine-hits"
c0=$(ms)
( owner_api GET /setup-api/system/cluster > "$out"; ms > "$out.end" ) &
bg=$!
held=no
for _ in $(seq 1 100); do
  if [ -s "$DIR/engine-hits" ]; then held=yes; break; fi
  sleep 0.1
done
s0=$(ms)
stats=$(owner_api GET /setup-api/system/stats | head -n1)
s1=$(ms)
wait "$bg"
c1=$(cat "$out.end" 2>/dev/null || echo 0)
keys=$(grep -c "key=yes" "$DIR/engine-hits")
hits=$(wc -l < "$DIR/engine-hits")
printf "%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n" "$stats" "$((s1 - s0))" "$(( (c1 - c0) / 1000 ))" "$held" "$s0" "$s1" "$c1" "$hits" "$keys"
cat "$out"
rm -f "$out" "$out.end"
'
COUT=$(board "$CONCURRENT" "$DIR")
STATS_STATUS=$(printf '%s\n' "$COUT" | sed -n 1p)
STATS_MS=$(printf '%s\n' "$COUT" | sed -n 2p)
CLUSTER_SECONDS=$(printf '%s\n' "$COUT" | sed -n 3p)
HELD=$(printf '%s\n' "$COUT" | sed -n 4p)
STATS_START=$(printf '%s\n' "$COUT" | sed -n 5p)
STATS_END=$(printf '%s\n' "$COUT" | sed -n 6p)
CLUSTER_END=$(printf '%s\n' "$COUT" | sed -n 7p)
ENGINE_HITS=$(printf '%s\n' "$COUT" | sed -n 8p)
ENGINE_KEYS=$(printf '%s\n' "$COUT" | sed -n 9p)
CALL_STATUS=$(printf '%s\n' "$COUT" | sed -n 10p)
CALL_BODY=$(printf '%s\n' "$COUT" | tail -n +11)
num() { case "$1" in ''|*[!0-9]*) echo "${2:-0}" ;; *) echo "$1" ;; esac; }

if [ "$CALL_STATUS" = 200 ]; then
  ok "the cluster route answered with the peers down and the engine holding"
else
  not_ok "the cluster route answered $CALL_STATUS with the peers down: $(printf '%s' "$CALL_BODY" | head -c 200)"
  finish
fi
if [ "$(num "$CLUSTER_SECONDS" 99)" -le 15 ]; then
  ok "it did not hang: the answer took ${CLUSTER_SECONDS} s with two peers that never answer and an engine that holds (the ceiling is 7 s)"
else
  not_ok "the cluster route took ${CLUSTER_SECONDS} s"
fi
if [ "$HELD" = yes ] && [ "$STATS_STATUS" = 200 ] && [ "$(num "$STATS_MS" 99999)" -le 3000 ] \
  && [ "$(num "$STATS_START" 0)" -gt 0 ] && [ "$(num "$STATS_END" 0)" -lt "$(num "$CLUSTER_END" 0)" ]; then
  ok "the web server answered system/stats in ${STATS_MS} ms while the cluster read was still waiting on the engine fixture, $(( $(num "$CLUSTER_END" 0) - $(num "$STATS_END" 0) )) ms before the cluster answer"
else
  not_ok "system/stats was not answered while the cluster read waited (fixture holding: $HELD, stats $STATS_STATUS in ${STATS_MS} ms, stats ended at ${STATS_END}, cluster at ${CLUSTER_END})"
fi
if [ "$(body_json '.sparks | length')" = 3 ] \
  && [ "$(body_json '.sparks[0].local')" = true ] && [ "$(body_json '.sparks[0].online')" = true ]; then
  ok "this Spark is read and online, beside the two peers"
else
  not_ok "the Sparks are not this one plus two peers: $(printf '%s' "$CALL_BODY" | head -c 300)"
fi
if [ "$(body_json '[.sparks[1:][] | select(.online == false and (.failure | IN("timeout","unreachable","auth","host_key","failed")))] | length')" = 2 ]; then
  ok "both peers are offline, each with a reason, and carry no figures"
else
  not_ok "the peers are not both offline with a reason: $(printf '%s' "$CALL_BODY" | head -c 400)"
fi
if [ "$(body_json '[.sparks[1:][] | has("figures")] | any')" = false ]; then
  ok "an offline Spark has no figures drawn for it"
else
  not_ok "an offline Spark carries figures"
fi
if [ "$(body_json '.sparks[0].figures.memory.totalBytes > 0')" = true ]; then
  ok "this Spark's own memory is read ($(body_json '.sparks[0].figures.unifiedMemory | if . then "unified" else "separate GPU memory or none" end'))"
else
  not_ok "this Spark's memory was not read: $(printf '%s' "$CALL_BODY" | head -c 300)"
fi
if [ "$(body_json '.engine.configured')" = true ] && [ "$(body_json '.engine.gate.online')" = false ] \
  && [ "$(num "$ENGINE_HITS" 0)" -ge 1 ] && [ "$(num "$ENGINE_KEYS" 1)" = 0 ]; then
  ok "the engine read went to the fixture only (${ENGINE_HITS} requests, none with a key) and reports it offline ($(body_json '.engine.gate.reason // "no reason"'))"
else
  not_ok "the engine was not the fixture, reported offline, keyless: configured $(body_json '.engine.configured'), gate $(body_json '.engine.gate | tostring'), ${ENGINE_HITS} requests, ${ENGINE_KEYS} with a key"
fi

# The second answer is from memory: the same readings as the first, at once.
FIRST_READ=$(body_json '[.sparks[].checkedAt] | map(tostring) | join(",")')
call_as owner "/setup-api/system/cluster"
SECOND_READ=$(body_json '[.sparks[].checkedAt] | map(tostring) | join(",")')
if [ "$CALL_STATUS" = 200 ] && [ -n "$FIRST_READ" ] && [ "$SECOND_READ" = "$FIRST_READ" ] && [ "$(num "$CALL_SECONDS" 99)" -le 2 ]; then
  ok "the next answer is served from memory: the same readings (checkedAt ${FIRST_READ}), in ${CALL_SECONDS} s"
else
  not_ok "the second answer ($CALL_STATUS in ${CALL_SECONDS} s) is not the remembered one: checkedAt ${SECOND_READ:-none} vs ${FIRST_READ:-none}"
fi

# --- 4. staff, with a cluster configured -------------------------------------
call_as staff "/setup-api/system/cluster"
if [ "$CALL_STATUS" = 403 ] && [ "$(body_json '.code // empty')" = owner_only ] && [ "$(body_json 'has("sparks")')" = false ]; then
  ok "with peers configured, a staff user is still answered 403 owner_only and no Spark"
else
  not_ok "a staff user asking with a cluster configured was answered $CALL_STATUS: $(printf '%s' "$CALL_BODY" | head -c 200)"
fi

finish
