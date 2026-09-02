#!/usr/bin/env bash
# Assert that no server chunk of the production build carries a Turbopack
# "external" stub where a Node builtin should be.
#
# Why this exists: src/lib/openclaw-session-store.ts loaded node:sqlite through
# `createRequire(import.meta.url)`. Turbopack cannot externalise that shape and
# compiled the call into a stub that THROWS at runtime —
#   Cannot find module 'node:sqlite': Unsupported external type Url for commonjs reference
# — while `bun run build` succeeded and vitest (which does not bundle) stayed
# green. On the box every reader of the SQLite session store then failed its
# open() and silently fell back to legacy files OpenClaw 2 no longer writes.
# Only the built chunks can show this, so the built chunks are what is checked.
#
# Callers: CI (.github/workflows/build-identity.yml) right after `bun run build`.
# It is deliberately NOT part of postbuild or of verify-build-identity.sh — both
# run inside the customer's updater, and a failed check there would take the
# site down over a bug that this script exists to catch in CI first.
#
# Usage:
#   scripts/check-bundled-builtins.sh [--project-dir DIR]
#
# Exit codes: 0 = clean, 1 = a stub was found, 2 = nothing to check / usage.
set -uo pipefail

PROJECT_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --project-dir)
      [ -n "${2:-}" ] || { echo "check-bundled-builtins: $1 needs a value" >&2; exit 2; }
      PROJECT_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "check-bundled-builtins: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

if [ -z "$PROJECT_DIR" ]; then
  PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# Both trees when both exist: `.next/server/chunks` is what the build produced,
# `.next/standalone/.next/server/chunks` is what the service actually runs from.
CHUNK_DIRS=(
  "$PROJECT_DIR/.next/server/chunks"
  "$PROJECT_DIR/.next/standalone/.next/server/chunks"
)

# The stub's message, in two halves so the check is class-wide: the second
# half names the builtin family, the first is what Turbopack says about ANY
# external it could not resolve, whatever the module is called next time.
CHECKED=0
FOUND=0
for dir in "${CHUNK_DIRS[@]}"; do
  [ -d "$dir" ] || continue
  CHECKED=$((CHECKED + 1))
  HITS="$(grep -rlF --include='*.js' \
    -e "Unsupported external type" \
    -e "Cannot find module 'node:" \
    -- "$dir" 2>/dev/null || true)"
  if [ -n "$HITS" ]; then
    FOUND=1
    echo "BUNDLED BUILTINS: FAIL — a Turbopack external stub is compiled into:" >&2
    printf '%s\n' "$HITS" | sed "s|^$PROJECT_DIR/|  |" >&2
  fi
  # Positive control: the session store's loader must have reached the chunks
  # as the call it is in the source. Without this, a Next release that rewords
  # the stub would make the negative grep above print OK over the same bug.
  LOADER="$(grep -rlF --include='*.js' -- "getBuiltinModule" "$dir" 2>/dev/null \
    | xargs -r grep -lF -- "node:sqlite" 2>/dev/null || true)"
  if [ -z "$LOADER" ]; then
    FOUND=1
    echo "BUNDLED BUILTINS: FAIL — no chunk under ${dir#"$PROJECT_DIR/"} carries the session store's" >&2
    echo "  process.getBuiltinModule(\"node:sqlite\") loader; it was rewritten or dropped by the bundler." >&2
  fi
done

if [ "$CHECKED" -eq 0 ]; then
  echo "BUNDLED BUILTINS: no server chunks under $PROJECT_DIR/.next — run 'bun run build' first" >&2
  exit 2
fi

if [ "$FOUND" -ne 0 ]; then
  echo "BUNDLED BUILTINS: FAIL — see above. Load a Node builtin with process.getBuiltinModule()" >&2
  echo "  (see src/lib/openclaw-session-store.ts), never createRequire(): Turbopack turns that into a throwing stub." >&2
  exit 1
fi

echo "BUNDLED BUILTINS: OK — no Turbopack external stubs in $CHECKED chunk tree(s)"
