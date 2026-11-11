#!/usr/bin/env bash
# The memory-search embedder: Qwen3-Embedding-0.6B — or the model the owner
# picked instead (TASK-2411, scripts/embed-model-select.sh) — on llama.cpp,
# run as clawbox-embed.service (config/clawbox-embed.service).
#
# Every knob is an EMBED_* environment variable — the unit loads the project
# .env — with the shipped default written beside it, so the unit file carries
# no arguments and each number lives in exactly one other place,
# src/lib/embed-server.ts, which src/tests/unit/embed-server-pin.test.ts pins
# against this file. The shape mirrors scripts/start-llamacpp.sh: refuse when
# the binary is missing, fetch the GGUF when it is absent, `exec` the server
# so the unit's main pid IS llama-server.
set -euo pipefail

PROJECT_DIR="${CLAWBOX_ROOT:-/home/clawbox/clawbox}"
# WHICH model: the owner's pick in data/config.json, mapped to a file through
# the catalog in embed-model-select.sh. The default slot (the 0.6B) keeps
# whatever .env and the defaults below say; another model replaces
# EMBED_MODEL/EMBED_HF_REPO/EMBED_HF_FILE from the catalog. Without the helper
# (a checkout older than it) the default slot is all there is.
EMBED_MODEL_ID="qwen3-embedding-0.6b"
EMBED_SHA256=""
EMBED_BYTES=""
SELECT_LIB="$(dirname "${BASH_SOURCE[0]}")/embed-model-select.sh"
if [ -f "$SELECT_LIB" ]; then
  # shellcheck source=scripts/embed-model-select.sh
  . "$SELECT_LIB"
  embed_apply_selection "${CLAWBOX_CONFIG_JSON:-$PROJECT_DIR/data/config.json}"
fi
MODEL_DIR="${EMBED_MODEL_DIR:-$PROJECT_DIR/data/embed/models}"
HF_REPO="${EMBED_HF_REPO:-Qwen/Qwen3-Embedding-0.6B-GGUF}"
HF_FILE="${EMBED_HF_FILE:-Qwen3-Embedding-0.6B-Q8_0.gguf}"
MODEL_ALIAS="${EMBED_MODEL:-qwen3-embedding-0.6b}"
HOST="${EMBED_HOST:-127.0.0.1}"
PORT="${EMBED_PORT:-8081}"
LOG_PATH="${EMBED_LOG_PATH:-$PROJECT_DIR/data/embed/server.log}"
BIN_PATH="${LLAMACPP_BIN:-/usr/local/bin/llama-server}"
HF_BIN="${HF_BIN:-${HOME:-/home/clawbox}/.local/bin/hf}"
BATCH="${EMBED_BATCH:-1024}"
N_GPU_LAYERS="${EMBED_N_GPU_LAYERS:-99}"
CACHE_TYPE_K="${EMBED_CACHE_TYPE_K:-q8_0}"
CACHE_TYPE_V="${EMBED_CACHE_TYPE_V:-q8_0}"
LOG_CAP_BYTES=5242880

mkdir -p "$MODEL_DIR" "$(dirname "$LOG_PATH")"
# llama-server logs every request and this unit lives for months: start the
# file over once it passes 5 MB rather than let it grow without bound.
if [ -f "$LOG_PATH" ] && [ "$(stat -c %s "$LOG_PATH" 2>/dev/null || echo 0)" -gt "$LOG_CAP_BYTES" ]; then
  : > "$LOG_PATH"
fi
exec >>"$LOG_PATH" 2>&1

MODEL_PATH="${MODEL_DIR}/${HF_FILE}"
if [ ! -x "$BIN_PATH" ]; then
  echo "[embed] Missing llama-server at ${BIN_PATH}. Run the llama.cpp install step to repair the local runtime."
  exit 1
fi

# A model other than the default slot is never run on a Jetson: the web
# server refuses to pick it there (src/lib/local-embedding-gating.ts), and a
# hand-edited config must not be what takes ~5 GB of the box's one memory
# pool. The reason is the log's last line, which Settings → Local AI shows.
if [ "$EMBED_MODEL_ID" != "qwen3-embedding-0.6b" ] && [ -f /etc/nv_tegra_release ]; then
  echo "[embed] ${MODEL_ALIAS} does not fit on a Jetson: pick Qwen3-Embedding-0.6B in Settings → Local AI."
  exit 1
fi

if [ ! -f "$MODEL_PATH" ]; then
  # The default slot is fetched here on a first start, as it always was. A
  # picked model is fetched by the owner's own download (resumable, verified,
  # 2.5-4.3 GB) and never inside a proxied request that gives a batch 120 s.
  if [ "$EMBED_MODEL_ID" != "qwen3-embedding-0.6b" ]; then
    echo "[embed] ${HF_FILE} is not on this box: download it from Settings → Local AI, or pick Qwen3-Embedding-0.6B."
    exit 1
  fi
  if [ ! -x "$HF_BIN" ]; then
    echo "[embed] Missing local model at ${MODEL_PATH} and Hugging Face CLI at ${HF_BIN}. Run the embed_model step to provision the memory-search model."
    exit 1
  fi
  echo "[embed] Downloading ${HF_REPO}/${HF_FILE}"
  if declare -F embed_fetch_verified >/dev/null; then
    if ! why="$(embed_fetch_verified "$HF_BIN" "$HF_REPO" "$HF_FILE" "$MODEL_DIR" "$EMBED_BYTES" "$EMBED_SHA256")"; then
      echo "[embed] The memory-search model download failed: ${why}"
      exit 1
    fi
  else
    "$HF_BIN" download "$HF_REPO" "$HF_FILE" --local-dir "$MODEL_DIR"
  fi
fi

if [ ! -f "$MODEL_PATH" ]; then
  echo "[embed] Download completed but model file was not found at ${MODEL_PATH}"
  exit 1
fi

if ! [[ "$N_GPU_LAYERS" =~ ^[0-9]+$ ]] || [ "$N_GPU_LAYERS" -gt 999 ]; then
  echo "[embed] Invalid EMBED_N_GPU_LAYERS='${EMBED_N_GPU_LAYERS-}'; falling back to 99"
  N_GPU_LAYERS=99
fi

# -c, -b and -ub are ONE number. Pooled embeddings need the whole sequence in
# a single physical batch — llama-server answers "input is too large to
# process" for anything longer and OpenClaw drops that document from the
# index — while the batch is also what sizes the compute buffer: n_ubatch x
# n_vocab (151,669) x 4 B, measured 0.6 MB per token on this build. ollama's
# 2048 reserved 1.2 GB for tokens that never arrived (the largest real input
# measured across 153 calls was 484). 1024 keeps every measured document with
# twice the headroom; the proxy trims the rare longer one to fit
# (src/lib/embed-input-fit.ts) instead of losing it. Below 512 real documents
# fail, so that is the floor. Raise EMBED_BATCH to 2048 on a box whose notes
# are mostly CJK, where a 1,600-character chunk can be 1,600 tokens.
if ! [[ "$BATCH" =~ ^[0-9]+$ ]] || [ "$BATCH" -lt 512 ]; then
  echo "[embed] Invalid EMBED_BATCH='${EMBED_BATCH-}' (must be an integer >= 512); using 1024"
  BATCH=1024
fi

# --embd-normalize 2: OpenClaw's ollama adapter L2-normalised vectors on the
# client; its openai-compatible adapter does not, so the server has to.
# --fit off: llama.cpp would otherwise resize "unset" arguments to fill the
# GPU, which on unified memory means taking RAM from everything else.
ARGS=(
  --host "$HOST"
  --port "$PORT"
  --alias "$MODEL_ALIAS"
  --model "$MODEL_PATH"
  --embedding
  --pooling last
  --embd-normalize 2
  --ctx-size "$BATCH"
  --batch-size "$BATCH"
  --ubatch-size "$BATCH"
  --parallel 1
  --n-gpu-layers "$N_GPU_LAYERS"
  --fit off
  --flash-attn on
  --cache-type-k "$CACHE_TYPE_K"
  --cache-type-v "$CACHE_TYPE_V"
  --no-webui
)

# Every flag above, asked of the binary BEFORE it is exec'd. llama-server
# refuses an argument it does not know and exits, and a unit that dies on its
# first line left only "error: invalid argument: …" in this log — the proxy and
# Settings → Local AI could say no more than that the embedder stopped. A box
# can hold an older llama-server than this script: the install step used to
# keep whatever binary was already there through every move of the llama.cpp
# pin, and a field box was still on a May build that rejects --embd-normalize
# (TASK-2166). Its own --help says which flags it takes. That costs a CUDA
# init, so the answer is kept per binary (inode, size, mtime) in the runtime
# directory, where a rebuild — a new inode — invalidates it.
#
#   --embd-normalize  missing: dropped, with a warning. It spells out the
#                     server's own default — every llama-server without the
#                     flag L2-normalises pooled embeddings per request
#                     (embd_normalize = 2 in tools/server) — so the vectors
#                     are the same unit vectors with or without it.
#   --fit             missing: dropped. A build that predates it never fits,
#                     which is what "off" asks for.
#   anything else     the embedder cannot run as designed on this binary:
#                     refuse, naming the flags and the fix on the log's LAST
#                     line, which is the line the proxy and Settings → Local
#                     AI show the owner.
FLAGS_CACHE="$(dirname "$LOG_PATH")/llama-server-flags"
BIN_SIG="$(stat -L -c '%d:%i:%s:%Y' "$BIN_PATH" 2>/dev/null || true)"
BIN_VERSION=""
SUPPORTED=""
if [ -n "$BIN_SIG" ] && [ -f "$FLAGS_CACHE" ] && [ "$(head -n 1 "$FLAGS_CACHE" 2>/dev/null)" = "$BIN_SIG" ]; then
  BIN_VERSION="$(sed -n 2p "$FLAGS_CACHE")"
  SUPPORTED="$(tail -n +3 "$FLAGS_CACHE")"
else
  if ! HELP="$(timeout 120 "$BIN_PATH" --help 2>&1)"; then
    echo "[embed] To repair it: sudo bash ${PROJECT_DIR}/install.sh --step llamacpp_runtime"
    echo "[embed] This box's llama-server does not start: $(printf '%s\n' "$HELP" | grep -v '^[[:space:]]*$' | tail -n 1)"
    exit 1
  fi
  BIN_VERSION="$(timeout 120 "$BIN_PATH" --version 2>&1 | sed -n 's/^\(version: .*\)$/\1/p' | head -n 1 || true)"
  # Only the option column: a line that starts with a flag in column 0 —
  # llama.cpp indents every wrapped description line — cut where the
  # description starts (two or more spaces, then a word), so a flag a
  # description merely mentions is never taken for one the binary has.
  SUPPORTED="$(printf '%s\n' "$HELP" \
    | sed -nE 's/^(-.*)$/\1/p' \
    | sed -E 's/[[:space:]]{2,}[^-[:space:]].*$//' \
    | grep -oE -- '--[a-z0-9][a-z0-9-]*' | sort -u || true)"
  if [ -n "$SUPPORTED" ] && [ -n "$BIN_SIG" ]; then
    { printf '%s\n%s\n' "$BIN_SIG" "$BIN_VERSION"; printf '%s\n' "$SUPPORTED"; } > "$FLAGS_CACHE.tmp" 2>/dev/null \
      && mv -f "$FLAGS_CACHE.tmp" "$FLAGS_CACHE" 2>/dev/null || rm -f "$FLAGS_CACHE.tmp"
  fi
fi

supports() { printf '%s\n' "$SUPPORTED" | grep -qxF -- "$1"; }
# Drop flag $1 and the value after it, when it has one ($2 = 1).
drop_flag() {
  local flag="$1" takes_value="$2" kept=() i
  for ((i = 0; i < ${#ARGS[@]}; i++)); do
    if [ "${ARGS[i]}" = "$flag" ]; then
      [ "$takes_value" = 1 ] && i=$((i + 1))
      continue
    fi
    kept+=("${ARGS[i]}")
  done
  ARGS=("${kept[@]}")
}

# A help that names no flags at all is not a verdict on any of them — the
# server itself is the judge then, as it always was.
if [ -n "$SUPPORTED" ]; then
  if ! supports --embd-normalize; then
    drop_flag --embd-normalize 1
    echo "[embed] WARN: this llama-server (${BIN_VERSION:-version unknown}) predates --embd-normalize; starting without it. It L2-normalises embeddings by default, so the vectors are unchanged. Updating ClawBox rebuilds llama.cpp at the version it pins."
  fi
  if ! supports --fit; then
    drop_flag --fit 1
  fi
  MISSING=()
  for arg in "${ARGS[@]}"; do
    case "$arg" in
      --*) supports "$arg" || MISSING+=("$arg") ;;
    esac
  done
  if [ "${#MISSING[@]}" -gt 0 ]; then
    echo "[embed] To rebuild it now: sudo bash ${PROJECT_DIR}/install.sh --step llamacpp_runtime"
    echo "[embed] This box's llama-server (${BIN_VERSION:-version unknown}) is too old for the memory embedder: it does not accept ${MISSING[*]}. Updating ClawBox rebuilds llama.cpp at the version it pins."
    exit 1
  fi
fi

echo "[embed] Starting llama-server (embedding) ${MODEL_ALIAS} with ${MODEL_PATH} ngl=${N_GPU_LAYERS} batch=${BATCH}"
exec "$BIN_PATH" "${ARGS[@]}"
