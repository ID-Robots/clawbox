#!/usr/bin/env bash
# Set up the canonical shared agent identity used by BOTH harnesses
# (OpenClaw + Hermes), so ClawBox presents one agent — one SOUL/USER — no
# matter which harness the user has selected.
#
# Design (validated on-device 2026-08-09):
#   * Canonical source of truth: ~/.clawbox/agent-identity/{SOUL,USER,MEMORY}.md
#   * Hermes FOLLOWS symlinks → link its identity files to canonical (live).
#   * OpenClaw's workspace scanner does NOT follow symlinks (a symlinked file
#     reads as "missing" and is not injected) → give it REAL copies, refreshed
#     by clawbox-identity-sync.sh on harness-switch / on canonical change.
#   * MEMORY.md is read by Hermes; OpenClaw keeps its own memory store, so
#     cross-harness MEMORY needs an export/import sync (see the sync script) —
#     identity (SOUL/USER) is the reliably-shared channel.
#
# Idempotent. Providers/OAuth are intentionally NOT shared (each harness
# authenticates independently — OpenClaw warns against a shared OAuth grant).
set -euo pipefail

HOME_DIR="${HOME:-/home/clawbox}"
CANON="$HOME_DIR/.clawbox/agent-identity"
OC_WS="$HOME_DIR/.openclaw/workspace"
HM_DIR="$HOME_DIR/.hermes"

mkdir -p "$CANON"

# 1. Seed canonical from OpenClaw's established identity (only if not present).
[ -f "$CANON/SOUL.md" ] || cp "$OC_WS/SOUL.md" "$CANON/SOUL.md" 2>/dev/null || printf '# SOUL\n' > "$CANON/SOUL.md"
[ -f "$CANON/USER.md" ] || cp "$OC_WS/USER.md" "$CANON/USER.md" 2>/dev/null || printf '# USER\n' > "$CANON/USER.md"
[ -f "$CANON/MEMORY.md" ] || cp "$OC_WS/MEMORY.md" "$CANON/MEMORY.md" 2>/dev/null || \
  printf '# Shared Agent Memory\n\nShared by the OpenClaw and Hermes harnesses.\n' > "$CANON/MEMORY.md"

# 2. OpenClaw side — REAL copies (scanner ignores symlinks). Back up any
#    pre-existing real file once.
#
# Held back until OpenClaw's first-conversation ritual is over, which is the
# same test src/lib/language-persona.ts applies before writing the persona from
# the app. OpenClaw decides on the agent's first reply whether to run that
# introduction, and it decides by looking at this directory: a USER.md or
# SOUL.md that differs from its own template — or a MEMORY.md, whose mere
# presence counts — means "already configured", so it stamps the workspace
# complete and the agent never introduces itself. Copying the canonical
# identity in on a dual box before the first hello suppressed the ritual on
# that SKU exactly as the app's language write did on every other one.
#
# USER.md present and BOOTSTRAP.md absent is "the workspace is the agent's
# own": creating USER.md is the suppressing act, and a BOOTSTRAP.md still on
# disk means the ritual is armed and unfinished, where a write now would make
# the next turn delete it. Nothing is lost by waiting — clawbox-identity-sync.sh
# runs this again on the next harness switch or canonical change.
if [ -d "$OC_WS" ] && [ -f "$OC_WS/USER.md" ] && [ ! -e "$OC_WS/BOOTSTRAP.md" ]; then
  for f in SOUL USER MEMORY; do
    t="$OC_WS/$f.md"
    if [ -L "$t" ]; then rm -f "$t"; fi
    if [ -e "$t" ] && [ ! -e "$t.pre-bridge" ]; then cp "$t" "$t.pre-bridge"; fi
    cp "$CANON/$f.md" "$t"
  done
else
  echo "[setup-shared-identity] OpenClaw workspace left alone (missing, or not introduced yet)"
fi

# Move a real (non-symlink) file out of the way before symlinking, without ever
# clobbering an earlier backup — so repeated migrations never destroy previously
# preserved Hermes identity data.
backup_if_real() {
  local f="$1"
  [ -e "$f" ] && [ ! -L "$f" ] || return 0
  local bak="$f.pre-bridge"
  [ -e "$bak" ] && bak="$f.pre-bridge.$(date +%s.%N)"
  mv "$f" "$bak"
}

# 3. Hermes side — symlinks (Hermes follows them; keeps the markdown live).
if [ -d "$HM_DIR" ]; then
  mkdir -p "$HM_DIR/memories"
  backup_if_real "$HM_DIR/SOUL.md"
  backup_if_real "$HM_DIR/memories/MEMORY.md"
  backup_if_real "$HM_DIR/memories/USER.md"
  ln -sfn "$CANON/SOUL.md" "$HM_DIR/SOUL.md"
  ln -sfn "$CANON/MEMORY.md" "$HM_DIR/memories/MEMORY.md"
  ln -sfn "$CANON/USER.md" "$HM_DIR/memories/USER.md"
fi

echo "[setup-shared-identity] canonical=$CANON  openclaw=copies  hermes=symlinks"
