#!/usr/bin/env bash
# Make semantic memory run on the box instead of in the cloud.
#
# OpenClaw's memory search defaults to OpenAI embeddings, which need an
# OPENAI_API_KEY most boxes don't have (ChatGPT-OAuth / DeepSeek users). On
# those boxes semantic recall is dead ("Semantic memory search is still offline
# ... missing OpenAI provider auth/API-key access") and, worse, on a box that
# DOES have a key every indexed note is shipped to a third party to be embedded
# — the exact opposite of what the product claims.
#
# The embedder is Qwen3-Embedding-0.6B on ClawBox's own llama.cpp, run as
# clawbox-embed.service and reached THROUGH the web server's local-AI proxy
# (src/lib/local-ai-proxy.ts): the proxy is what wakes the unit on the first
# request and puts it to sleep ten idle minutes later, so OpenClaw is pointed at
# the proxy, never at the server's own port. It used to be the same model inside
# ollama — 2.8 GB resident whenever the agent was in use, for a batch size the
# traffic never reached. This script is the single implementation of "have the
# model, point memory.search at the proxy, reindex": install.sh calls it
# directly (after the web server is up), gateway-pre-start.sh launches it
# detached on every gateway start.
#
# OpenClaw 2 (2026.8+) moved the choice from agents.defaults.memorySearch.* to
# memory.search.* and its CLI refuses the retired path outright ("moved to
# memory.search. Run openclaw doctor --fix"). The key names follow the installed
# core, decided below.
#
# Everything here is best-effort. A failure must leave the box on lexical FTS,
# never half-configured, and never block the gateway.
set -euo pipefail

OPENCLAW_BIN="${OPENCLAW_BIN:-/home/clawbox/.npm-global/bin/openclaw}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-/home/clawbox/.openclaw/openclaw.json}"
# The alias llama-server answers to and the `model` OpenClaw sends. Keep in
# step with src/lib/embed-server.ts and scripts/start-embed-server.sh.
EMBED_MODEL="${EMBED_MODEL:-qwen3-embedding-0.6b}"
EMBED_PROVIDER="openai-compatible"
EMBED_MODEL_DIR="${EMBED_MODEL_DIR:-/home/clawbox/clawbox/data/embed/models}"
EMBED_HF_REPO="${EMBED_HF_REPO:-Qwen/Qwen3-Embedding-0.6B-GGUF}"
EMBED_HF_FILE="${EMBED_HF_FILE:-Qwen3-Embedding-0.6B-Q8_0.gguf}"
HF_BIN="${HF_BIN:-/home/clawbox/.local/bin/hf}"
LOCAL_AI_TOKEN_FILE="${LOCAL_AI_TOKEN_FILE:-/home/clawbox/clawbox/data/.local-ai-token}"
EMBED_STATE_FILE="${EMBED_STATE_FILE:-/home/clawbox/clawbox/data/local-embeddings.state}"
FLOCK_BIN="${FLOCK_BIN:-flock}"
# Don't retry a failed ~640MB download on every gateway restart.
EMBED_RETRY_SECONDS="${EMBED_RETRY_SECONDS:-21600}"
# The gateway and the web server start in parallel at boot; the proxy may not
# be listening yet when this runs. How long to keep asking before giving up
# for this run (the next gateway start asks again).
EMBED_PROXY_WAIT_SECONDS="${EMBED_PROXY_WAIT_SECONDS:-120}"

# Where OpenClaw reaches the embedder: the proxy's mount, the same derivation
# src/lib/local-ai-proxy-url.ts makes (CLAWBOX_LOCAL_AI_PROXY_BASE_URL, else
# 127.0.0.1 on the web server's port).
_port="${CLAWBOX_PORT:-${PORT:-80}}"
[[ "$_port" =~ ^[0-9]+$ ]] || _port=80
if [ -n "${CLAWBOX_LOCAL_AI_PROXY_BASE_URL:-}" ]; then
  PROXY_ROOT="${CLAWBOX_LOCAL_AI_PROXY_BASE_URL%/}"
elif [ "$_port" = "80" ]; then
  PROXY_ROOT="http://127.0.0.1"
else
  PROXY_ROOT="http://127.0.0.1:$_port"
fi
EMBED_PROXY_URL="${EMBED_PROXY_URL:-$PROXY_ROOT/setup-api/local-ai/embed/v1}"

log() { echo "  [local-embeddings] $*"; }

# --- which generation of OpenClaw will parse what we write? ------------------
# gateway-pre-start.sh asks the binary and exports CLAWBOX_OPENCLAW_V2 before
# launching this, so the two cannot disagree. install.sh calls this directly and
# exports nothing: then read the installed core's own package.json, the one
# next to the binary (/home/clawbox/.npm-global/lib/node_modules/openclaw) —
# never `openclaw --version`, which costs ~10s on a Jetson. No core at all (a
# Hermes box) keeps the legacy names, where the write fails soft as before.
if [ -z "${CLAWBOX_OPENCLAW_V2:-}" ]; then
  CLAWBOX_OPENCLAW_V2=0
  OPENCLAW_PKG="$(dirname "$OPENCLAW_BIN")/../lib/node_modules/openclaw/package.json"
  INSTALLED_VERSION="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("version") or "")' "$OPENCLAW_PKG" 2>/dev/null || true)"
  # Shape-checked, the same way scripts/gateway-pre-start.sh grades this exact
  # file: a version that is not a date says nothing about the generation. The
  # bare `sort -V` below reads a non-date as NEWER than 2026.8 -- `next` and
  # `dev` both grade v2 -- so a dev build, a fork or a vendor rebuild picked
  # memory.search on a core that may be v1. Anchored to the whole string because
  # this is a version FIELD, and a suffix is kept by the extraction
  # (2026.8.1-rc.2 -> 2026.8.1), so only a genuinely undatable core falls out.
  # Falling out is the safe direction here: it lands on the same legacy names a
  # box with no core at all already takes, and that write fails soft. TASK-657.
  INSTALLED_VERSION="$(printf '%s' "$INSTALLED_VERSION" | grep -oE '^20[0-9]{2}\.[0-9]+\.[0-9]+' || true)"
  if [ -n "$INSTALLED_VERSION" ] && [ "$(printf '%s\n' 2026.8 "$INSTALLED_VERSION" | sort -V | head -1)" = "2026.8" ]; then
    CLAWBOX_OPENCLAW_V2=1
  fi
fi
if [ "$CLAWBOX_OPENCLAW_V2" = "1" ]; then
  MEMORY_SEARCH_KEY="memory.search"
else
  MEMORY_SEARCH_KEY="agents.defaults.memorySearch"
fi

# --- read the current choice -------------------------------------------------
# Read straight from openclaw.json rather than `openclaw config get`: this runs
# before/around the gateway and a CLI round-trip costs ~10s on a Jetson.
read_path() {
  python3 - "$OPENCLAW_CONFIG" "$1" <<'PY' 2>/dev/null || true
import json, sys
try:
    node = json.load(open(sys.argv[1]))
except Exception:
    print("")
    sys.exit(0)
for part in sys.argv[2].split("."):
    node = node.get(part) if isinstance(node, dict) else None
print(node if isinstance(node, str) else "")
PY
}
read_cfg() { read_path "$MEMORY_SEARCH_KEY.$1"; }

# Is a base URL this box's own loopback? `openai-compatible` is one provider id
# for two very different things: our embedder behind the local proxy, and a
# server across the room the owner chose. Only the host tells them apart.
is_loopback_url() {
  python3 - "$1" <<'PY' 2>/dev/null
import sys
from urllib.parse import urlparse
host = urlparse(sys.argv[1]).hostname or ""
sys.exit(0 if host in ("127.0.0.1", "localhost", "::1") else 1)
PY
}

# The other generation's home. Read for ONE decision, the guard just below.
if [ "$CLAWBOX_OPENCLAW_V2" = "1" ]; then
  OTHER_SEARCH_KEY="agents.defaults.memorySearch"
else
  OTHER_SEARCH_KEY="memory.search"
fi

PROVIDER="$(read_cfg provider)"
# A remote provider the owner chose is left alone wherever it is recorded. On a
# box upgraded to OpenClaw 2 whose config `doctor --fix` has not migrated yet,
# that choice still sits in agents.defaults.memorySearch while memory.search is
# empty; reading only the live home saw "unset", overwrote it, and the later
# migration then had nothing left to carry forward. The rule belongs HERE,
# where it decides whether to WRITE; install.sh's post-run check asks the core
# what it resolved (`openclaw memory status --json`, TASK-659). Everything
# AFTER this guard (the "already configured" test and the writes) stays on the
# live home, so a legacy value on a v2 box is migrated, not mistaken for done.
#
# `ollama` is ours from before the move and is migrated. `openai-compatible`
# is ours only at the loopback proxy: the same id at any other host is a
# server the owner set up, and a failed run of THIS script must never turn
# into a reason to take it over (that is also why a failed reindex below never
# changes the provider back).
RECORDED_PROVIDER="$PROVIDER"
RECORDED_IN="$MEMORY_SEARCH_KEY"
if [ -z "$RECORDED_PROVIDER" ]; then
  RECORDED_PROVIDER="$(read_path "$OTHER_SEARCH_KEY.provider")"
  RECORDED_IN="$OTHER_SEARCH_KEY"
fi
case "$RECORDED_PROVIDER" in
  ""|auto|ollama) ;;
  "$EMBED_PROVIDER")
    RECORDED_BASE="$(read_path "$RECORDED_IN.remote.baseUrl")"
    if [ -n "$RECORDED_BASE" ] && [ "$RECORDED_BASE" != "$EMBED_PROXY_URL" ] && ! is_loopback_url "$RECORDED_BASE"; then
      log "$RECORDED_IN.provider is \"$RECORDED_PROVIDER\" at $RECORDED_BASE — a deliberate choice, leaving it alone"
      exit 0
    fi
    ;;
  *)
    log "$RECORDED_IN.provider is \"$RECORDED_PROVIDER\" — a deliberate choice, leaving it alone"
    exit 0
    ;;
esac

# --- one run at a time -------------------------------------------------------
# Two gateway restarts in quick succession must not start two downloads. flock
# is an advisory lock the kernel drops when this process exits, so it stays
# valid for exactly as long as its owner runs — a download that takes an hour
# on a slow link still holds it, and a killed run never leaves it behind.
#
# No lock, no run: proceeding unserialised would let two starts download,
# configure and reindex at once, which is the failure this exists to prevent.
# Doing nothing is always the safe outcome here — the next boot tries again.
mkdir -p "$(dirname "$EMBED_STATE_FILE")" 2>/dev/null || true
LOCK_FILE="${EMBED_STATE_FILE}.lock"
if ! command -v "$FLOCK_BIN" >/dev/null 2>&1; then
  log "WARN: $FLOCK_BIN is not available, cannot serialise runs — doing nothing"
  exit 0
fi
if ! : >>"$LOCK_FILE" 2>/dev/null; then
  log "WARN: cannot open $LOCK_FILE — doing nothing"
  exit 0
fi
exec 9>>"$LOCK_FILE"
if ! "$FLOCK_BIN" -n 9; then
  log "another run is already working on this — skipping"
  exit 0
fi

state_get() {
  [ -f "$EMBED_STATE_FILE" ] || { echo 0; return; }
  local v
  v="$(sed -n "s/^$1=//p" "$EMBED_STATE_FILE" | head -1)"
  case "$v" in ''|*[!0-9]*) echo 0 ;; *) echo "$v" ;; esac
}
# The state file carries the download backoff and whether a reindex is still
# owed. Only a DOWNLOAD failure earns the backoff: a proxy that is not up yet
# or a reindex that did not finish are transient, and the next gateway start
# is the right time to try them again.
state_write() {
  # temp + rename: a run killed mid-write must never leave a truncated state
  # file, because a lost reindex_pending marker means a permanently
  # fail-closed index.
  local tmp="${EMBED_STATE_FILE}.tmp.$$"
  printf 'last_attempt=%s\nfailures=%s\nreindex_pending=%s\n' \
    "$1" "$2" "${3:-$(state_get reindex_pending)}" > "$tmp"
  mv -f "$tmp" "$EMBED_STATE_FILE"
}
state_set_reindex_pending() {
  state_write "$(state_get last_attempt)" "$(state_get failures)" "$1"
}

# --- is the model there? -----------------------------------------------------
MODEL_PATH="$EMBED_MODEL_DIR/$EMBED_HF_FILE"
if [ ! -f "$MODEL_PATH" ]; then
  NOW="$(date +%s)"
  LAST="$(state_get last_attempt)"
  FAILURES="$(state_get failures)"
  if [ "$LAST" -gt 0 ] && [ "$((NOW - LAST))" -lt "$EMBED_RETRY_SECONDS" ]; then
    log "$EMBED_HF_FILE is missing; last download attempt was $((NOW - LAST))s ago, waiting out the retry window"
    exit 0
  fi
  if [ ! -x "$HF_BIN" ]; then
    log "WARN: $HF_BIN is not installed, cannot fetch $EMBED_HF_FILE (non-fatal; lexical FTS remains)"
    exit 0
  fi
  state_write "$NOW" "$FAILURES"
  log "downloading $EMBED_HF_REPO/$EMBED_HF_FILE (local embeddings, no API key needed) — this can take a few minutes"
  mkdir -p "$EMBED_MODEL_DIR" 2>/dev/null || true
  if ! "$HF_BIN" download "$EMBED_HF_REPO" "$EMBED_HF_FILE" --local-dir "$EMBED_MODEL_DIR" >/dev/null 2>&1; then
    state_write "$NOW" "$((FAILURES + 1))"
    log "WARN: could not download $EMBED_HF_FILE (attempt $((FAILURES + 1))); semantic memory stays on lexical FTS"
    exit 0
  fi
  state_write "$NOW" 0
  if [ ! -f "$MODEL_PATH" ]; then
    log "WARN: $EMBED_HF_FILE still absent after a successful download; leaving memory search untouched"
    exit 0
  fi
  log "downloaded $EMBED_HF_FILE"
fi

# --- is the embedder reachable through the proxy? ----------------------------
# Through the PROXY, not the server's port: the proxy is what OpenClaw will
# call, a request to it starts the unit, and a 200 here proves the whole path
# (web server up, token accepted, unit started, model loaded). --max-time
# covers a cold 4 s load with room for a slow first start; the outer loop
# covers a web server that is still booting alongside the gateway.
TOKEN="$(cat "$LOCAL_AI_TOKEN_FILE" 2>/dev/null || true)"
if [ "${#TOKEN}" -lt 16 ]; then
  log "no local-AI token at $LOCAL_AI_TOKEN_FILE yet (the web server writes it at first start) — trying again on the next gateway start"
  exit 0
fi
embed_ready() {
  curl -fsS --max-time 200 -H "Authorization: Bearer $TOKEN" "$EMBED_PROXY_URL/models" >/dev/null 2>&1
}
waited=0
until embed_ready; do
  if [ "$waited" -ge "$EMBED_PROXY_WAIT_SECONDS" ]; then
    log "the embedder did not answer through $EMBED_PROXY_URL within ${EMBED_PROXY_WAIT_SECONDS}s — semantic memory stays as it is; trying again on the next gateway start"
    exit 0
  fi
  sleep 5
  waited=$((waited + 5))
done

# --- point memory search at it -----------------------------------------------
CURRENT_MODEL="$(read_cfg model)"
CURRENT_BASE="$(read_cfg remote.baseUrl)"
CURRENT_KEY="$(read_cfg remote.apiKey)"
CURRENT_QUERY_TYPE="$(read_cfg queryInputType)"
CURRENT_DOC_TYPE="$(read_cfg documentInputType)"
# Two questions, not one. Anything different means a write; only the fields
# OpenClaw folds into the index identity — provider, model, base URL, the
# input-type labels — mean a reindex. The token is not one of them: it is
# minted by the web server and wiped with a factory reset, so a restored
# config can carry a stale one, and a stale bearer is a 401 OpenClaw never
# retries. Re-writing it here, at every gateway start, is the repair — and a
# full reindex for it would be an hour of GPU time for nothing.
NEEDS_WRITE=0
NEEDS_REINDEX=0
[ "$CURRENT_MODEL" = "$EMBED_MODEL" ] || NEEDS_REINDEX=1
[ "$CURRENT_BASE" = "$EMBED_PROXY_URL" ] || NEEDS_REINDEX=1
[ "$CURRENT_QUERY_TYPE" = "query" ] || NEEDS_REINDEX=1
[ "$CURRENT_DOC_TYPE" = "document" ] || NEEDS_REINDEX=1
[ "$PROVIDER" = "$EMBED_PROVIDER" ] || NEEDS_REINDEX=1
[ "$NEEDS_REINDEX" -eq 0 ] || NEEDS_WRITE=1
[ "$CURRENT_KEY" = "$TOKEN" ] || NEEDS_WRITE=1

set_cfg() {
  "$OPENCLAW_BIN" config set "$MEMORY_SEARCH_KEY.$1" "$2" >/dev/null 2>&1
}

if [ "$NEEDS_WRITE" -eq 0 ]; then
  if [ "$(state_get reindex_pending)" != "1" ]; then
    log "memory search already runs on local embeddings ($EMBED_MODEL via llama.cpp) — nothing to do"
    exit 0
  fi
  # Config is right but the reindex it needs never completed, so memory search
  # is still fail-closed. Rolling the config back would only move the box to a
  # provider it has no key for; retrying the reindex is the recoverable half.
  log "memory search is on local embeddings but its reindex never completed — retrying it"
else
  # Everything else first, the provider LAST. The provider write is what
  # actually switches embedding backends, so if any earlier call fails the box
  # is left on exactly the provider it already had — never on the new one
  # pointed at a half-written address.
  # `queryInputType`/`documentInputType` are what make OpenClaw label each
  # request; the proxy restores the model's query instruction from that label
  # (src/lib/embed-query-instruction.ts). Without them every query would be
  # embedded bare and recall would quietly degrade.
  if ! set_cfg model "$EMBED_MODEL" \
    || ! set_cfg remote.baseUrl "$EMBED_PROXY_URL" \
    || ! set_cfg remote.apiKey "$TOKEN" \
    || ! set_cfg queryInputType query \
    || ! set_cfg documentInputType document; then
    log "WARN: could not write the local embedding settings (non-fatal; provider unchanged, memory search stays as it is)"
    exit 0
  fi
  # Recorded BEFORE the provider write, not after: between switching the
  # backend and recording that a reindex is owed there must be no window where
  # a killed run leaves a configured provider and an index nobody rebuilds.
  # The marker is deliberately kept if the provider write then fails — a later
  # attempt finishes the job, and a stale marker only costs one extra reindex.
  if [ "$NEEDS_REINDEX" -eq 1 ]; then
    state_set_reindex_pending 1
  fi
  if [ "$PROVIDER" != "$EMBED_PROVIDER" ] && ! set_cfg provider "$EMBED_PROVIDER"; then
    log "WARN: could not point memory search at the on-box embedder (non-fatal; provider is unchanged, memory search stays as it is)"
    exit 0
  fi
  log "memory search -> local embeddings ($EMBED_MODEL via llama.cpp at $EMBED_PROXY_URL, no API key needed)"
fi

# --- and reindex, or it stays fail-closed ------------------------------------
# Changing the embedding provider changes the index identity — OpenClaw keeps
# the provider id and the base URL in it — and it treats the old index as
# somebody else's: vector search returns nothing until a full reindex runs.
# Switching the provider without this is how you get a box that looks
# configured and returns nothing.
if [ "$(state_get reindex_pending)" != "1" ]; then
  log "the index is already built for this embedder — no reindex needed"
  exit 0
fi
if "$OPENCLAW_BIN" memory index --force >/dev/null 2>&1; then
  state_set_reindex_pending 0
  log "forced a full memory reindex for the new embedding provider"
else
  log "WARN: forced reindex failed — memory search stays fail-closed until it succeeds; retrying on the next run"
fi
