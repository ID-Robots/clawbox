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
if [ -d "$OC_WS" ]; then
  for f in SOUL USER MEMORY; do
    t="$OC_WS/$f.md"
    if [ -L "$t" ]; then rm -f "$t"; fi
    if [ -e "$t" ] && [ ! -e "$t.pre-bridge" ]; then cp "$t" "$t.pre-bridge"; fi
    cp "$CANON/$f.md" "$t"
  done
fi

# 3. Hermes side — symlinks (Hermes follows them; keeps the markdown live).
if [ -d "$HM_DIR" ]; then
  mkdir -p "$HM_DIR/memories"
  [ -e "$HM_DIR/SOUL.md" ] && [ ! -L "$HM_DIR/SOUL.md" ] && mv "$HM_DIR/SOUL.md" "$HM_DIR/SOUL.md.pre-bridge"
  ln -sfn "$CANON/SOUL.md" "$HM_DIR/SOUL.md"
  ln -sfn "$CANON/MEMORY.md" "$HM_DIR/memories/MEMORY.md"
  ln -sfn "$CANON/USER.md" "$HM_DIR/memories/USER.md"
fi

echo "[setup-shared-identity] canonical=$CANON  openclaw=copies  hermes=symlinks"
