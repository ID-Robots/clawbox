#!/usr/bin/env bash
# timeout: 420
#
# The on-device model answers, when the board has ollama:
#
#   ollama run <model> "Say OK"   answers within 180 s
#
# ClawBox ships no ollama model — the one model it installs is Gemma on its own
# llama.cpp (src/lib/llamacpp.ts). What it SHIPS for ollama is the pair the
# setup wizard offers, OLLAMA_PRESET_MODELS in src/lib/local-install.ts, read
# from the checkout here so this test follows the constant instead of copying
# it. The first of those the board has pulled is used; NANO_OLLAMA_MODEL
# overrides. SKIP when ollama is not installed or none of them is pulled —
# pulling gigabytes is not a test.
#
# ollama.service is a system unit the box stops after ten idle minutes
# (src/lib/local-ai-runtime.ts); a stopped one is started through the same
# sudoers grant the box uses, and stopped again afterwards.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

PRESETS_FILE=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/src/lib/local-install.ts
if [ -n "${NANO_OLLAMA_MODEL:-}" ]; then
  CANDIDATES=$NANO_OLLAMA_MODEL
else
  CANDIDATES=$(sed -n '/OLLAMA_PRESET_MODELS/,/\] as const/p' "$PRESETS_FILE" 2>/dev/null \
    | grep -o 'id: "[^"]*"' | sed 's/^id: "//; s/"$//' | tr '\n' ' ')
fi
read -r -a MODELS <<<"$CANDIDATES"
if [ ${#MODELS[@]} -eq 0 ]; then
  not_ok "cannot read OLLAMA_PRESET_MODELS from src/lib/local-install.ts — update this test with the constant"
  finish
fi
note "shipped ollama models: ${MODELS[*]}"

# One line back: "<absent|model|none> <started: yes|no> <model|-> <pulled models…>".
# shellcheck disable=SC2016  # expanded on the board
PREP=$(board '
  command -v ollama >/dev/null 2>&1 || { echo "absent no -"; exit 0; }
  started=no
  if [ "$(systemctl is-active ollama.service 2>/dev/null)" != active ]; then
    sudo -n /usr/bin/systemctl start ollama.service >&2 && started=yes
  fi
  for _ in $(seq 1 30); do ollama list >/dev/null 2>&1 && break; sleep 2; done
  pulled=$(ollama list 2>/dev/null | awk "NR > 1 { print \$1 }")
  for model in "$@"; do
    if printf "%s\n" "$pulled" | grep -qxF -e "$model" -e "$model:latest"; then
      echo "model $started $model"; exit 0
    fi
  done
  echo "none $started - $(printf "%s" "$pulled" | tr "\n" " ")"
' "${MODELS[@]}")
read -r KIND STARTED MODEL PULLED <<<"$PREP"

stop_if_started() {
  [ "$STARTED" = yes ] || return 0
  board 'sudo -n /usr/bin/systemctl stop ollama.service' >/dev/null 2>&1
  note "stopped ollama.service again (this test started it)"
}

case "$KIND" in
  absent)
    skip "ollama is not installed on this board"
    finish
    ;;
  none)
    stop_if_started
    skip "none of the shipped ollama models (${MODELS[*]}) is pulled on this board (it has: ${PULLED:-nothing})"
    finish
    ;;
  model) ;;
  *)
    not_ok "could not ask the board about ollama (answer: '${PREP:-nothing}')"
    finish
    ;;
esac

START=$(date +%s)
# The spinner and any error go to a file on the board; only the last lines of
# it come back, stripped of terminal escapes, and only on a failure.
# shellcheck disable=SC2016  # expanded on the board
ANSWER=$(board '
  err=$(mktemp)
  timeout 180 ollama run "$1" "Say OK" 2>"$err"
  rc=$?
  [ "$rc" -eq 0 ] || tail -n 5 "$err" | sed "s/\x1b\[[0-9;?]*[A-Za-z]//g" >&2
  rm -f "$err"
  exit "$rc"
' "$MODEL")
rc=$?
TOOK=$(( $(date +%s) - START ))
note "ollama run $MODEL answered in ${TOOK}s: $(printf '%s' "$ANSWER" | tr '\n' ' ' | head -c 200)"
if [ "$rc" -eq 124 ]; then
  not_ok "ollama run $MODEL gave no answer within 180 s"
elif [ "$rc" -ne 0 ]; then
  not_ok "ollama run $MODEL failed (exit $rc)"
elif printf '%s' "$ANSWER" | grep -qiwE 'ok(ay)?'; then
  ok "ollama run $MODEL answered OK in ${TOOK}s"
else
  not_ok "ollama run $MODEL answered without an OK: $(printf '%s' "$ANSWER" | tr '\n' ' ' | head -c 200)"
fi

stop_if_started
finish
