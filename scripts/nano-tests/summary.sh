#!/usr/bin/env bash
# Print the Markdown job summary of a nano-lab run (TASK-1324): the board, the
# commit, and one row per test with its result, duration and reason.
#
# Usage:
#   scripts/nano-tests/summary.sh [results/summary.json] >> "$GITHUB_STEP_SUMMARY"
#
# The board and commit come from the environment — NANO_SERIAL, NANO_IP,
# NANO_LAB, NANO_SHA — so a job whose suite never ran (no free board, a failed
# rebuild, the wrong commit on the board) still says which board and commit it
# was about. NANO_OUTCOME, when set, is printed as the job's own verdict line
# for that case. Always exits 0: a summary must never be what fails a job.
set -uo pipefail

SUMMARY=${1:-${NANO_RESULTS_DIR:-results}/summary.json}

# Table cells: one line, no pipe that would split the row, no HTML.
cell() { printf '%s' "$1" | tr '\r\n' '  ' | sed -e 's/|/\\|/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' | cut -c1-300; }

echo "## Nano hardware tests"
echo
echo "| Board | IP | Lab | Commit |"
echo "|---|---|---|---|"
echo "| \`$(cell "${NANO_SERIAL:-none}")\` | $(cell "${NANO_IP:--}") | $(cell "${NANO_LAB:--}") | \`$(cell "${NANO_SHA:-unknown}")\` |"
echo

if [ ! -s "$SUMMARY" ] || ! jq -e 'type == "object"' "$SUMMARY" >/dev/null 2>&1; then
  echo "**The on-device suite did not run.** ${NANO_OUTCOME:+$(cell "$NANO_OUTCOME")}"
  exit 0
fi

jq -r '
  def cell: tostring | gsub("[\r\n]"; " ") | gsub("\\|"; "\\|") | gsub("<"; "&lt;") | gsub(">"; "&gt;") | .[0:300];
  def mark: if . == "pass" then "✅ pass" elif . == "skip" then "⏭️ skip" else "❌ fail" end;
  "**\(.passed) passed, \(.failed) failed, \(.skipped) skipped** of \(.planned)"
    + (if .interrupted then " — **interrupted** after \(.total)" else "" end)
    + " · \(.started_at) → \(.finished_at)",
  "",
  "| # | Test | Result | Duration | Reason |",
  "|---|---|---|---|---|",
  (.tests | to_entries[] |
    "| \(.key + 1) | `\(.value.name | cell)` | \(.value.status | mark) | \(.value.duration_s)s / \(.value.timeout_s)s | \(.value.reason | cell) |")
' "$SUMMARY" 2>/dev/null || echo "_summary.json could not be read._"
[ -z "${NANO_OUTCOME:-}" ] || { echo; cell "$NANO_OUTCOME"; echo; }
exit 0
