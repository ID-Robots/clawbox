#!/usr/bin/env bash
# Does a pull request need a nano-lab board (TASK-1362)? Reads the paths the PR
# changes, one per line, and answers in the two lines the workflow appends to
# $GITHUB_OUTPUT:
#
#   hardware=true|false
#   reason=<one line, for the job summary and the PR comment>
#
# Usage:
#   scripts/nano-tests/needs-board.sh [--partial] < changed-paths.txt
#
# A PR needs no board when EVERY path is documentation — the job-level
# equivalent of `paths-ignore: [docs/**, docs-site/**, '**/*.md']`:
#
#   docs/**  docs-site/**  **/*.md  (any depth, the repository root included)
#
# with one exception: `config/**` is never documentation. gateway-pre-start.sh
# seeds config/clawbox-bootstrap.md and config/clawbox-workspace-guide.md into
# the agent's workspace on the box, so a change there changes what the chat
# and coding tests run against.
#
# Every doubt answers `true`, because a skipped board run is the costly
# mistake: an empty list (nothing to judge by) and --partial (the caller could
# not list every changed file) both need a board. Matching is case-sensitive,
# like GitHub's path filters: README.MD is not documentation.
set -euo pipefail

partial=false
case "${1:-}" in
  "") ;;
  --partial) partial=true ;;
  *)
    echo "usage: $0 [--partial] < changed-paths.txt" >&2
    exit 2
    ;;
esac

is_doc() {
  case "$1" in
    config/*) return 1 ;;
    docs/* | docs-site/* | *.md) return 0 ;;
    *) return 1 ;;
  esac
}

total=0
code=0
first=""
while IFS= read -r path || [ -n "$path" ]; do
  path=${path%$'\r'}
  [ -n "$path" ] || continue
  total=$((total + 1))
  if ! is_doc "$path"; then
    code=$((code + 1))
    [ -n "$first" ] || first=$path
  fi
done

if [ "$code" -gt 0 ]; then
  if [ "$code" -eq 1 ]; then
    others="it is the only one of $total changed files that is not documentation"
  else
    others="$code of $total changed files are not documentation"
  fi
  echo "hardware=true"
  echo "reason=$first is not documentation ($others)"
elif [ "$partial" = true ]; then
  echo "hardware=true"
  echo "reason=the list of changed files is incomplete, so it cannot show the PR is documentation only"
elif [ "$total" -eq 0 ]; then
  echo "hardware=true"
  echo "reason=no changed files were listed, so nothing shows the PR is documentation only"
else
  echo "hardware=false"
  echo "reason=only documentation changed ($total files under docs/, docs-site/ or *.md)"
fi
