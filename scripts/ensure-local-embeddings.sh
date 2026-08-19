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
# install.sh used to pull the local embedding model at install time and
# gateway-pre-start.sh only switched memorySearch over when the model was
# already present. That is a chicken-and-egg: a box whose install-time pull
# never ran (or failed) can never self-heal and stays pointed at the cloud
# embedder forever. Verified on test box 192.168.50.66: ollama running, zero
# models pulled, no agents.defaults.memorySearch key, `openclaw memory status`
# reporting provider "openai".
#
# So the pull lives here, next to the switch, and both run from one place:
# install.sh calls it directly, gateway-pre-start.sh launches it detached (the
# model is a ~600MB download and pre-start is a blocking ExecStartPre).
#
# Everything here is best-effort. A failure must leave the box on lexical FTS,
# never half-configured, and never block the gateway.
set -euo pipefail

OPENCLAW_BIN="${OPENCLAW_BIN:-/home/clawbox/.npm-global/bin/openclaw}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-/home/clawbox/.openclaw/openclaw.json}"
OLLAMA_BIN="${OLLAMA_BIN:-ollama}"
OLLAMA_TAGS_URL="${OLLAMA_TAGS_URL:-http://localhost:11434/api/tags}"
EMBED_MODEL="${EMBED_MODEL:-qwen3-embedding:0.6b}"
EMBED_STATE_FILE="${EMBED_STATE_FILE:-/home/clawbox/clawbox/data/local-embeddings.state}"
# Don't retry a failed ~600MB pull on every gateway restart.
EMBED_RETRY_SECONDS="${EMBED_RETRY_SECONDS:-21600}"

log() { echo "  [local-embeddings] $*"; }

# --- read the current choice -------------------------------------------------
# Read straight from openclaw.json rather than `openclaw config get`: this runs
# before/around the gateway and a CLI round-trip costs ~10s on a Jetson.
read_cfg() {
  python3 - "$OPENCLAW_CONFIG" "$1" <<'PY' 2>/dev/null || true
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
except Exception:
    print("")
    sys.exit(0)
ms = ((cfg.get("agents") or {}).get("defaults") or {}).get("memorySearch") or {}
value = ms.get(sys.argv[2])
print(value if isinstance(value, str) else "")
PY
}

PROVIDER="$(read_cfg provider)"
case "$PROVIDER" in
  ""|auto|ollama) ;;
  *)
    log "memorySearch.provider is \"$PROVIDER\" — a deliberate choice, leaving it alone"
    exit 0
    ;;
esac

# --- one run at a time -------------------------------------------------------
# Two gateway restarts in quick succession must not start two pulls.
mkdir -p "$(dirname "$EMBED_STATE_FILE")" 2>/dev/null || true
LOCK_DIR="${EMBED_STATE_FILE}.lock"
# A lock older than the retry window belongs to a run that was killed (systemd
# tears the cgroup down on gateway stop), not to a live one.
if [ -d "$LOCK_DIR" ] && [ -z "$(find "$LOCK_DIR" -maxdepth 0 -mmin -60 2>/dev/null)" ]; then
  rmdir "$LOCK_DIR" 2>/dev/null || true
fi
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "another run is already working on this — skipping"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# --- is the local model there? -----------------------------------------------
fetch_tags() { curl -fsS --max-time 5 "$OLLAMA_TAGS_URL" 2>/dev/null || true; }
TAGS="$(fetch_tags)"
if [ -z "$TAGS" ]; then
  log "ollama is not reachable at $OLLAMA_TAGS_URL — semantic memory stays on lexical FTS"
  exit 0
fi
model_present() { printf '%s' "$1" | grep -qF "\"$EMBED_MODEL\""; }

state_get() {
  [ -f "$EMBED_STATE_FILE" ] || { echo 0; return; }
  local v
  v="$(sed -n "s/^$1=//p" "$EMBED_STATE_FILE" | head -1)"
  case "$v" in ''|*[!0-9]*) echo 0 ;; *) echo "$v" ;; esac
}
state_write() {
  printf 'last_attempt=%s\nfailures=%s\n' "$1" "$2" > "$EMBED_STATE_FILE"
}

if ! model_present "$TAGS"; then
  NOW="$(date +%s)"
  LAST="$(state_get last_attempt)"
  FAILURES="$(state_get failures)"
  if [ "$LAST" -gt 0 ] && [ "$((NOW - LAST))" -lt "$EMBED_RETRY_SECONDS" ]; then
    log "$EMBED_MODEL is missing; last pull attempt was $((NOW - LAST))s ago, waiting out the retry window"
    exit 0
  fi
  if ! command -v "$OLLAMA_BIN" >/dev/null 2>&1; then
    log "WARN: $OLLAMA_BIN not on PATH, cannot pull $EMBED_MODEL (non-fatal; lexical FTS remains)"
    exit 0
  fi
  state_write "$NOW" "$FAILURES"
  log "pulling $EMBED_MODEL (local embeddings, no API key needed) — this can take a few minutes"
  if ! "$OLLAMA_BIN" pull "$EMBED_MODEL" >/dev/null 2>&1; then
    state_write "$NOW" "$((FAILURES + 1))"
    log "WARN: could not pull $EMBED_MODEL (attempt $((FAILURES + 1))); semantic memory stays on lexical FTS"
    exit 0
  fi
  state_write "$NOW" 0
  TAGS="$(fetch_tags)"
  if ! model_present "$TAGS"; then
    log "WARN: $EMBED_MODEL still absent after a successful pull; leaving memorySearch untouched"
    exit 0
  fi
  log "pulled $EMBED_MODEL"
fi

# --- point memory search at it -----------------------------------------------
CURRENT_MODEL="$(read_cfg model)"
if [ "$PROVIDER" = "ollama" ] && [ "$CURRENT_MODEL" = "$EMBED_MODEL" ]; then
  log "memory search already runs on local embeddings ($EMBED_MODEL) — nothing to do"
  exit 0
fi

if ! "$OPENCLAW_BIN" config set agents.defaults.memorySearch.provider ollama >/dev/null 2>&1 \
  || ! "$OPENCLAW_BIN" config set agents.defaults.memorySearch.model "$EMBED_MODEL" >/dev/null 2>&1; then
  log "WARN: could not point memorySearch at local Ollama embeddings (non-fatal; lexical FTS remains)"
  exit 0
fi
log "memory search -> local Ollama embeddings ($EMBED_MODEL, no API key needed)"

# --- and reindex, or it stays fail-closed ------------------------------------
# Changing the embedding model changes the vector dimensions (3072 for OpenAI's
# text-embedding-3-large vs 1024 for qwen3-embedding:0.6b). OpenClaw treats the
# old index as a different identity and fails closed — memory search reports
# itself disabled and stays that way until something forces a full reindex.
# Switching the provider without this is how you get a box that looks configured
# and returns nothing.
if "$OPENCLAW_BIN" memory index --force >/dev/null 2>&1; then
  log "forced a full memory reindex for the new embedding dimensions"
else
  log "WARN: forced reindex failed — memory search may stay fail-closed until 'openclaw memory index --force' is run"
fi
