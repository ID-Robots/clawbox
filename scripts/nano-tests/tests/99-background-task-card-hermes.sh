#!/usr/bin/env bash
# timeout: 900
# covers: src/lib/background-task*.ts src/lib/root-step-follow.ts src/lib/embed-model-download.ts src/app/setup-api/embed/install/* src/app/setup-api/background-jobs/tasks/*
# covers: src/components/BackgroundTask*.tsx src/components/local-ai/* src/components/LocalAiPanel.tsx scripts/nano-tests/board/background-task-card.*
# covers: src/app/setup-api/harness/select/* src/app/setup-api/harness/swap/*
#
# 66-background-task-card again, under the HERMES agent runtime: the agent
# runtime is first switched to Hermes the way Settings switches it, then the
# memory-search model is downloaded from Settings → Local AI, Settings is
# closed, and the desktop's corner card is followed to the end.
#
#   * An unlocked dual box switches with the Harness tiles' own route
#     (POST /setup-api/harness/select) and is switched back afterwards.
#   * A locked OpenClaw box switches with the harness swap (Settings →
#     Harness → Switch to Hermes: a reinstall of minutes, which the ClawBox AI
#     plan must include). That is not undone here, which is why this test runs
#     LAST: nothing after it needs the board on OpenClaw, and the board is
#     recycled after the run. Skips, saying why, where the plan does not allow
#     the swap or the edition cannot switch.
#
# The budget is shared: up to 7 minutes for the swap, the rest for the
# download. A swap that takes longer is reported as such.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# shellcheck disable=SC2016  # expanded on the board, not here
FLOW='SWAP_MAX_TIME_S=420 DEADLINE_S=300 DRIVER_TIMEOUT_S=380 bash "$REPO/scripts/nano-tests/board/background-task-card.sh" --switch-to hermes'

out=$(board "$FLOW")
results=$(printf '%s\n' "$out" | grep -E '^(RESULT|NOTE) ')
if [ -z "$results" ]; then
  not_ok "the background-task card check printed nothing on the board"
  printf '%s\n' "$out" | tail -n 20 | while IFS= read -r line; do note "$line"; done
else
  while IFS= read -r line; do
    case "$line" in
      "RESULT ok - "*) ok "${line#RESULT ok - }" ;;
      "RESULT skip - "*) skip "${line#RESULT skip - }" ;;
      "RESULT not ok - "*) not_ok "${line#RESULT not ok - }" ;;
      "NOTE "*) note "${line#NOTE }" ;;
      *) note "$line" ;;
    esac
  done <<<"$results"
fi
finish
