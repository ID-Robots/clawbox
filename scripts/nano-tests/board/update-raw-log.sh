#!/usr/bin/env bash
# Runs ON the board, as clawbox, for scripts/nano-tests/tests/92-update-raw-log.sh:
# the raw update log (TASK-2428) checked against the box's own journal and
# log file, in a headless Chromium of its own (./update-raw-log.mjs).
#
#   update-raw-log.sh reader-start RUN_ID     a background reader of the log stream
#   update-raw-log.sh live RUN_ID LABEL       mid-update checks and the panel
#   update-raw-log.sh after RUN_ID LABEL      the checks once the update is over
#
# RUN_ID names this run's folder in /tmp, where the reader keeps what it read
# and the screenshots are kept. SHOTS=1 prints the screenshots as SHOT lines.
# The owner's cookie is minted by the driver from data/.session-secret and
# reaches the browser through DevTools only: never printed, never on a
# command line.
set -uo pipefail

MODE=${1:-}
RUN=${2:-local}
LABEL=${3:-$MODE}
REPO=/home/clawbox/clawbox
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[[ $RUN =~ ^[A-Za-z0-9._-]+$ ]] || { echo "RESULT not ok - bad run id"; exit 0; }
STATE=/tmp/nano-update-raw-log-$RUN
mkdir -p "$STATE"

if [ ! -r "$REPO/data/.session-secret" ]; then
  echo "RESULT not ok - $REPO/data/.session-secret is not readable as the box account"
  exit 0
fi

# The Chromium the box itself would use (scripts/launch-browser.sh): the
# Playwright build first, then a system one that is not the snap wrapper.
CHROME=$(find "$HOME/.cache/ms-playwright" -type f \( -path "*/chrome-linux/chrome" -o -path "*/chrome-linux64/chrome" -o -path "*/chrome-linux-arm64/chrome" \) 2>/dev/null | sort -V | tail -1)
if [ -z "$CHROME" ]; then
  for bin in chromium-browser google-chrome-stable google-chrome chromium; do
    p=$(command -v "$bin" 2>/dev/null) || continue
    grep -qE '(/snap/bin/chromium|snap run chromium)' "$p" 2>/dev/null && continue
    CHROME=$p
    break
  done
fi

PROFILE=$(mktemp -d "/tmp/nano-update-raw-log-profile-XXXXXX")
trap 'rm -rf "$PROFILE"' EXIT
REPO=$REPO STATE_DIR=$STATE CHROME=$CHROME PROFILE_DIR=$PROFILE LABEL=$LABEL SHOTS=${SHOTS:-0} \
  timeout "${DRIVER_TIMEOUT_S:-600}" node "$HERE/update-raw-log.mjs" "$MODE" 2>&1 \
  | grep -E '^(RESULT|NOTE|SHOT) '
