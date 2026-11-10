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
# q8_0, not q4_0: keep in step with DEFAULT_LLAMACPP_CACHE_TYPE in src/lib/llamacpp.ts.
CACHE_TYPE_K="${LLAMACPP_CACHE_TYPE_K:-q8_0}"
CACHE_TYPE_V="${LLAMACPP_CACHE_TYPE_V:-q8_0}"
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
    echo "[llamacpp] Missing local model at ${MODEL_PATH} and Hugging Face CLI at ${HF_BIN}. Run the llama.cpp install step to provision the local model."
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

# Speculative decoding, off unless .env asks. A model with its own
# multi-token-prediction head (the -MTP GGUFs) drafts for itself with
# `draft-mtp`; an EAGLE-3 or plain draft model is a second GGUF in the same
# model directory, named by LLAMACPP_SPEC_DRAFT_FILE. Measured on a DGX Spark:
# Qwen3.6-35B-A3B from 66.9 to 94.4 tok/s with draft-mtp and a draft length of
# 2. Anything llama-server would refuse starts the model WITHOUT speculation,
# never not at all: a typo in .env must not cost the box its local model.
SPEC_ARGS=()
LLAMACPP_SPEC_TYPE="${LLAMACPP_SPEC_TYPE:-none}"
case "$LLAMACPP_SPEC_TYPE" in
  none|"") ;;
  draft-mtp)
    SPEC_ARGS=(--spec-type draft-mtp)
    ;;
  draft-eagle3|draft-simple)
    SPEC_DRAFT_FILE="${LLAMACPP_SPEC_DRAFT_FILE:-}"
    # One path segment, so the draft can only come from the model directory.
    if [ -n "$SPEC_DRAFT_FILE" ] && [ "$SPEC_DRAFT_FILE" = "${SPEC_DRAFT_FILE##*/}" ] \
      && [ "$SPEC_DRAFT_FILE" != "." ] && [ "$SPEC_DRAFT_FILE" != ".." ] \
      && [ -f "${MODEL_DIR}/${SPEC_DRAFT_FILE}" ]; then
      SPEC_ARGS=(--spec-type "$LLAMACPP_SPEC_TYPE" --spec-draft-model "${MODEL_DIR}/${SPEC_DRAFT_FILE}")
    else
      echo "[llamacpp] LLAMACPP_SPEC_TYPE=${LLAMACPP_SPEC_TYPE} needs LLAMACPP_SPEC_DRAFT_FILE, a GGUF in ${MODEL_DIR}; starting without speculative decoding"
    fi
    ;;
  *)
    echo "[llamacpp] Invalid LLAMACPP_SPEC_TYPE='${LLAMACPP_SPEC_TYPE}' (expected none|draft-mtp|draft-eagle3|draft-simple); starting without speculative decoding"
    ;;
esac
# The binary must know what .env asks for: an older llama-server (install.sh's
# pinned Jetson build, a reused checkout) exits on an argument it does not
# know. Asked of the binary on every start, never remembered.
if [ "${#SPEC_ARGS[@]}" -gt 0 ]; then
  SPEC_HELP="$("$BIN_PATH" --help 2>&1 || true)"
  if ! grep -q -- "--spec-type .*${LLAMACPP_SPEC_TYPE}" <<<"$SPEC_HELP" \
    || { [ "${SPEC_ARGS[2]:-}" = "--spec-draft-model" ] && ! grep -q -- "--spec-draft-model" <<<"$SPEC_HELP"; }; then
    echo "[llamacpp] ${BIN_PATH} does not support --spec-type ${LLAMACPP_SPEC_TYPE}; starting without speculative decoding"
    SPEC_ARGS=()
  fi
fi
if [ "${#SPEC_ARGS[@]}" -gt 0 ] && [ -n "${LLAMACPP_SPEC_DRAFT_N_MAX:-}" ]; then
  if ! grep -q -- "--spec-draft-n-max" <<<"$SPEC_HELP"; then
    echo "[llamacpp] ${BIN_PATH} does not support --spec-draft-n-max; using its default draft length"
  elif [[ "$LLAMACPP_SPEC_DRAFT_N_MAX" =~ ^[0-9]+$ ]] && [ "$LLAMACPP_SPEC_DRAFT_N_MAX" -ge 1 ] && [ "$LLAMACPP_SPEC_DRAFT_N_MAX" -le 16 ]; then
    SPEC_ARGS+=(--spec-draft-n-max "$LLAMACPP_SPEC_DRAFT_N_MAX")
  else
    echo "[llamacpp] Invalid LLAMACPP_SPEC_DRAFT_N_MAX='${LLAMACPP_SPEC_DRAFT_N_MAX}' (expected 1-16); using llama-server's default"
  fi
fi
if [ "${#SPEC_ARGS[@]}" -gt 0 ]; then
  echo "[llamacpp] speculative decoding: ${SPEC_ARGS[*]}"
fi

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
  --jinja \
  "${SPEC_ARGS[@]}"
