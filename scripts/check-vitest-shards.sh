#!/usr/bin/env bash
# Every shard of the vitest run reported, or there is nothing to merge.
#
#   bash scripts/check-vitest-shards.sh [directory]   (default .vitest-reports)
#
# `vitest --merge-reports` merges whatever blob files it finds in the directory.
# A shard that never uploaded one — its runner died, its `bun install` failed,
# it was cancelled — is simply not there, and the merge then prints a green
# suite and coverage numbers over the files that DID run: a false success, and
# a coverage figure that is not the project's. pr-tests-coverage.yml runs this
# ahead of the merge so that case is a red "did not run" instead.
#
# The set is self-describing: the blob reporter names its file
# blob-<index>-<count>.json, so nothing else has to know how many shards the
# matrix had. Anything short of indices 1..count under one count is refused,
# and so is any other file, because the merge would read that too.
set -euo pipefail

dir="${1:-.vitest-reports}"
if [ ! -d "$dir" ]; then
  echo "::error::no vitest shard reported: $dir does not exist" >&2
  exit 1
fi

count=""
declare -A seen=()
shopt -s nullglob dotglob
entries=("$dir"/*)
if [ ${#entries[@]} -eq 0 ]; then
  echo "::error::no vitest shard reported: $dir is empty" >&2
  exit 1
fi

for path in "${entries[@]}"; do
  name=$(basename "$path")
  if [ ! -f "$path" ] || [[ ! $name =~ ^blob-([0-9]+)-([0-9]+)\.json$ ]]; then
    echo "::error::$dir/$name is not a shard's blob report (blob-<index>-<count>.json); the merge would read it as one" >&2
    exit 1
  fi
  index=$((10#${BASH_REMATCH[1]}))
  total=$((10#${BASH_REMATCH[2]}))
  if [ -z "$count" ]; then
    count=$total
  elif [ "$total" -ne "$count" ]; then
    echo "::error::blob reports from runs of $count and of $total shards are mixed in $dir" >&2
    exit 1
  fi
  if [ "$index" -lt 1 ] || [ "$index" -gt "$count" ]; then
    echo "::error::$name names shard $index of $count" >&2
    exit 1
  fi
  seen[$index]=1
done

missing=()
for ((i = 1; i <= count; i++)); do
  [ -n "${seen[$i]:-}" ] || missing+=("$i/$count")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::vitest shard ${missing[*]} did not report — the suite is incomplete, so it is not merged" >&2
  exit 1
fi
echo "all $count vitest shards reported"
