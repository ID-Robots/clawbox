#!/usr/bin/env bash
# Runs ON the board, as clawbox, for scripts/nano-tests/tests/66-background-task-card.sh
# and 99-background-task-card-hermes.sh: the memory-model download started from
# Settings, Settings closed, the desktop's corner card followed to the end — in
# a headless Chromium of its own (./background-task-card.mjs) — and the board
# left as it was found.
#
#   background-task-card.sh [--switch-to openclaw|hermes]
#
# With --switch-to, the agent runtime is first switched the way Settings
# switches it: `POST /setup-api/harness/select` on an unlocked dual box (the
# Harness tiles), the harness swap on a locked one (its "Switch to …", a
# reinstall of minutes that the ClawBox AI plan must allow). A select is
# switched back at the end; a swap is not — the test that asks for one runs
# last and the board is recycled after the run.
#
# Settings → Local AI offers the memory model only where memory search embeds
# ON THIS BOX. A board whose ClawBox AI plan covers it embeds in the cloud by
# default (src/lib/clawai-cloud-defaults.ts), and its row reads "Searching your
# memory in the cloud" with no Install and no card under it. Such a board is
# first moved onto the box the way the owner moves it — Memory Shard's "On
# this box", `POST /setup-api/clawkeep/memory/provider` — and handed back at
# the end: to its plan's default (`POST /setup-api/ai-cloud-defaults`), or to
# the cloud the owner had picked.
#
# Prints `RESULT ok - …`, `RESULT not ok - …`, `RESULT skip - …` and
# `NOTE …` lines, each result prefixed with `[<runtime>] `, the agent runtime
# the board ran it under, so the OpenClaw and Hermes runs can be told apart.
# The owner's cookie is minted here from data/.session-secret and reaches the
# browser through DevTools only: never printed, never on a command line.
set -uo pipefail

SWITCH_TO=""
if [ "${1:-}" = "--switch-to" ]; then SWITCH_TO=${2:-}; fi
TAG=""
REPO=/home/clawbox/clawbox
DASHBOARD=http://127.0.0.1
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DRIVER="$HERE/background-task-card.mjs"
SECRET_FILE="$REPO/data/.session-secret"

say() { printf 'RESULT %s\n' "$*" | sed -E "s/^RESULT (ok|not ok|skip) - /RESULT \1 - ${TAG//\//\\/}/"; }

if [ ! -r "$SECRET_FILE" ]; then say "not ok - $SECRET_FILE is not readable as the box account"; exit 0; fi

owner_cookie() {
  node -e '
    const fs = require("fs"), crypto = require("crypto");
    const secret = fs.readFileSync(process.argv[1], "utf8").trim();
    let gen = 0;
    try { const c = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); if (Number.isFinite(c.session_generation)) gen = c.session_generation; } catch {}
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 1800, gen })).toString("base64url");
    process.stdout.write(payload + "." + crypto.createHmac("sha256", secret).update(payload).digest("hex"));
  ' "$SECRET_FILE" "$REPO/data/config.json"
}
OWNER=$(owner_cookie)

# call METHOD PATH [BODY] as the owner -> status on the first line, body after.
# The cookie goes to curl on stdin as a config line, never on a command line.
call() {
  local method=$1 path=$2 body=${3:-} out code extra=()
  [ -n "$body" ] && extra=(-H "Content-Type: application/json" --data-binary "$body")
  out=$(mktemp)
  code=$(printf 'header = "Cookie: clawbox_session=%s"\nheader = "Origin: http://127.0.0.1"\n' "$OWNER" \
    | curl -sS -o "$out" -w "%{http_code}" -X "$method" --max-time "${CALL_MAX_TIME:-120}" "${extra[@]}" -K - "$DASHBOARD$path" 2>/dev/null)
  printf '%s\n' "${code:-000}"; cat "$out"; rm -f "$out"
}
status_of() { printf '%s\n' "$1" | head -n1; }
body_of() { printf '%s\n' "$1" | tail -n +2; }
# field NAME: a top-level field of the JSON on stdin (python3: a stock board has no jq).
field() { python3 -c 'import json,sys; v=json.load(sys.stdin).get(sys.argv[1]); print("" if v is None else v)' "$1" 2>/dev/null; }
active_runtime() { body_of "$(call GET /setup-api/harness/status)" | field active; }

SWITCHED_BY=""
ORIGINAL=$(active_runtime)
switch_runtime() {
  local target=$1 status locked r swap_info swappable allowed swap_target last
  status=$(body_of "$(call GET /setup-api/harness/status)")
  locked=$(printf '%s' "$status" | field locked)
  if [ "$locked" = False ]; then
    r=$(call POST /setup-api/harness/select "{\"harness\":\"$target\"}")
    if [ "$(status_of "$r")" != 200 ]; then
      say "not ok - Settings' runtime switch to $target answered $(status_of "$r"): $(body_of "$r" | head -c 200)"
      return 1
    fi
    SWITCHED_BY="the Harness tiles (POST /setup-api/harness/select)"
  else
    swap_info=$(body_of "$(call GET /setup-api/harness/swap)")
    swappable=$(printf '%s' "$swap_info" | field swappable)
    allowed=$(printf '%s' "$swap_info" | field allowed)
    swap_target=$(printf '%s' "$swap_info" | field target)
    if [ "$swappable" != True ] || [ "$swap_target" != "$target" ]; then
      say "skip - this board runs a locked $(printf '%s' "$status" | field edition) edition that cannot be switched to $target from Settings"
      return 1
    fi
    if [ "$allowed" != True ]; then
      say "skip - switching this locked board to $target is the harness swap, and its ClawBox AI plan does not include it (the Max plan does)"
      return 1
    fi
    # The swap streams NDJSON to ONE closing line; minutes of reinstall.
    r=$(CALL_MAX_TIME=${SWAP_MAX_TIME_S:-420} call POST /setup-api/harness/swap "{\"harness\":\"$target\"}")
    last=$(body_of "$r" | grep . | tail -n1)
    if [ "$(printf '%s' "$last" | field success)" != True ]; then
      say "not ok - the harness swap to $target did not finish within its budget: $(printf '%s' "$last" | head -c 200)"
      return 1
    fi
    SWITCHED_BY="the harness swap (Settings -> Harness -> Switch to)"
  fi
  for _ in $(seq 1 36); do
    [ "$(active_runtime)" = "$target" ] && break
    sleep 5
  done
  if [ "$(active_runtime)" != "$target" ]; then
    say "not ok - after the switch the board still runs $(active_runtime)"
    return 1
  fi
  say "ok - Settings switched the agent runtime from ${ORIGINAL:-unknown} to $target through $SWITCHED_BY"
}
switch_back() {
  case "$SWITCHED_BY" in
    *harness/select*)
      local r
      r=$(call POST /setup-api/harness/select "{\"harness\":\"$ORIGINAL\"}")
      if [ "$(status_of "$r")" = 200 ]; then say "ok - the runtime is switched back to $ORIGINAL"
      else say "not ok - switching the runtime back to $ORIGINAL answered $(status_of "$r")"; fi ;;
    *swap*) printf 'NOTE the board stays on %s after the swap; it is recycled after the run\n' "$(active_runtime)" ;;
  esac
}

if [ -n "$SWITCH_TO" ] && [ "$ORIGINAL" != "$SWITCH_TO" ]; then
  TAG="[$SWITCH_TO] "
  switch_runtime "$SWITCH_TO" || exit 0
  # Whatever ends the run from here, a select is undone.
  trap switch_back EXIT
fi
RUNTIME=$(active_runtime)
TAG="[${RUNTIME:-runtime unknown}] "

# The Chromium the box itself would use (scripts/launch-browser.sh): the
# Playwright build first, then a system one that is not the snap wrapper.
CHROME=$(find "$HOME/.cache/ms-playwright" -type f \( -path "*/chrome-linux/chrome" -o -path "*/chrome-linux64/chrome" -o -path "*/chrome-linux-arm64/chrome" \) 2>/dev/null | sort -V | tail -1)
if [ -z "$CHROME" ]; then
  for bin in chromium-browser google-chrome-stable google-chrome chromium; do
    p=$(command -v "$bin" 2>/dev/null) || continue
    grep -qE '(/snap/bin/chromium|snap run chromium)' "$p" 2>/dev/null && continue
    CHROME=$p
    break
  done
fi
if [ -z "$CHROME" ]; then say "skip - no Chromium on this board to draw its desktop with"; exit 0; fi
if [ ! -x "$HOME/.local/bin/hf" ] && ! command -v hf >/dev/null 2>&1; then
  say "skip - no Hugging Face CLI on this board, so the memory model cannot be downloaded"
  exit 0
fi

st=$(call GET /setup-api/embed/status)
PRESENT=$(body_of "$st" | python3 -c 'import json,sys; print(1 if json.load(sys.stdin).get("modelAvailable") is True else 0)' 2>/dev/null) || PRESENT=""
if [ "$(status_of "$st")" != 200 ] || [ -z "$PRESENT" ]; then
  say "not ok - the memory model status answered $(status_of "$st")"
  exit 0
fi

# memory_placement -> "<cloud|local> <True|False>": where memory search embeds,
# and whether the owner picked that. Nothing when it cannot be read.
memory_placement() {
  local r
  r=$(call GET /setup-api/ai-cloud-defaults)
  [ "$(status_of "$r")" = 200 ] || return 0
  body_of "$r" | python3 -c 'import json,sys; c=json.load(sys.stdin)["capabilities"]["embeddings"]; print(c["source"], c["ownerChoice"])' 2>/dev/null
}
MEMORY_MOVED=""
# The plan's default comes back through the applier every boot runs (which
# also re-indexes); an owner's own cloud pick the way Memory Shard's card
# makes it: the switch, then a full pass (a 409 is one already running).
hand_memory_back() {
  [ -n "$MEMORY_MOVED" ] || return 0
  local owner_pick=$MEMORY_MOVED r now
  MEMORY_MOVED=""
  if [ "$owner_pick" = True ]; then
    r=$(call POST /setup-api/clawkeep/memory/provider '{"source":"cloud"}')
    [ "$(status_of "$r")" = 200 ] && call POST /setup-api/clawkeep/memory/index '{"mode":"full"}' >/dev/null
  else r=$(call POST /setup-api/ai-cloud-defaults '{"capability":"embeddings"}'); fi
  read -r now _ <<<"$(memory_placement)"
  if [ "$(status_of "$r")" = 200 ] && [ "${now:-}" = cloud ]; then
    say "ok - memory search is back in the ClawBox AI cloud, where the board had it"
  else
    say "not ok - handing memory search back to the ClawBox AI cloud answered $(status_of "$r") and left it ${now:-unreadable}: $(body_of "$r" | head -c 200)"
  fi
}
read -r MEMORY_SOURCE MEMORY_OWNER_PICK <<<"$(memory_placement)"
if [ -z "${MEMORY_SOURCE:-}" ]; then
  printf 'NOTE where memory search embeds could not be read; the board is tested as it is\n'
elif [ "$MEMORY_SOURCE" = cloud ]; then
  # Armed before the answer is read: the route records the owner's pick before
  # it switches, so even a refused move may have something to hand back. Runs
  # after the model is removed again, and before a selected runtime goes back.
  MEMORY_MOVED=${MEMORY_OWNER_PICK:-False}
  trap 'hand_memory_back; switch_back' EXIT
  r=$(call POST /setup-api/clawkeep/memory/provider '{"source":"local"}')
  if [ "$(status_of "$r")" != 200 ]; then
    say "not ok - moving memory search onto the box (Memory Shard's \"On this box\") answered $(status_of "$r"): $(body_of "$r" | head -c 200)"
    exit 0
  fi
  printf 'NOTE memory search embedded in the ClawBox AI cloud (%s), where Local AI offers no memory model; it is moved onto the box for the test\n' \
    "$([ "$MEMORY_OWNER_PICK" = True ] && echo "the owner's pick" || echo "the plan's default")"
fi

PROFILE=$(mktemp -d /tmp/nano-bg-task-XXXXXX)
OWNER_COOKIE=$OWNER CHROME=$CHROME PROFILE_DIR=$PROFILE FORCE=$PRESENT DEADLINE_S=${DEADLINE_S:-480} \
  timeout "${DRIVER_TIMEOUT_S:-620}" node "$DRIVER" 2>&1 | grep -E '^(RESULT|NOTE) ' | while IFS= read -r line; do
    case "$line" in
      "RESULT "*) say "${line#RESULT }" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done
rm -rf "$PROFILE"

if [ "$PRESENT" = 0 ]; then
  # A model that was not here goes again — once the download has ended (the
  # removal refuses while it runs).
  for _ in $(seq 1 6); do
    running=$(body_of "$(call GET "/setup-api/background-jobs/tasks?kind=embed-model-download")" \
      | python3 -c 'import json,sys; print(any(t.get("state") == "running" for t in json.load(sys.stdin).get("tasks", [])))' 2>/dev/null)
    [ "$running" = True ] || break
    sleep 10
  done
  r=$(call DELETE /setup-api/embed/install)
  case "$(status_of "$r")" in
    200) say "ok - the board is left as it was found: the model downloaded for the test is removed again" ;;
    404) say "ok - the board is left as it was found: no model on it" ;;
    409) say "skip - the download still runs on this board's link, so the model is not removed again (the board is recycled after the run)" ;;
    *) say "not ok - removing the model again answered $(status_of "$r"): $(body_of "$r" | head -c 200)" ;;
  esac
fi
