# shellcheck shell=bash
# The EMBED_* this sets are read by the script that sources it.
# shellcheck disable=SC2034
# Which local embedding model the memory embedder runs (TASK-2411) — sourced,
# never executed; it defines functions and changes nothing on its own.
#
# The owner's pick lives in data/config.json as two words,
# `memory_shard_local_model` and `memory_shard_local_model_quant`, written by
# the web server (src/lib/embed-server.ts writeActiveLocalEmbeddingModel). They
# are WORDS from a closed catalog and never a path or a repository: the table
# below is the only place an id becomes a file, so a hand-edited config can
# pick between the catalog's models and nothing else. It is a copy of
# LOCAL_EMBEDDING_MODELS in src/lib/embed-runtime-ids.ts, and
# src/tests/unit/local-embedding-models.test.ts fails when the two disagree.
#
# The 0.6B is the DEFAULT SLOT: picking it (or picking nothing) leaves
# EMBED_MODEL / EMBED_HF_REPO / EMBED_HF_FILE as .env and the shipped defaults
# have them, exactly as before the choice existed. Any other model replaces
# all three from the table.
#
# Readers: scripts/start-embed-server.sh (the unit), and
# scripts/ensure-local-embeddings.sh (the boot wiring, which must name the
# model the unit serves or every gateway start would "repair" the config back
# to the 0.6B and rebuild the index).

EMBED_DEFAULT_MODEL_ID="qwen3-embedding-0.6b"

# embed_catalog ID QUANT -> "alias repo file bytes sha256 dimensions"; 1 when unknown.
# A quant the model does not have is its first (best) variant, as in TS.
embed_catalog() {
  case "$1:$2" in
    qwen3-embedding-0.6b:*)
      echo "qwen3-embedding-0.6b Qwen/Qwen3-Embedding-0.6B-GGUF Qwen3-Embedding-0.6B-Q8_0.gguf 639150592 06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439 1024" ;;
    qwen3-embedding-4b:Q4_K_M)
      echo "qwen3-embedding-4b Qwen/Qwen3-Embedding-4B-GGUF Qwen3-Embedding-4B-Q4_K_M.gguf 2496703776 2b0cf8f17b4c723c27303015383c27ec4bf2d8314bb677d05e920dd70bb0f16b 2560" ;;
    qwen3-embedding-4b:*)
      echo "qwen3-embedding-4b Qwen/Qwen3-Embedding-4B-GGUF Qwen3-Embedding-4B-Q8_0.gguf 4279660224 b60ae5ce2dd6a0b77f82cadf21def1f310a3e10cde380ad0081b07a9d416949d 2560" ;;
    *) return 1 ;;
  esac
}

# embed_read_selection CONFIG_JSON -> "ID QUANT". The default for anything that
# is not a readable pick: a missing file, a broken one, an unknown id.
embed_read_selection() {
  local out
  out="$(python3 -I - "$1" <<'PY' 2>/dev/null
import json, sys
try:
    with open(sys.argv[1]) as f:
        c = json.load(f)
except Exception:
    c = {}
if not isinstance(c, dict):
    c = {}
mid = c.get("memory_shard_local_model")
quant = c.get("memory_shard_local_model_quant")
if mid not in ("qwen3-embedding-0.6b", "qwen3-embedding-4b"):
    mid = "qwen3-embedding-0.6b"
if quant not in ("Q8_0", "Q4_K_M"):
    quant = "Q8_0"
print(mid, quant)
PY
)" || out=""
  case "$out" in
    "qwen3-embedding-0.6b "*|"qwen3-embedding-4b "*) printf '%s\n' "$out" ;;
    *) printf '%s Q8_0\n' "$EMBED_DEFAULT_MODEL_ID" ;;
  esac
}

# embed_apply_selection CONFIG_JSON — set the EMBED_* the reader runs with.
#   EMBED_MODEL_ID       the catalog id picked (the default slot's id when none)
#   EMBED_MODEL          llama-server's --alias and OpenClaw's memory.search.model
#   EMBED_HF_REPO/FILE   what to load (and, when absent, fetch)
#   EMBED_SHA256         the Hub's sha256 of that file; "" for a file .env
#                        names that the catalog does not know
#   EMBED_BYTES          its size, or "" likewise
#   EMBED_DIMENSIONS     its vector width, or "" likewise
embed_apply_selection() {
  local sel id quant row alias repo file bytes sha dims
  sel="$(embed_read_selection "$1")"
  id="${sel%% *}"
  quant="${sel#* }"
  EMBED_MODEL_ID="$id"
  EMBED_SHA256=""
  EMBED_BYTES=""
  EMBED_DIMENSIONS=""
  if [ "$id" != "$EMBED_DEFAULT_MODEL_ID" ] && row="$(embed_catalog "$id" "$quant")"; then
    read -r alias repo file bytes sha dims <<<"$row"
    EMBED_MODEL="$alias"
    EMBED_HF_REPO="$repo"
    EMBED_HF_FILE="$file"
    EMBED_SHA256="$sha"
    EMBED_BYTES="$bytes"
    EMBED_DIMENSIONS="$dims"
    return 0
  fi
  EMBED_MODEL_ID="$EMBED_DEFAULT_MODEL_ID"
  row="$(embed_catalog "$EMBED_DEFAULT_MODEL_ID" Q8_0)"
  read -r alias repo file bytes sha dims <<<"$row"
  EMBED_MODEL="${EMBED_MODEL:-$alias}"
  EMBED_HF_REPO="${EMBED_HF_REPO:-$repo}"
  EMBED_HF_FILE="${EMBED_HF_FILE:-$file}"
  # Only the shipped file is the one the catalog vouches for.
  if [ "$EMBED_HF_REPO" = "$repo" ] && [ "$EMBED_HF_FILE" = "$file" ]; then
    EMBED_SHA256="$sha"
    EMBED_BYTES="$bytes"
    EMBED_DIMENSIONS="$dims"
  fi
}

# embed_fetch_verified HF_BIN REPO FILE DIR BYTES SHA256 — the Hub CLI fetch,
# made safe to leave running: the disk is checked first, the CLI resumes a
# partial file on its own, and a file with a known sha256 is hashed before it
# is trusted (a mismatch is deleted, so the next attempt starts clean).
# Prints one line saying what went wrong; 0 only for a verified file.
embed_fetch_verified() {
  local hf="$1" repo="$2" file="$3" dir="$4" bytes="$5" sha="$6" free need got
  mkdir -p "$dir" 2>/dev/null || true
  if [ -n "$bytes" ]; then
    # What is still to come, plus half a gigabyte so a full disk is never the
    # outcome. df reports KiB available to an unprivileged user.
    free="$(df -Pk "$dir" 2>/dev/null | awk 'NR == 2 {print $4 * 1024}')"
    need=$((bytes + 536870912))
    if [ -n "$free" ] && [ "$free" -lt "$need" ]; then
      echo "not enough disk space for $file: needs $((need / 1000000)) MB free, $((free / 1000000)) MB free"
      return 1
    fi
  fi
  if ! "$hf" download "$repo" "$file" --local-dir "$dir" >/dev/null 2>&1; then
    echo "could not download $file"
    return 1
  fi
  if [ ! -f "$dir/$file" ]; then
    echo "$file is still absent after a successful download"
    return 1
  fi
  if [ -n "$sha" ]; then
    got="$(sha256sum "$dir/$file" 2>/dev/null | awk '{print $1}')"
    if [ "$got" != "$sha" ]; then
      rm -f "$dir/$file"
      echo "$file did not verify (sha256 ${got:-unreadable}, expected $sha); deleted it"
      return 1
    fi
  fi
  return 0
}
