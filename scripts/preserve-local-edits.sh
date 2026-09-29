#!/usr/bin/env bash
#
# Save a checkout's local edits before an update resets them away. TASK-1316.
#
# Usage:
#   preserve-local-edits.sh <checkout> [<save-root>]
#
# Every update path hard-syncs the checkout: install.sh's bootstrap block and
# sync_repo_to_update_target run `git reset --hard`, and src/lib/updater.ts
# follows with its own `reset --hard` and `clean -fd`. That is right for an
# appliance — the code on disk has to be the code that ships — but an owner who
# had edited a file in /home/clawbox/clawbox lost the edit without a trace, on
# the one screen that said nothing about it. So the update saves first:
#
#   <save-root>/<UTC timestamp>/
#     tracked.patch   `git diff --binary HEAD` — staged and unstaged changes to
#                     tracked files, deletions and mode changes included
#     untracked/      a copy of every untracked, non-ignored file, at its path
#     STATUS          `git status --short` as it was
#     BASE            the commit (and branch) the edits were made against
#     README.txt      how to put them back
#
# <save-root> is $CLAWBOX_LOCAL_EDITS_DIR, else `clawbox-local-edits` BESIDE the
# checkout (/home/clawbox/clawbox-local-edits on a box): outside the tree, so no
# reset, clean or re-clone can take it, and owned by whoever runs this — which
# must be the checkout's owner (install.sh drops to it with runuser, exactly as
# it does for git). The newest $CLAWBOX_LOCAL_EDITS_KEEP (default 5) saves are
# kept; older ones are removed.
#
# The update then proceeds on a clean tree — it never aborts BECAUSE of local
# edits. If the copy cannot be written (a full disk, a save root that is not
# writable), the edits go into the checkout's own `git stash` instead. Only when
# neither holds them does this exit 3, and the caller must then leave the tree
# alone: an update that stops is recoverable, work that was reset away is not.
#
# Output (stdout), only when something was saved:
#   CLAWBOX-WARN[local-edits-saved]: <sentence for the owner>
#       the marker the updater reads out of a root step's journal and puts on
#       the update's own result card (collectRootStepWarnings)
#   CLAWBOX-LOCAL-EDITS: <directory, or "git-stash">
#       the machine-readable half, for src/lib/local-edits.ts
#
# Exit status: 0 — nothing to save, or saved; 1 — usage, or not a checkout this
# can read; 3 — there are local edits and they could not be saved.

set -uo pipefail

checkout="${1:-}"
if [ -z "$checkout" ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 <checkout> [<save-root>]" >&2
  exit 1
fi
if [ ! -d "$checkout/.git" ] && [ ! -f "$checkout/.git" ]; then
  echo "preserve-local-edits: $checkout is not a git checkout" >&2
  exit 1
fi
checkout="$(cd "$checkout" && pwd -P)" || exit 1
owner_uid="$(stat -c %u "$checkout" 2>/dev/null || echo "")"

save_root="${2:-${CLAWBOX_LOCAL_EDITS_DIR:-$(dirname "$checkout")/clawbox-local-edits}}"
keep="${CLAWBOX_LOCAL_EDITS_KEEP:-5}"
case "$keep" in ''|*[!0-9]*|0) keep=5 ;; esac

git_() { git -c safe.directory="$checkout" -C "$checkout" "$@"; }

# What is there to save. `diff HEAD` rather than `status`: it is the set the
# patch below will hold, so the count the owner is told is the count they get.
if ! tracked="$(git_ diff --name-only HEAD --)"; then
  echo "preserve-local-edits: cannot read the local changes in $checkout" >&2
  exit 1
fi
if ! untracked="$(git_ ls-files --others --exclude-standard)"; then
  echo "preserve-local-edits: cannot list the untracked files in $checkout" >&2
  exit 1
fi
[ -n "$tracked" ] || [ -n "$untracked" ] || exit 0

count_lines() { [ -n "$1" ] && printf '%s\n' "$1" | wc -l | tr -d ' ' || echo 0; }
n_tracked="$(count_lines "$tracked")"
n_untracked="$(count_lines "$untracked")"
summary="$n_tracked changed file$([ "$n_tracked" = 1 ] || echo s), $n_untracked new file$([ "$n_untracked" = 1 ] || echo s)"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="$(git_ rev-parse --verify --quiet 'HEAD^{commit}' || echo unknown)"
branch="$(git_ symbolic-ref --short -q HEAD || echo '(detached HEAD)')"

# 0700 directories, 0600 files: an edit can be anything, including a key
# somebody pasted into a config file. The owner can read all of it.
umask 077

save_to_directory() {
  local dest="$1"
  printf '%s\n' "$base ${branch}" > "$dest/BASE" || return 1
  git_ status --short --untracked-files=all > "$dest/STATUS" || return 1
  if [ -n "$tracked" ]; then
    git_ diff --binary HEAD -- > "$dest/tracked.patch" || return 1
  fi
  if [ -n "$untracked" ]; then
    mkdir "$dest/untracked" || return 1
    # NUL-separated end to end, and copied as what they are: `cp -a` keeps a
    # symlink a symlink rather than following it out of the tree.
    (cd "$checkout" && git_ ls-files -z --others --exclude-standard \
      | xargs -0 -r cp -a --parents -t "$dest/untracked" --) || return 1
  fi
  {
    echo "Saved by the ClawBox updater on $stamp (UTC), before it reset"
    echo "  $checkout"
    echo "to the code it was updating to. Nothing here was changed; it is what the"
    echo "checkout held on top of commit $base ($branch)."
    echo
    echo "What is here: $summary."
    echo
    if [ -n "$tracked" ]; then
      echo "Put the changes to tracked files back (git tells you about any conflict):"
      echo "  cd $checkout && git apply --3way $dest/tracked.patch"
      echo
    fi
    if [ -n "$untracked" ]; then
      echo "Put the new files back:"
      echo "  cp -a $dest/untracked/. $checkout/"
      echo
    fi
    echo "STATUS lists every file as 'git status --short' showed it. The updater keeps"
    echo "the newest $keep saves in $save_root and removes older ones."
  } > "$dest/README.txt" || return 1
}

# Root never writes the copy into a directory another account controls: the
# default save root sits beside the checkout, in /home/clawbox, where a planted
# symlink would redirect root's writes (the primitive persist_update_branch_pin
# refuses too). The callers drop to the checkout's owner first, so root only
# gets here over a tree root owns (an operator's own clone) or one whose owning
# uid has no account any more — use_tree_owner_for_git then leaves git running
# as root, deliberately. Either way the edits go into the checkout's own stash
# below instead of stopping the update: a refusal here fired on CLEAN trees too
# and made such a box unable to update at all.
use_dir=1
if [ "$(id -u)" = "0" ]; then
  if [ -n "$owner_uid" ] && [ "$owner_uid" != "0" ]; then
    echo "preserve-local-edits: running as root over $checkout, which uid $owner_uid owns — not writing a copy as root; using the checkout's git stash" >&2
    use_dir=0
  elif [ -L "$save_root" ] || [ "$(stat -c %u "$(dirname "$save_root")" 2>/dev/null || echo x)" != "0" ]; then
    echo "preserve-local-edits: not writing into $(dirname "$save_root") as root — another account owns it; using the checkout's git stash" >&2
    use_dir=0
  fi
fi

saved=""
if [ "$use_dir" = "1" ] && mkdir -p "$save_root" 2>/dev/null; then
  dest="$save_root/$stamp"
  n=1
  # Two saves in one second (the bootstrap and the sync of the same run both
  # asking) get a suffix rather than sharing a directory.
  while ! mkdir "$dest" 2>/dev/null; do
    n=$((n + 1))
    if [ "$n" -gt 50 ] || [ ! -e "$dest" ]; then dest=""; break; fi
    dest="$save_root/$stamp-$n"
  done
  if [ -n "$dest" ]; then
    if save_to_directory "$dest"; then
      saved="$dest"
    else
      echo "preserve-local-edits: could not write the copy in $dest" >&2
      rm -rf "$dest"
    fi
  fi
fi

if [ -n "$saved" ]; then
  # Keep the newest $keep. Only names this script writes, only real
  # directories — never a symlink planted beside them.
  find "$save_root" -mindepth 1 -maxdepth 1 -type d \
      -regextype posix-extended -regex '.*/[0-9]{8}T[0-9]{6}Z(-[0-9]+)?' -printf '%f\n' 2>/dev/null \
    | sort | head -n "-$keep" \
    | while IFS= read -r old; do rm -rf "${save_root:?}/$old"; done
  echo "  Saved this box's local code changes ($summary) to $saved"
  echo "CLAWBOX-WARN[local-edits-saved]: This box had local changes to its code ($summary). They were saved to $saved before the update reset the code — README.txt there says how to put them back."
  echo "CLAWBOX-LOCAL-EDITS: $saved"
  exit 0
fi

# The copy could not be made. The checkout's own stash is on the same disk and
# survives every reset the update performs, so it is the next-best place — and
# it is SAID, never silent. The identity is given rather than inherited: a stash
# is a commit, and the clawbox account on a box has no git identity of its own.
message="clawbox-update $stamp: local edits the updater could not copy to $save_root"
if git_ -c user.name="ClawBox updater" -c user.email="updater@clawbox.invalid" \
     stash push --include-untracked --message "$message" >/dev/null 2>&1; then
  echo "  Could not copy the local code changes out; kept them in the checkout's git stash instead"
  echo "CLAWBOX-WARN[local-edits-saved]: This box had local changes to its code ($summary). They could not be copied to $save_root, so they were kept in the code's git stash (\"clawbox-update $stamp\") — run: git -C $checkout stash list"
  echo "CLAWBOX-LOCAL-EDITS: git-stash"
  exit 0
fi

echo "Error: $checkout has local changes ($summary) that could not be saved to $save_root or to git stash — is the disk full? Nothing was reset." >&2
exit 3
