#!/usr/bin/env bash
# The memory-search embedder: Qwen3-Embedding-0.6B on llama.cpp, run as
# clawbox-embed.service (config/clawbox-embed.service).
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

if [ ! -f "$MODEL_PATH" ]; then
  if [ ! -x "$HF_BIN" ]; then
    echo "[embed] Missing local model at ${MODEL_PATH} and Hugging Face CLI at ${HF_BIN}. Run the embed_model step to provision the memory-search model."
    exit 1
  fi
  echo "[embed] Downloading ${HF_REPO}/${HF_FILE}"
  "$HF_BIN" download "$HF_REPO" "$HF_FILE" --local-dir "$MODEL_DIR"
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

echo "[embed] Starting llama-server (embedding) with ${MODEL_PATH} ngl=${N_GPU_LAYERS} batch=${BATCH}"
# --embd-normalize 2: OpenClaw's ollama adapter L2-normalised vectors on the
# client; its openai-compatible adapter does not, so the server has to.
# --fit off: llama.cpp would otherwise resize "unset" arguments to fill the
# GPU, which on unified memory means taking RAM from everything else.
exec "$BIN_PATH" \
  --host "$HOST" \
  --port "$PORT" \
  --alias "$MODEL_ALIAS" \
  --model "$MODEL_PATH" \
  --embedding \
  --pooling last \
  --embd-normalize 2 \
  --ctx-size "$BATCH" \
  --batch-size "$BATCH" \
  --ubatch-size "$BATCH" \
  --parallel 1 \
  --n-gpu-layers "$N_GPU_LAYERS" \
  --fit off \
  --flash-attn on \
  --cache-type-k "$CACHE_TYPE_K" \
  --cache-type-v "$CACHE_TYPE_V" \
  --no-webui
