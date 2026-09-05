#!/usr/bin/env bash
# Point the standalone tree at the real `next` package.
#
# The webpack standalone build's traced copy of `next` misses
# lib/metadata/get-metadata-route, and the server dies on it at start (both
# e2e suites did, 2026-09-05). So postbuild replaces the traced copy with a
# symlink to the package the build ran with — what the box's stopgap builds
# had been doing by hand.
#
# ONLY into a tree of its own: in a worktree whose node_modules is a symlink
# to another checkout's, the traced tree's node_modules is a symlink to that
# real directory, and an `rm -rf` through it deleted the real `next` package
# (2026-09-05, restored from bun's cache). A symlinked tree already resolves
# to the full package, so there is nothing to do there.
#
#   link-standalone-next.sh <standalone dir> [project dir]
#
# Exits non-zero when the link cannot be made: a build without a servable
# `next` must not pass.
set -u
SDIR="${1:?standalone dir}"
PROJECT="${2:-$(pwd)}"
REAL="$PROJECT/node_modules/next"
# The build just ran WITH this package; its absence is a broken tree, not
# a case to wave through with the traced copy the server cannot start on.
if [ ! -d "$REAL" ]; then
  echo "link-standalone-next: no $REAL to link" >&2
  exit 1
fi
if [ ! -d "$SDIR/node_modules" ]; then
  echo "link-standalone-next: $SDIR/node_modules is not a directory" >&2
  exit 1
fi
if [ -L "$SDIR/node_modules" ]; then
  echo "link-standalone-next: $SDIR/node_modules is a symlink — the real package is already in reach, nothing replaced"
  exit 0
fi
rm -rf "$SDIR/node_modules/next" || { echo "link-standalone-next: could not remove the traced copy" >&2; exit 1; }
ln -s "$REAL" "$SDIR/node_modules/next" || { echo "link-standalone-next: could not link $REAL" >&2; exit 1; }
[ -f "$SDIR/node_modules/next/package.json" ] || { echo "link-standalone-next: the link does not resolve to a package" >&2; exit 1; }
echo "link-standalone-next: $SDIR/node_modules/next -> $REAL"
