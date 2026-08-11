#!/usr/bin/env bash
set -euo pipefail

MODEL_DIR="${1:?model dir required}"
HF_REPO="${2:?hf repo required}"
HF_FILE="${3:?hf file required}"
MODEL_ALIAS="${4:?model alias required}"
HOST="${5:?host required}"
PORT="${6:?port required}"
LOG_PATH="${7:?log path required}"
BIN_PATH="${8:?llama-server path required}"
HF_BIN="${9:?hf binary path required}"
CTX_SIZE="${10:?ctx size required}"
CACHE_TYPE_K="${LLAMACPP_CACHE_TYPE_K:-q4_0}"
CACHE_TYPE_V="${LLAMACPP_CACHE_TYPE_V:-q4_0}"
PID_PATH="${LLAMACPP_PID_PATH:-}"

mkdir -p "$MODEL_DIR"
mkdir -p "$(dirname "$LOG_PATH")"
exec >>"$LOG_PATH" 2>&1

MODEL_PATH="${MODEL_DIR}/${HF_FILE}"
if [ ! -x "$BIN_PATH" ]; then
  echo "[llamacpp] Missing llama-server at ${BIN_PATH}. Run the llama.cpp install step to repair the local runtime."
  exit 1
fi

if [ ! -f "$MODEL_PATH" ]; then
  if [ ! -x "$HF_BIN" ]; then
    echo "[llamacpp] Missing local model at ${MODEL_PATH} and Hugging Face CLI at ${HF_BIN}. Run the llama.cpp install step to provision Gemma 4 offline."
    exit 1
  fi
  echo "[llamacpp] Downloading ${HF_REPO}/${HF_FILE}"
  "$HF_BIN" download "$HF_REPO" "$HF_FILE" --local-dir "$MODEL_DIR"
fi

if [ ! -f "$MODEL_PATH" ]; then
  echo "[llamacpp] Download completed but model file was not found at ${MODEL_PATH}"
  exit 1
fi

echo "[llamacpp] Starting llama-server with ${MODEL_PATH}"
if [ -n "$PID_PATH" ]; then
  mkdir -p "$(dirname "$PID_PATH")"
  printf '%s\n' "$$" > "$PID_PATH"
fi
N_GPU_LAYERS="${LLAMACPP_N_GPU_LAYERS:-99}"
if ! [[ "$N_GPU_LAYERS" =~ ^[0-9]+$ ]] || [ "$N_GPU_LAYERS" -gt 999 ]; then
  echo "[llamacpp] Invalid LLAMACPP_N_GPU_LAYERS='${LLAMACPP_N_GPU_LAYERS-}'; falling back to 99"
  N_GPU_LAYERS=99
fi

# Whether Gemma thinks before answering. llama-server accepts exactly three
# values — on | off | auto — where auto reads the model's own template, which
# for Gemma 4 means ON.
#
# Measured on this hardware, same question, same answer: thinking on costs 1497
# reasoning characters and 19.6s; off costs 0 and 4.0s. Roughly 5x, on a model
# whose whole job is to be the fast local fallback. Every row of the model
# bake-off was measured with it off, and the rig's own notes call that the
# shipping config.
#
# It is not free: thinking ON is the only way this model gets weekday-arithmetic
# questions right. So the dial is here rather than hardcoded — flip it in .env
# and restart the service.
LLAMACPP_REASONING="${LLAMACPP_REASONING:-off}"
case "$LLAMACPP_REASONING" in
  on|off|auto) ;;
  *)
    echo "[llamacpp] Invalid LLAMACPP_REASONING='${LLAMACPP_REASONING}' (expected on|off|auto); using 'off'"
    LLAMACPP_REASONING=off
    ;;
esac
echo "[llamacpp] reasoning=${LLAMACPP_REASONING}"
exec "$BIN_PATH" \
  --host "$HOST" \
  --port "$PORT" \
  --alias "$MODEL_ALIAS" \
  --model "$MODEL_PATH" \
  --no-mmproj \
  --cache-type-k "$CACHE_TYPE_K" \
  --cache-type-v "$CACHE_TYPE_V" \
  --ctx-size "$CTX_SIZE" \
  --n-gpu-layers "$N_GPU_LAYERS" \
  --reasoning "$LLAMACPP_REASONING" \
  --jinja
