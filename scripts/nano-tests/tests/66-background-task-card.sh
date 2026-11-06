#!/usr/bin/env bash
# timeout: 900
# covers: src/lib/background-task*.ts src/lib/root-step-follow.ts src/lib/embed-model-download.ts src/app/setup-api/embed/install/* src/app/setup-api/background-jobs/tasks/*
# covers: src/components/BackgroundTask*.tsx src/components/local-ai/* src/components/LocalAiPanel.tsx scripts/nano-tests/board/background-task-card.*
#
# A long process started from Settings keeps running once Settings is closed,
# and the desktop's corner card shows its progress to the end — on the real
# board, through its real desktop, under the agent runtime the board runs
# (src/lib/background-tasks.ts; 99-background-task-card-hermes runs the same
# under Hermes):
#
#   1. In a headless Chromium of the test's own, signed in as the owner, the
#      memory-search model (about 640 MB) is downloaded from Settings → Local
#      AI the way the owner does it: the row's Install, or the card's
#      "Download again" when the model is already on the board. Settings
#      draws it inline (steps, percentage, log). Local AI offers the model
#      only where memory search embeds on the box, so a board whose ClawBox AI
#      plan has it in the cloud is moved onto the box first (Memory Shard's
#      "On this box").
#   2. The Settings window is closed. The download must keep running, the
#      desktop's corner card must draw it with a rising percentage, and both
#      the card and the box's own record must end `succeeded`.
#   3. The board is left as it was found: a model that was not there is
#      removed again; one that was there was replaced by a fresh copy; memory
#      search moved off the cloud goes back to it.
#
# The flow runs on the board from its own checkout of the commit under test
# (scripts/nano-tests/board/background-task-card.sh, which drives
# background-task-card.mjs). The owner's cookie is minted ON the board from
# data/.session-secret and reaches the browser through DevTools only. Skips
# where the board has no Chromium, or no Hugging Face CLI (the llama.cpp
# install brings it) to download with.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# shellcheck disable=SC2016  # expanded on the board, not here
FLOW='DEADLINE_S=480 DRIVER_TIMEOUT_S=640 bash "$REPO/scripts/nano-tests/board/background-task-card.sh"'

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
