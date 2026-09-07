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
# The record alone could not cover the UPDATE family, though, and that was
# TASK-733. `bootstrap_updater`, `post_update` and `rebuild_reboot` are exempt
# from the check because an update legitimately rewrites the very files it
# records — and all three are startable by the web server through the sudo
# launcher. So root exec'd /home/clawbox/clawbox/install.sh for them with
# nothing checked at all: write install.sh, start the step, own the box.
#
# The answer is the MIRROR below: a root-owned copy of the same three paths,
# refreshed only from a tree that still matches the record, and the only thing
# the dispatcher ever execs. `--verify` says "is the tree still what root
# recorded"; `--mirror` acts on a yes. A tree nobody can vouch for is not
# copied, so it is not something root can be made to run.
#
# Usage (root only):
#   clawbox-root-manifest.sh --write        record the tree as it is now
#   clawbox-root-manifest.sh --verify       exit 0 if it still matches, 65 if not
#   clawbox-root-manifest.sh --mirror       restage the root-owned copy root runs
#   clawbox-root-manifest.sh --mirror-path  print where that copy lives
#   clawbox-root-manifest.sh --selftest     print SELFTEST_TOKEN — proof that this
#                                           file is complete, which no exit status
#                                           of the verbs above can give
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
# The copy root actually executes. Root-owned, under root-owned directories,
# holding the same paths the manifest covers — see mirror_tree().
#
# /var/lib, not /run: `rebuild_reboot` REBOOTS the box and `post_update` runs
# after it comes back, so a mirror on tmpfs would be gone at exactly the step
# that needs it and every field box would meet an update that cannot finish.
MIRROR_DIR="/var/lib/clawbox/root-exec-mirror"

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
# This one list is both what gets RECORDED and what gets MIRRORED (mirror_tree
# walks it through the same covered_files below), so the set root may execute
# and the set root has vouched for cannot drift apart.
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

# Restage the root-owned copy of everything root executes on clawbox's behalf.
#
# Same walk as write_manifest — deliberately the same function, so the set of
# files root RUNS and the set of files root RECORDS cannot drift apart. A path
# added to COVERED_PATHS is mirrored; a file pruned out of the record is not in
# the mirror either.
#
# WHO MAY CALL THIS is the whole security property, and it is not enforced here:
# copying the tree is only safe at a moment when the tree is not the attacker's
# to choose. config/clawbox-root-step.sh calls it only after `--verify` said the
# tree still matches the root-owned record, and install.sh calls it only from
# write_root_exec_manifest, which re-records the tree at the two points the
# update mechanism defines as "this is the new code" (a full install run by an
# operator, and immediately after its own `git reset --hard` to the update
# branch). Adding a third caller is a privilege decision.
mirror_tree() {
  # The record is what the staged copy is checked against below, so there is
  # nothing to stage without one.
  [ -f "$MANIFEST_FILE" ] || die "no manifest at $MANIFEST_FILE"
  cd "$PROJECT_DIR" || die "$PROJECT_DIR is missing" 66

  # Deterministic modes regardless of the caller's umask: the dispatcher execs
  # out of here, and a mirror that came out 0700-by-umask would refuse the
  # unprivileged callers install.sh also hands these scripts to.
  umask 022

  local staging="$MIRROR_DIR.new" previous="$MIRROR_DIR.old" parent f mode
  parent="$(dirname "$MIRROR_DIR")"
  if [ ! -d "$parent" ]; then
    install -d -o root -g root -m 0755 "$parent" || die "cannot create $parent" 66
  fi

  # ONE restage at a time, fleet-wide-fixed names and all.
  #
  # Concurrent dispatches are ordinary here: the updater fires steps while the
  # UI can start `restart_ap` or `vnc_refresh`, and every dispatch restages.
  # Without this, one instance's opening `rm -rf` destroys the other's half-built
  # staging directory — and worse, B's `rm -rf "$previous"` can delete the
  # directory A moved aside a microsecond earlier, so A's failed rename finds
  # nothing to put back and $MIRROR_DIR is left ABSENT. Every root step then
  # exits 65 until a dispatch whose tree verifies rebuilds it. The lock is what
  # makes the fixed names below safe.
  exec 9>"$MIRROR_DIR.lock" || die "cannot open the mirror lock" 66
  flock -w 120 9 || die "another root step is restaging $MIRROR_DIR" 66

  rm -rf "$staging" "$previous" || die "cannot clear the mirror staging area" 66
  install -d -o root -g root -m 0755 "$staging" || die "cannot create $staging" 66

  # ONE walk, for the same reason write_manifest takes one: the names that are
  # copied are exactly the names that were listed.
  local -a files=()
  while IFS= read -r -d '' f; do
    files+=("$f")
  done < <(covered_files)
  [ "${#files[@]}" -gt 0 ] || die "nothing to mirror under $PROJECT_DIR" 66

  for f in "${files[@]}"; do
    # The exec bit is content here: install.sh runs scripts/ out of the mirror
    # and a 0644 copy of start-ap.sh is a root step that fails at the exec.
    mode=0644
    [ -x "$f" ] && mode=0755
    install -o root -g root -D -m "$mode" "$f" "$staging/$f" \
      || die "cannot mirror $f" 66
  done

  # CHECK THE COPY, and only then let anything run it.
  #
  # Without this the mirror is a copy of the tree at COPY time, not of the tree
  # the caller's `--verify` vouched for a moment earlier — and $PROJECT_DIR
  # belongs to the unprivileged account the whole boundary is about. The walk
  # above is byte-sorted, so `config/*` lands before `install.sh` and `scripts/*`
  # after it, and the staging directory appearing under a 0755 /var/lib/clawbox
  # is itself the starting gun: a poller that renames a payload over
  # $PROJECT_DIR/install.sh once it sees $MIRROR_DIR.new gets those bytes into
  # the root-owned copy the dispatcher then execs for three NOPASSWD-startable
  # steps. Reproduced against this function before the check existed.
  #
  # `sha256sum -c` over the STAGED tree answers it in one pass, because the
  # manifest's paths are relative and the mirror has the same layout — the same
  # property --verify-file gives for one file, applied to all of them. A file
  # ADDED under a covered path is not an error here for the same reason it is
  # not in verify_manifest: root only ever runs files install.sh names, and every
  # one of those is recorded.
  #
  # On a mismatch the staging is thrown away and the PREVIOUS mirror is left
  # standing. That is not a stranding path: the dispatcher already treats a
  # failed restage as "run the copy already there", which is a previous
  # root-established build.
  if ! ( cd "$staging" && sha256sum --status --strict -c "$MANIFEST_FILE" ); then
    rm -rf "$staging"
    die "$PROJECT_DIR changed while it was being mirrored — refusing to install a copy root did not vouch for"
  fi

  # Swap whole directories rather than copying over the live one. A copy in
  # place is visible half-finished, and the thing reading it is root about to
  # exec. Two renames instead: a step already running holds its own inodes, and
  # a step starting sees the old tree or the new one.
  #
  # Residual, recorded rather than implied: between the two renames $MIRROR_DIR
  # does not exist, and a dispatch landing in that window refuses (exit 65)
  # instead of running anything. That is a retry on an appliance, not a root
  # exec of the tree, which is the direction this whole file fails in.
  if [ -d "$MIRROR_DIR" ]; then
    mv -T "$MIRROR_DIR" "$previous" || die "cannot move the previous mirror aside" 66
  fi
  if ! mv -T "$staging" "$MIRROR_DIR"; then
    if [ -d "$previous" ]; then
      mv -T "$previous" "$MIRROR_DIR" || true
    fi
    die "cannot install $MIRROR_DIR" 66
  fi
  rm -rf "$previous"
}

case "${1:-}" in
  --write)  write_manifest ;;
  --verify) verify_manifest ;;
  --verify-file) verify_file "${2:-}" "${3:-}" ;;
  --mirror) mirror_tree ;;
  --mirror-path) printf '%s\n' "$MIRROR_DIR" ;;
  --selftest) printf '%s\n' "$SELFTEST_TOKEN" ;;
  *)
    echo "usage: $0 --write | --verify | --verify-file <recorded path> <file> | --mirror | --mirror-path | --selftest" >&2
    exit 64
    ;;
esac
