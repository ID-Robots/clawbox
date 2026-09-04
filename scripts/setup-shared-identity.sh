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

# Has OpenClaw finished its first-conversation ritual?
#
# The same test src/lib/language-persona.ts applies before writing the persona
# from the app, and clawbox-identity-sync.sh repeats it for its own copy down.
# OpenClaw decides on the agent's first reply whether to run that introduction,
# and it decides by looking at the workspace: a USER.md or SOUL.md that differs
# from its own template — or a MEMORY.md, whose mere presence counts — means
# "already configured", so it stamps the workspace complete and the agent never
# introduces itself. Copying the canonical identity in on a dual box before the
# first hello suppressed the ritual on that SKU exactly as the app's language
# write did on every other one.
#
# USER.md present and BOOTSTRAP.md absent is "the workspace is the agent's
# own": creating USER.md is the suppressing act, and a BOOTSTRAP.md still on
# disk means the ritual is armed and unfinished, where a write now would make
# the next turn delete it.
openclaw_introduced() {
  [ -d "$OC_WS" ] && [ -f "$OC_WS/USER.md" ] && [ ! -e "$OC_WS/BOOTSTRAP.md" ]
}

# The marker that says canonical holds placeholders rather than an identity.
# Written by the seeding step below, consumed by the promotion step after it —
# and by clawbox-identity-sync.sh, whichever of the two runs first once the
# introduction is over.
PROVISIONAL="$CANON/.provisional"

# Canonical ← workspace, ONCE, and only for a canonical that was seeded before
# the introduction. Everything else in this bridge flows the other way; this is
# the one moment where it cannot, because the ritual is the AUTHOR of the
# identity and canonical was seeded with placeholders minutes before the ritual
# ran. Copying those placeholders down would erase the owner's name and the
# vibe the agent had just chosen. The marker is what makes it exactly once: an
# owner who later edits canonical is still authoritative, as the header says.
#
# MEMORY.md is normally absent from a just-introduced workspace, so canonical
# keeps its own placeholder for it and the copy down puts that back — which is
# what we want, since a workspace MEMORY.md would have suppressed the ritual.
promote_canonical_from_workspace() {
  local f
  for f in SOUL USER MEMORY; do
    if [ -f "$OC_WS/$f.md" ]; then cp "$OC_WS/$f.md" "$CANON/$f.md" || return 1; fi
  done
  # The marker's removal is part of the promotion, not a tidy-up after it: a
  # marker that survives would have this run again on every later sync, long
  # after canonical became authoritative.
  rm -f "$PROVISIONAL" || return 1
  echo "[setup-shared-identity] promoted the introduced OpenClaw identity into canonical"
}

mkdir -p "$CANON"

# 1. Seed canonical from OpenClaw's established identity (only if not present).
canon_was_seeded=0
[ -f "$CANON/USER.md" ] || canon_was_seeded=1
[ -f "$CANON/SOUL.md" ] || cp "$OC_WS/SOUL.md" "$CANON/SOUL.md" 2>/dev/null || printf '# SOUL\n' > "$CANON/SOUL.md"
[ -f "$CANON/USER.md" ] || cp "$OC_WS/USER.md" "$CANON/USER.md" 2>/dev/null || printf '# USER\n' > "$CANON/USER.md"
[ -f "$CANON/MEMORY.md" ] || cp "$OC_WS/MEMORY.md" "$CANON/MEMORY.md" 2>/dev/null || \
  printf '# Shared Agent Memory\n\nShared by the OpenClaw and Hermes harnesses.\n' > "$CANON/MEMORY.md"

# The seed above copies OpenClaw's established identity — but only when OpenClaw
# HAS one. This script runs at install time (scripts/setup-hermes-edition.sh),
# which on a fresh dual box is before the agent has ever replied, so the copies
# fall through to the placeholders above: "# USER", "# SOUL", an empty shared
# memory. Those bytes are not an identity, and the introduction that is about to
# happen is the thing that writes the real one. Record that they are provisional
# so the first sync after the ritual promotes the ritual's answers instead of
# overwriting them with a name nobody chose.
if [ "$canon_was_seeded" = 1 ] && ! openclaw_introduced; then
  : > "$PROVISIONAL" || echo "[setup-shared-identity] WARNING: could not mark the seeded identity provisional" >&2
fi

# 2. OpenClaw side — REAL copies (scanner ignores symlinks). Back up any
#    pre-existing real file once.
#
# Held back until OpenClaw's first-conversation ritual is over, for the reasons
# openclaw_introduced() carries. Nothing is lost by waiting —
# clawbox-identity-sync.sh runs this again on the next harness switch or
# canonical change.
if openclaw_introduced; then
  # Promote first, copy down second. A failed promotion must not fall through
  # to the copy: that is precisely the write that would destroy the ritual's
  # work, and leaving the workspace alone loses nothing that is not already on
  # disk there.
  if [ -e "$PROVISIONAL" ] && ! promote_canonical_from_workspace; then
    echo "[setup-shared-identity] WARNING: could not promote the introduced identity into canonical;" >&2
    echo "  leaving the OpenClaw workspace alone rather than copying placeholders over it" >&2
  else
    for f in SOUL USER MEMORY; do
      t="$OC_WS/$f.md"
      if [ -L "$t" ]; then rm -f "$t"; fi
      if [ -e "$t" ] && [ ! -e "$t.pre-bridge" ]; then cp "$t" "$t.pre-bridge"; fi
      cp "$CANON/$f.md" "$t"
    done
  fi
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
