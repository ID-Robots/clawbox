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

# Everything the clawbox-root-update@ chain can end up running as root:
# install.sh, the scripts it hands to bash, and the config/unit files it installs.
# Runtime state — data/, .next/, node_modules/, .git/ — is deliberately NOT
# covered: it is clawbox's to write and root never executes it, so covering it
# would turn every build into a manifest mismatch.
COVERED_PATHS="install.sh scripts config"

die() {
  echo "clawbox-root-manifest: $1" >&2
  exit "${2:-65}"
}

# Covered files, relative to PROJECT_DIR, NUL-delimited and byte-sorted.
# Callers must already be in PROJECT_DIR.
#
# `-type f` excludes symlinks deliberately: a symlink is a way to make a
# recorded name resolve to unrecorded content, so one appearing under a covered
# path shows up as a missing file and fails verification rather than passing it.
covered_files() {
  local p
  local -a args=()
  for p in $COVERED_PATHS; do
    [ -e "$p" ] && args+=("$p")
  done
  [ "${#args[@]}" -gt 0 ] || return 1
  find "${args[@]}" -type f -print0 | LC_ALL=C sort -z
}

# The path column of a sha256sum-format manifest. write_manifest refuses names
# sha256sum would have to escape, so stripping the fixed-width prefix is exact.
# The separator is two spaces in text mode and " *" in binary mode; coreutils on
# the device emits the former, but accept both so the manifest stays readable
# wherever it was generated.
manifest_paths() {
  sed -n 's/^[0-9a-f]\{64\} [ *]//p' "$MANIFEST_FILE"
}

write_manifest() {
  cd "$PROJECT_DIR" || die "$PROJECT_DIR is missing" 66

  local f bad=0
  while IFS= read -r -d '' f; do
    case "$f" in
      *$'\n'*|*\*) bad=1; break ;;
    esac
  done < <(covered_files)
  [ "$bad" -eq 0 ] || die "refusing to record a path containing a backslash or a newline"

  install -d -o root -g root -m 0755 "$MANIFEST_DIR" || die "cannot create $MANIFEST_DIR" 66

  # Staged inside the root-owned /etc/clawbox, never /tmp: a world-writable
  # staging directory is one more place to race the file root ends up trusting.
  local tmp
  tmp="$(mktemp "$MANIFEST_FILE.XXXXXX")" || die "cannot stage a manifest" 66
  if ! covered_files | xargs -0 -r sha256sum > "$tmp"; then
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

  # Content: every recorded file must still hash to what was recorded.
  sha256sum --status --strict -c "$MANIFEST_FILE" \
    || die "$PROJECT_DIR does not match $MANIFEST_FILE (a covered file changed or is gone)"

  # Membership: a file ADDED under a covered path is invisible to `sha256sum -c`,
  # so compare the sets too.
  local want have
  want="$(manifest_paths | LC_ALL=C sort)"
  have="$(covered_files | tr '\0' '\n' | LC_ALL=C sort)"
  [ "$want" = "$have" ] \
    || die "the set of files under $PROJECT_DIR/{${COVERED_PATHS// /,}} no longer matches $MANIFEST_FILE"
}

case "${1:-}" in
  --write)  write_manifest ;;
  --verify) verify_manifest ;;
  *)
    echo "usage: $0 --write|--verify" >&2
    exit 64
    ;;
esac
