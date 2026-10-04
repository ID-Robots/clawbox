#!/usr/bin/env bash
# One vitest shard, with ONE automatic rerun when it fails — told, not hidden.
#
#   bash scripts/vitest-shard.sh <index>/<count>
#
# Runs `bun run test:coverage:shard --shard=<index>/<count>` (pr-tests-coverage.yml,
# the `shard` job). A shard that fails is run once more from scratch, and only
# once. The rerun is what people were doing by hand — dozens of "Re-run failed
# jobs" clicks a week over a handful of timing-sensitive tests — and doing it
# here keeps the rest of the run (the merge, the verdict) waiting on one job
# instead of on a person.
#
# What it must never do is make a flake invisible. A shard that only passed on
# its second attempt:
#   - prints a ::warning:: annotation naming the shard and the tests that
#     failed the first time, which GitHub shows on the run and on the PR, and
#   - adds a "Flaky vitest shard" section to the job summary listing them,
# so the test is fixed rather than retried for ever. A shard that fails twice
# fails the job, with the second attempt's report as the one that is merged.
#
# The rerun starts from an empty .vitest-reports/ and coverage/ so the blob the
# merge reads is the second attempt's alone (check-vitest-shards.sh refuses any
# file that is not one shard's blob).
#
# VITEST_SHARD_CMD overrides the command, for src/tests/unit/ci-shards.test.ts.
set -uo pipefail

shard="${1:-}"
if [[ ! $shard =~ ^[0-9]+/[0-9]+$ ]]; then
  echo "usage: $0 <index>/<count>" >&2
  exit 2
fi

summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
cmd="${VITEST_SHARD_CMD:-bun run test:coverage:shard}"
first_log=$(mktemp)
trap 'rm -f "$first_log"' EXIT

# shellcheck disable=SC2086 # the command is a word list on purpose
$cmd --shard="$shard" 2>&1 | tee "$first_log"
rc=${PIPESTATUS[0]}
if [ "$rc" -eq 0 ]; then
  exit 0
fi

# The test files vitest marked FAIL, as plain text (its output is coloured).
failed=$(sed -E 's/\x1b\[[0-9;]*m//g' "$first_log" \
  | grep -E '^[[:space:]]*FAIL[[:space:]]' \
  | sed -E 's/^[[:space:]]*FAIL[[:space:]]+//; s/[[:space:]]+$//' \
  | sort -u)
[ -n "$failed" ] || failed="(no FAIL line in the output — the shard exited $rc before or after its tests; see the first attempt's log)"

echo "::group::vitest shard $shard failed (exit $rc) — running it once more"
echo "$failed"
echo "::endgroup::"
rm -rf .vitest-reports coverage

# shellcheck disable=SC2086
$cmd --shard="$shard"
rc2=$?

# One annotation line: GitHub shows only the first line of a message in the
# annotation list, so the tests are joined rather than listed.
one_line=$(printf '%s' "$failed" | tr '\n' ';' | sed 's/;/; /g')
if [ "$rc2" -eq 0 ]; then
  echo "::warning title=Flaky vitest shard $shard::shard $shard failed on its first attempt and passed on the automatic rerun. Failed first: $one_line"
  {
    echo "### Flaky vitest shard $shard — passed only on the automatic rerun"
    echo
    echo "First attempt exited $rc. These failed, then passed:"
    echo
    printf '%s\n' "$failed" | sed 's/^/- `/; s/$/`/'
  } >> "$summary"
  exit 0
fi

echo "::error title=vitest shard $shard failed twice::shard $shard failed on its first attempt and on the automatic rerun (exit $rc2). Failed first: $one_line"
{
  echo "### vitest shard $shard failed twice (first attempt and the automatic rerun)"
  echo
  echo "Failed on the first attempt:"
  echo
  printf '%s\n' "$failed" | sed 's/^/- `/; s/$/`/'
} >> "$summary"
exit "$rc2"
