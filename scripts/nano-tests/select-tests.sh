#!/usr/bin/env bash
# Which on-device tests does a pull request need? Change-based selection: reads
# the paths the PR changes, one per line (the list needs-board.sh reads), and
# answers in the two lines the workflow appends to $GITHUB_OUTPUT:
#
#   tests=all                          every test
#   tests=<name> <name> …              only these (NN order)
#   reason=<one line, for the log and the job summary>
#
# Usage:
#   scripts/nano-tests/select-tests.sh [--partial] [--tests-dir DIR] < changed-paths.txt
#
# The map lives in the tests themselves, in their first 20 lines:
#
#   # covers: GLOB GLOB …     the source areas the test exercises: shell `case`
#                             patterns over repository paths (`*` crosses `/`);
#                             as many such lines as it needs
#   # select: always          the core smoke set every selection includes —
#                             build identity, the services, a chat turn
#
# A changed path selects every test whose covers match it, and a test's own
# file selects that test. Paths that never reach a board select nothing:
# documentation (needs-board.sh's rule, config/ excepted), the unit and
# container suites (src/tests/, e2e/, e2e-install/) and the CI files other than
# the board workflow.
#
# Every doubt runs EVERY test, because the full suite is the safe answer:
#   - a path that no test covers and that is not one of those (the map is
#     unsure about it) — install.sh, package.json, most of src/lib/;
#   - the runner and what it stands on: scripts/nano-tests/*.sh, the board
#     workflow, scripts/public-hygiene.mjs (which redacts the board's logs);
#   - --partial (the caller could not list every changed file), or no path.
# The workflow runs the full suite anyway on pushes to beta and main, on a
# dispatch, and on a pull request labelled nano-full (or nano-long).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TESTS_DIR=$HERE/tests
partial=false
while [ $# -gt 0 ]; do
  case "$1" in
    --partial) partial=true; shift ;;
    --tests-dir)
      [ -n "${2:-}" ] || { echo "usage: $0 [--partial] [--tests-dir DIR] < changed-paths.txt" >&2; exit 2; }
      TESTS_DIR=$2; shift 2 ;;
    *)
      echo "usage: $0 [--partial] [--tests-dir DIR] < changed-paths.txt" >&2
      exit 2
      ;;
  esac
done

# Changes nothing a board runs.
board_neutral() {
  case "$1" in
    config/*) return 1 ;;
    docs/* | docs-site/* | *.md) return 0 ;;
    src/tests/* | e2e/* | e2e-install/*) return 0 ;;
    .github/workflows/nano-hardware-tests.yml) return 1 ;;
    .github/*) return 0 ;;
    playwright.config.ts | vitest.config.ts | eslint.config.mjs) return 0 ;;
    scripts/hooks/* | scripts/vitest-shard.sh | scripts/check-vitest-shards.sh | scripts/check-lockfiles.mjs | scripts/check-doc-images.sh) return 0 ;;
    *) return 1 ;;
  esac
}

# The suite itself, and what every one of its runs stands on.
runner_path() {
  case "$1" in
    scripts/nano-tests/tests/*) return 1 ;;
    scripts/nano-tests/* | .github/workflows/nano-hardware-tests.yml | scripts/public-hygiene.mjs) return 0 ;;
    *) return 1 ;;
  esac
}

# The map, read from every test's header.
NAMES=()
COVERS=()
ALWAYS=()
for file in "$TESTS_DIR"/[0-9][0-9]-*.sh; do
  [ -f "$file" ] || continue
  name=$(basename "$file" .sh)
  head=$(head -n 20 "$file")
  NAMES+=("$name")
  COVERS+=("$(sed -n -E 's/^#[[:space:]]*covers:[[:space:]]*(.*[^[:space:]])[[:space:]]*$/\1/p' <<<"$head" | tr '\n' ' ')")
  if grep -qE '^#[[:space:]]*select:[[:space:]]*always[[:space:]]*$' <<<"$head"; then ALWAYS+=("$name"); fi
done

declare -A PICKED=()
total=0
full=""
mapped=0
while IFS= read -r path || [ -n "$path" ]; do
  path=${path%$'\r'}
  [ -n "$path" ] || continue
  total=$((total + 1))
  board_neutral "$path" && continue
  if runner_path "$path"; then
    [ -n "$full" ] || full="$path is part of the on-device runner"
    continue
  fi
  hit=false
  case "$path" in
    scripts/nano-tests/tests/[0-9][0-9]-*.sh)
      # A test that was changed runs; one that was removed has nothing to run.
      name=$(basename "$path" .sh)
      if [ -f "$TESTS_DIR/$name.sh" ]; then PICKED[$name]=1; fi
      hit=true
      ;;
  esac
  for i in "${!NAMES[@]}"; do
    # `read`, not a bare expansion: the patterns must not be expanded against
    # the files in the current folder.
    read -r -a patterns <<<"${COVERS[i]}"
    for pattern in "${patterns[@]}"; do
      # shellcheck disable=SC2254  # the pattern is a glob on purpose
      case "$path" in
        $pattern) PICKED[${NAMES[i]}]=1; hit=true; break ;;
      esac
    done
  done
  if [ "$hit" = true ]; then
    mapped=$((mapped + 1))
  elif [ -z "$full" ]; then
    full="$path is covered by no test's map"
  fi
done

if [ "$partial" = true ]; then
  full="the list of changed files is incomplete"
elif [ "$total" -eq 0 ]; then
  full="no changed files were listed"
fi
if [ -n "$full" ]; then
  echo "tests=all"
  echo "reason=every test: $full"
  exit 0
fi

for name in "${ALWAYS[@]}"; do PICKED[$name]=1; done
selected=()
affected=()
for name in "${NAMES[@]}"; do
  [ -n "${PICKED[$name]:-}" ] || continue
  selected+=("$name")
  case " ${ALWAYS[*]} " in *" $name "*) ;; *) affected+=("$name") ;; esac
done
echo "tests=${selected[*]}"
if [ ${#affected[@]} -eq 0 ]; then
  echo "reason=the core smoke set only: none of the $total changed files reaches a test beyond it"
else
  echo "reason=the core smoke set and ${affected[*]}, from $mapped of $total changed files (the rest reach no board)"
fi
