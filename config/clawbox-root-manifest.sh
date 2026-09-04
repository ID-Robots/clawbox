#!/usr/bin/env bash
#
# Integrity manifest for the code root executes on the clawbox user's behalf.
#
# The privilege chain is:
#
#   clawbox  --sudo-->  systemctl start clawbox-root-update@<step>.service
#            --systemd-->  /usr/local/libexec/clawbox/clawbox-root-step.sh (root:root)
#            --exec-->     /home/clawbox/clawbox/install.sh --step <step>
#
# Only the middle link is root-owned. install.sh is `clawbox:clawbox 0755` in a
# `clawbox:clawbox 0775` directory — install.sh itself hands the tree back with
# `chown -R clawbox:clawbox` on every root run — and the steps it dispatches go
# on to run more of the same tree as root (scripts/start-ap.sh,
# scripts/launch-browser.sh, scripts/setup-hermes-edition.sh, …). So anything
# with clawbox-level code execution — the web server, the in-UI terminal, the
# agent's shell — could rewrite the program root was about to run and then
# trigger a granted step. That is passwordless local root in two moves, and it
# is the defect TASK-445 was filed about.
#
# Moving the tree out of clawbox's reach is not an option: the updater has to be
# able to replace it, and the app has to be able to build in it. So instead the
# root side REFUSES to run code it did not record. This file writes and checks
# that record:
#
#   * install.sh writes the manifest at the end of every root-side install and
#     immediately after every successful `git reset --hard` to the update branch
#     (install.sh's bootstrap block and sync_repo_to_update_target). Those are
#     the only two ways the covered files are supposed to change.
#   * clawbox-root-step.sh verifies it before exec'ing anything. A tampered or
#     unrecorded tree fails the step instead of running as root.
#
# What this does and does not buy:
#
#   * It closes the "rewrite install.sh, then start a granted unit" path — the
#     dispatcher refuses before the exec.
#   * It does NOT make the box safe against someone who can already run code as
#     root, and it does not authenticate the UPDATE itself: an update legitimately
#     replaces the covered files and re-records them. The update path is gated
#     on the dashboard session instead (TASK-445's "require auth for update").
#
# Usage (root only):
#   clawbox-root-manifest.sh --write     record the tree as it is now
#   clawbox-root-manifest.sh --verify    exit 0 if it still matches, 65 if not
#   clawbox-root-manifest.sh --selftest  print SELFTEST_TOKEN — proof that this
#                                        file is complete, which no exit status
#                                        of the verbs above can give
#
# Installed by install.sh::install_root_libexec to
# /usr/local/libexec/clawbox/clawbox-root-manifest.sh, root:root 0755.

set -euo pipefail

# Hard-coded on purpose. Every value below selects WHICH code root executes, so
# none of them is overridable from the environment: this script runs from a
# systemd unit reached through a NOPASSWD sudoers grant, and an env escape hatch
# would be a second way to point root at a file the clawbox user chose.
PROJECT_DIR="/home/clawbox/clawbox"
MANIFEST_DIR="/etc/clawbox"
MANIFEST_FILE="/etc/clawbox/root-exec.manifest"

# What --selftest prints, and the only thing that makes the exit statuses of the
# verbs above worth reading.
#
# `install` writes into the destination inode with O_TRUNC, so a copy of this
# file that dies part way through — a full or read-only root filesystem — leaves
# an executable helper containing some prefix of it. That prefix has no case
# statement at the bottom, so it runs to EOF and exits 0 for `--write`, for
# `--verify` and for `--verify-file` without doing any of them. An empty file
# does the same. Both callers — install.sh and the root dispatcher — then read
# "the tree is recorded and matches" out of a program that never looked, and
# clawbox-root-step.sh execs a clawbox-writable tree as root on the strength of
# it. So callers ask for this token first; only a copy that reaches the last
# line of this file can print it. Repeated as a literal in install.sh and
# config/clawbox-root-step.sh, which are installed separately and cannot share a
# constant; src/tests/unit/root-exec-manifest.test.ts pins them against this one.
#
# THIS STRING IS A WIRE FORMAT — never change it, only ever add a second
# accepted value. install_root_libexec installs this helper unconditionally but
# the dispatcher only if the manifest write succeeded, so the two ARE reachable
# at different releases on the same box. A changed token would leave an older
# dispatcher asking a newer helper: it gets exit 0 with a token it does not
# recognise, which is neither the match nor the 64 an unknown verb returns, and
# it would declare a perfectly healthy helper dead — every pinned root step
# refused, on boxes that are fine, fleet-wide.
SELFTEST_TOKEN="clawbox-root-manifest alive"

# Everything the clawbox-root-update@ chain can end up running as root:
# install.sh, the scripts it hands to bash, and the config/unit files it installs.
# Runtime state — data/, .next/, node_modules/, .git/ — is deliberately NOT
# covered: it is clawbox's to write and root never executes it, so covering it
# would turn every build into a manifest mismatch.
COVERED_PATHS="install.sh scripts config"

# Generated content that lives INSIDE a covered path, and must not be recorded.
# `scripts/__pycache__/` is the one that bites: gateway-pre-start.sh imports
# scripts/gateway_origins.py, so CPython writes a .pyc there the first time the
# gateway starts — after the manifest was written, and again under a different
# name after any python3 minor-version bump. Recording those would make an
# ordinary first boot, or an ordinary distro upgrade, refuse every root step.
PRUNE_DIRS="__pycache__ node_modules .venv venv"

die() {
  echo "clawbox-root-manifest: $1" >&2
  exit "${2:-65}"
}

# Covered files, relative to PROJECT_DIR, NUL-delimited and byte-sorted.
# Callers must already be in PROJECT_DIR.
#
# `-type f` excludes symlinks deliberately: what gets RECORDED is a real file
# and its real content. Verification then re-opens the recorded path, so
# replacing one of these with a symlink to something else changes the hash and
# fails — which is the answer we want, rather than recording the link.
covered_files() {
  local p
  local -a args=() prune=()
  for p in $COVERED_PATHS; do
    [ -e "$p" ] && args+=("$p")
  done
  [ "${#args[@]}" -gt 0 ] || return 1
  for p in $PRUNE_DIRS; do
    prune+=(-name "$p" -prune -o)
  done
  find "${args[@]}" "${prune[@]}" -type f -print0 | LC_ALL=C sort -z
}

write_manifest() {
  cd "$PROJECT_DIR" || die "$PROJECT_DIR is missing" 66

  # ONE walk, so the names that are checked are exactly the names that are
  # hashed. Walking twice — once to check, once to hash — leaves a window in
  # which a file that appears in between is recorded without ever having been
  # checked.
  #
  # The check itself: sha256sum ESCAPES a filename containing a backslash or a
  # newline (it prefixes the line with `\` and re-encodes them), and
  # verify_manifest reads the path column back with a fixed-width strip. Refuse
  # to record such a name rather than record one this file cannot parse.
  local f
  local -a files=()
  while IFS= read -r -d '' f; do
    case "$f" in
      *\\*|*$'\n'*)
        die "refusing to record a path containing a backslash or a newline"
        ;;
    esac
    files+=("$f")
  done < <(covered_files)
  [ "${#files[@]}" -gt 0 ] || die "nothing to record under $PROJECT_DIR" 66

  install -d -o root -g root -m 0755 "$MANIFEST_DIR" || die "cannot create $MANIFEST_DIR" 66

  # Staged inside the root-owned /etc/clawbox, never /tmp: a world-writable
  # staging directory is one more place to race the file root ends up trusting.
  local tmp
  tmp="$(mktemp "$MANIFEST_FILE.XXXXXX")" || die "cannot stage a manifest" 66
  if ! printf '%s\0' "${files[@]}" | xargs -0 sha256sum > "$tmp"; then
    rm -f "$tmp"
    die "cannot hash $PROJECT_DIR" 66
  fi
  if ! chmod 0644 "$tmp"; then
    rm -f "$tmp"
    die "cannot set the manifest mode" 66
  fi
  if ! mv -f "$tmp" "$MANIFEST_FILE"; then
    rm -f "$tmp"
    die "cannot install $MANIFEST_FILE" 66
  fi
}

verify_manifest() {
  [ -f "$MANIFEST_FILE" ] || die "no manifest at $MANIFEST_FILE"
  cd "$PROJECT_DIR" || die "$PROJECT_DIR is missing" 66

  # Every recorded file must still be there and still hash to what was recorded.
  # That covers the three things that matter: an edited file, a deleted file, and
  # a file replaced by a symlink (sha256sum opens the path, so it hashes what the
  # link resolves to and the content stops matching).
  #
  # A file ADDED under a covered path is deliberately NOT an error, even though
  # `sha256sum -c` cannot see it. Root only ever executes files install.sh names
  # explicitly, and all of those are recorded — so an unrecorded file is not
  # something root can be made to run. Treating additions as tampering, on the
  # other hand, turns any stray file under scripts/ into a device that refuses
  # every root step for good: no password change, no hostname change, no hotspot
  # restart, on an appliance with no console. That trade is the wrong way round.
  sha256sum --status --strict -c "$MANIFEST_FILE" \
    || die "$PROJECT_DIR does not match $MANIFEST_FILE (a covered file changed or is gone)"
}

# Check ONE already-opened copy against what the manifest recorded for a path.
#
# `--verify` answers a question about the project tree, and the answer is stale
# the moment it returns: the clawbox user can replace a file between the check
# and the exec, and a tight rewrite loop wins that race. So the root dispatcher
# copies the file it is going to run into a root-only directory FIRST and then
# asks about the copy — which is the same bytes it will execute, and which
# clawbox cannot touch.
#
#   clawbox-root-manifest.sh --verify-file <recorded path> <file to hash>
verify_file() {
  local rel="$1" actual="$2" want="" got h p
  [ -n "$rel" ] && [ -n "$actual" ] || die "usage: $0 --verify-file <recorded path> <file>" 64
  [ -f "$MANIFEST_FILE" ] || die "no manifest at $MANIFEST_FILE"
  [ -f "$actual" ] || die "$actual is missing" 66

  # Read the recorded hash out of the sha256sum-format manifest by exact path
  # match. write_manifest refuses names it would have to escape, so the path
  # column is the plain name (with a leading `*` in binary mode).
  while read -r h p; do
    p="${p#\*}"
    if [ "$p" = "$rel" ]; then
      want="$h"
      break
    fi
  done < "$MANIFEST_FILE"
  [ -n "$want" ] || die "$rel is not in $MANIFEST_FILE"

  got="$(sha256sum < "$actual")"
  got="${got%% *}"
  [ "$want" = "$got" ] || die "$actual does not match what $MANIFEST_FILE recorded for $rel"
}

case "${1:-}" in
  --write)  write_manifest ;;
  --verify) verify_manifest ;;
  --verify-file) verify_file "${2:-}" "${3:-}" ;;
  --selftest) printf '%s\n' "$SELFTEST_TOKEN" ;;
  *)
    echo "usage: $0 --write | --verify | --verify-file <recorded path> <file> | --selftest" >&2
    exit 64
    ;;
esac
