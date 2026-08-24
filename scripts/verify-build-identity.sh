#!/usr/bin/env bash
# Assert that the build sitting on disk was produced from the commit that is
# checked out — i.e. that the assets the device serves are reproducible from
# its own source tree.
#
# One script, two callers, deliberately:
#   * CI (.github/workflows/build-identity.yml) runs it after `bun run build`,
#     so a PR whose build cannot be traced back to its own SHA goes red.
#   * The in-app updater runs it as the last step of an update, so a device
#     that rebooted onto a build that is NOT the code it just synced says so
#     loudly instead of serving 404s for features whose source is on disk.
# A second copy of this logic would eventually disagree with the first, and the
# whole point of the check is that both sides answer the same question.
#
# Usage:
#   scripts/verify-build-identity.sh [--project-dir DIR] [--expect-sha SHA] [--quiet]
#
# Exit codes: 0 = build matches, 1 = drift or unverifiable.
set -uo pipefail

PROJECT_DIR=""
EXPECT_SHA=""
QUIET=0

# `shift 2` on a single remaining argument FAILS and shifts nothing. With no
# `set -e` that turns a trailing `--project-dir` into an infinite loop: the
# script hangs instead of reporting a usage error, and it hangs inside an
# update step. Require the value first.
need_value() {
  [ -n "${2:-}" ] || { echo "verify-build-identity: $1 needs a value" >&2; exit 2; }
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project-dir) need_value "$1" "${2:-}"; PROJECT_DIR="$2"; shift 2 ;;
    --expect-sha)  need_value "$1" "${2:-}"; EXPECT_SHA="$2"; shift 2 ;;
    --quiet)       QUIET=1; shift ;;
    -h|--help)     sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "verify-build-identity: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

if [ -z "$PROJECT_DIR" ]; then
  PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

say() { [ "$QUIET" -eq 1 ] || echo "$@"; }
fail() { echo "BUILD IDENTITY: FAIL — $*" >&2; exit 1; }

[ -d "$PROJECT_DIR" ] || fail "project directory not found: $PROJECT_DIR"

if [ -z "$EXPECT_SHA" ]; then
  EXPECT_SHA="$(git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null)" \
    || fail "cannot read HEAD in $PROJECT_DIR (not a git checkout?)"
fi
[ -n "$EXPECT_SHA" ] || fail "no commit to verify against"

# Read one top-level string field out of build-info.json without assuming jq is
# installed — a Jetson has node (it runs the server) but not necessarily jq.
read_field() {
  node -e '
    const fs = require("fs");
    try {
      const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]];
      process.stdout.write(v === null || v === undefined ? "" : String(v));
    } catch { process.exit(1); }
  ' "$1" "$2" 2>/dev/null
}

# Both trees are checked when both exist: `.next/build-info.json` is what the
# build produced, `.next/standalone/.next/build-info.json` is what the service
# actually runs from (its cwd). A postbuild that half-copied is precisely the
# failure this is here to catch, so agreeing with only one of them is not enough.
CANDIDATES=(
  "$PROJECT_DIR/.next/build-info.json"
  "$PROJECT_DIR/.next/standalone/.next/build-info.json"
)

# A standalone tree that EXISTS but carries no stamp is the half-copied
# postbuild this script is meant to catch — skipping it because the file is
# absent would report OK while the tree the service actually runs from has no
# identity at all.
STANDALONE_NEXT="$PROJECT_DIR/.next/standalone/.next"
if [ -f "$STANDALONE_NEXT/BUILD_ID" ] && [ ! -f "$STANDALONE_NEXT/build-info.json" ]; then
  fail ".next/standalone/.next holds a deployed build but no build-info.json — the postbuild step did not copy the stamp"
fi

CHECKED=0
for INFO in "${CANDIDATES[@]}"; do
  [ -f "$INFO" ] || continue
  CHECKED=$((CHECKED + 1))
  REL="${INFO#"$PROJECT_DIR"/}"

  COMMIT="$(read_field "$INFO" commit)" || fail "$REL is not readable JSON"
  [ -n "$COMMIT" ] || fail "$REL records no commit — the build could not identify its own source"
  [ "$COMMIT" = "$EXPECT_SHA" ] \
    || fail "$REL was built from $COMMIT but the checkout is at $EXPECT_SHA"

  # The stamp is only evidence about the assets NEXT TO IT. If BUILD_ID moved on
  # without the stamp being rewritten, something replaced the build behind our
  # back and the matching commit above means nothing.
  BUILD_ID_FILE="$(dirname "$INFO")/BUILD_ID"
  if [ -f "$BUILD_ID_FILE" ]; then
    RECORDED="$(read_field "$INFO" buildId)"
    ON_DISK="$(head -1 "$BUILD_ID_FILE" | tr -d '[:space:]')"
    if [ -n "$RECORDED" ] && [ -n "$ON_DISK" ] && [ "$RECORDED" != "$ON_DISK" ]; then
      fail "$REL describes build $RECORDED but $ON_DISK is deployed next to it"
    fi
  fi

  DIRTY="$(read_field "$INFO" dirty)"
  say "  ok: $REL — commit ${COMMIT:0:7}${DIRTY:+ dirty=$DIRTY}"
done

[ "$CHECKED" -gt 0 ] \
  || fail "no build-info.json under $PROJECT_DIR/.next — this build carries no identity (run 'bun run build')"

say "BUILD IDENTITY: OK — ${CHECKED} artifact(s) built from ${EXPECT_SHA:0:7}"
