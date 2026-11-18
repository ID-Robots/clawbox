#!/usr/bin/env bash
# timeout: 900
# covers: src/lib/cluster-view.ts src/lib/cluster-shared.ts src/app/setup-api/system/cluster/*
# covers: src/components/ClusterPanel.tsx src/lib/non-owner-scope.ts src/lib/update-channel.ts
#
# Settings → System → Cluster (TASK-2670) on the box's own runtime — OpenClaw or
# Hermes, whichever it runs; the suite's Hermes pass switches the runtime and
# runs it again. A lab board is not a Workstation, so this is the "other" half
# of the feature, plus the half that needs a cluster to fail:
#
#   1. A box that is not a Workstation: the owner's `GET system/cluster` says
#      `enabled: false` (the Cluster tab is not drawn), the System page and its
#      figures still load, and listing peers does not turn the view on.
#   2. A staff user (a real second account, as 55-multi-user does) is answered
#      403 `owner_only` by the cluster route in both its forms, and a request
#      with no session 401.
#   3. With a FAKE peer configuration (CLAWBOX_CLUSTER_VIEW=on and two peers
#      that can never answer: a documentation address that drops packets and a
#      name that never resolves) in the checkout's .env, and the web server
#      restarted to read it:
#        - the owner's answer arrives inside 15 s and says this Spark is online
#          and both peers are offline with a reason — it does not hang;
#        - the web server keeps answering other routes while the cluster read
#          is still waiting on the peers;
#        - the second answer is from memory (no second round of ssh timeouts).
#   4. The staff user still gets 403 with peers configured, and nothing was
#      read for them.
#
# The .env is put back, and the web server restarted onto it, even when the
# test fails half way; the second account is removed. Nothing is installed on
# or sent to any other machine: the two peers do not exist.
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
mkdir -p "$DIR"
chmod 700 "$DIR"
'
board "$SETUP" "$DIR" >/dev/null

# Put the checkout's .env back as it was and restart the web server onto it.
# SC2317: run by the EXIT trap.
# shellcheck disable=SC2016,SC2317
restore() {
  board '
    DIR=$1
    ENV_FILE="$REPO/.env"
    if [ -e "$DIR/env.absent" ]; then
      rm -f "$ENV_FILE"
    elif [ -e "$DIR/env.orig" ]; then
      cat "$DIR/env.orig" > "$ENV_FILE"
    fi
    sudo -n /usr/bin/systemctl restart clawbox-setup.service
  ' "$DIR" >/dev/null 2>&1
  note "cleanup: .env restored and the web server restarted"
  if [ -s "$DIR/user" ]; then
    board '
      DIR=$1
      name=$(cat "$DIR/user")
      owner_api DELETE /setup-api/users "{\"username\":\"$name\"}" >/dev/null 2>&1
      rm -rf "$DIR"
    ' "$DIR" >/dev/null 2>&1
    note "cleanup: the second account is removed"
  else
    board 'rm -rf "$1"' "$DIR" >/dev/null 2>&1
  fi
  wait_gateway_health 240 >/dev/null 2>&1 || true
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
  ok "a box that is not a Workstation: the cluster is not available (the Cluster tab is not drawn)"
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
if [ "$CALL_STATUS" = 401 ] || [ "$CALL_STATUS" = 307 ] || [ "$CALL_STATUS" = 302 ]; then
  ok "a request with no session is refused ($CALL_STATUS)"
else
  not_ok "a request with no session answered $CALL_STATUS"
fi

# --- 3. a fake peer configuration -------------------------------------------
# shellcheck disable=SC2016
WRITE_ENV='
DIR=$1; mode=$2; peers=$3
ENV_FILE="$REPO/.env"
if [ ! -e "$DIR/env.orig" ] && [ ! -e "$DIR/env.absent" ]; then
  if [ -e "$ENV_FILE" ]; then cp -p "$ENV_FILE" "$DIR/env.orig"; else : > "$DIR/env.absent"; fi
fi
touch "$ENV_FILE"
grep -v -E "^[[:space:]]*(export[[:space:]]+)?CLAWBOX_CLUSTER_(PEERS|VIEW|ENGINE_URL)=" "$ENV_FILE" > "$DIR/env.new" || true
{ [ -n "$peers" ] && printf "CLAWBOX_CLUSTER_PEERS=\"%s\"\n" "$peers"; [ -n "$mode" ] && printf "CLAWBOX_CLUSTER_VIEW=%s\n" "$mode"; } >> "$DIR/env.new" || true
cat "$DIR/env.new" > "$ENV_FILE"
sudo -n /usr/bin/systemctl restart clawbox-setup.service
'
restart_with() {
  board "$WRITE_ENV" "$DIR" "$1" "$2" >/dev/null 2>&1
  # The dashboard goes down for the restart and comes back: wait for it.
  sleep 5
  local i
  for i in $(seq 1 60); do
    call_as owner "/setup-api/system/cluster?availability=1"
    [ "$CALL_STATUS" = 200 ] && return 0
    sleep 5
  done
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
  not_ok "the web server did not come back after the restart onto the fake peers"
  finish
fi

if ! restart_with on "$PEERS"; then
  not_ok "the web server did not come back after the restart onto CLAWBOX_CLUSTER_VIEW=on"
  finish
fi
if [ "$(body_json '.enabled')" = true ]; then
  ok "with the view forced on and peers listed, the cluster is available"
else
  not_ok "the cluster is not available with the view on: $(printf '%s' "$CALL_BODY" | head -c 200)"
  finish
fi

# The first read: this Spark, and two peers that can never answer. A web server
# restart empties the memory, so this one really waits on ssh. While it waits,
# another route must still answer at once.
# shellcheck disable=SC2016
CONCURRENT='
DIR=$1
out=$(mktemp)
first=$(date +%s)
( owner_api GET /setup-api/system/cluster > "$out" ) &
bg=$!
sleep 1
s0=$(date +%s%N)
stats=$(owner_api GET /setup-api/system/stats | head -n1)
s1=$(date +%s%N)
wait "$bg"
last=$(date +%s)
printf "%s\n%s\n%s\n" "$stats" "$(( (s1 - s0) / 1000000 ))" "$((last - first))"
cat "$out"
rm -f "$out"
'
COUT=$(board "$CONCURRENT" "$DIR")
STATS_STATUS=$(printf '%s\n' "$COUT" | sed -n 1p)
STATS_MS=$(printf '%s\n' "$COUT" | sed -n 2p)
CLUSTER_SECONDS=$(printf '%s\n' "$COUT" | sed -n 3p)
CALL_STATUS=$(printf '%s\n' "$COUT" | sed -n 4p)
CALL_BODY=$(printf '%s\n' "$COUT" | tail -n +5)

if [ "$CALL_STATUS" = 200 ]; then
  ok "the cluster route answered with the peers down"
else
  not_ok "the cluster route answered $CALL_STATUS with the peers down: $(printf '%s' "$CALL_BODY" | head -c 200)"
  finish
fi
if [ "${CLUSTER_SECONDS:-99}" -le 15 ]; then
  ok "it did not hang: the answer took ${CLUSTER_SECONDS} s with two peers that never answer (the ceiling is 7 s)"
else
  not_ok "the cluster route took ${CLUSTER_SECONDS} s"
fi
if [ "$STATS_STATUS" = 200 ] && [ "${STATS_MS:-99999}" -le 3000 ]; then
  ok "the web server kept answering other routes meanwhile (system/stats in ${STATS_MS} ms)"
else
  not_ok "system/stats answered $STATS_STATUS in ${STATS_MS} ms while the cluster read was waiting"
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

# The second answer is from memory: a fresh read would wait on the peers again.
call_as owner "/setup-api/system/cluster"
if [ "$CALL_STATUS" = 200 ] && [ "${CALL_SECONDS:-99}" -le 2 ]; then
  ok "the next answer comes from memory (${CALL_SECONDS} s)"
else
  not_ok "the second answer was $CALL_STATUS in ${CALL_SECONDS} s: not from memory"
fi

# --- 4. staff, with a cluster configured -------------------------------------
call_as staff "/setup-api/system/cluster"
if [ "$CALL_STATUS" = 403 ] && [ "$(body_json '.code // empty')" = owner_only ] && [ "$(body_json 'has("sparks")')" = false ]; then
  ok "with peers configured, a staff user is still answered 403 owner_only and no Spark"
else
  not_ok "a staff user asking with a cluster configured was answered $CALL_STATUS: $(printf '%s' "$CALL_BODY" | head -c 200)"
fi

finish
