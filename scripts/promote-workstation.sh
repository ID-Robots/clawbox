#!/usr/bin/env bash
# Promote a commit that was tested on a ClawBox Workstation to the Workstation
# update channel: move the `workstation` branch on GitHub to it (TASK-2602).
#
# Workstations update from `workstation` and nothing else
# (src/lib/update-channel.ts). Nothing moves that branch automatically — no CI
# job, no merge. This script is the one way it moves, and only by hand, after
# the commit was installed and tested on a Workstation. docs/workstation-update-channel.md
# is the procedure around it.
#
# Usage:
#   scripts/promote-workstation.sh <40-hex sha> [--remote <name|url>] [--rollback] [--push]
#
#   <sha>       the full commit sha that was tested (a branch name is refused:
#               it can move between the test and the promotion)
#   --remote    where `workstation` lives; default `origin`
#   --rollback  allow a move that is not a fast-forward (going back to an
#               older tested commit after a bad promotion)
#   --push      actually move the branch; without it this is a dry run that
#               prints what it would do and changes nothing
#
# Refuses, without pushing anything, when the commit is not on the remote's
# beta or main (a Workstation only ever runs code that is in the shared
# history), when the move is not a fast-forward and --rollback was not given,
# or when the branch moved on the remote while this ran (the push carries a
# lease on the tip it read, so two promotions at once cannot overwrite each
# other).
#
# Exit codes: 0 promoted / dry run / already there, 1 refused, 2 usage.

set -euo pipefail

BRANCH=workstation
SOURCES=(beta main)
SOURCES_TEXT="beta or main"

usage() {
  sed -n '2,/^$/p' "$0" | sed -n '/^# Usage:/,/^# Exit codes/p' | sed 's/^# \{0,1\}//' >&2
  exit 2
}

die() {
  echo "promote-workstation: $*" >&2
  exit 1
}

sha=""
remote="origin"
rollback=0
push=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --remote)
      [ "$#" -ge 2 ] || usage
      remote="$2"
      shift 2
      ;;
    --rollback) rollback=1; shift ;;
    --push) push=1; shift ;;
    -h|--help) usage ;;
    -*) echo "promote-workstation: unknown option $1" >&2; usage ;;
    *)
      [ -z "$sha" ] || usage
      sha="$1"
      shift
      ;;
  esac
done

[ -n "$sha" ] || usage
{ [ "${#sha}" -eq 40 ] && [[ "$sha" =~ ^[0-9a-f]+$ ]]; } \
  || die "\"$sha\" is not a full 40-character commit sha. Promote the exact commit that was tested (git rev-parse <ref>), never a branch name."
case "$remote" in
  -*|"") die "\"$remote\" is not a remote name or URL." ;;
esac

git rev-parse --git-dir >/dev/null 2>&1 || die "run this from a checkout of the ClawBox repository."

# One read of the remote's branches: the ones a promoted commit must be on,
# and the workstation branch's current tip (empty when it does not exist yet).
heads="$(git ls-remote --heads "$remote" "${SOURCES[@]/#/refs/heads/}" "refs/heads/$BRANCH")" \
  || die "could not read the branches of $remote."
tip_of() {
  printf '%s\n' "$heads" | awk -v ref="refs/heads/$1" '$2 == ref { print $1; exit }'
}
current="$(tip_of "$BRANCH")"

# The objects. The refspecs name no destination, so nothing here depends on
# what the fetch writes: the tips used below are the ones ls-remote read
# (git may still refresh refs/remotes/<remote>/* through the remote's own
# configured refspec, as any fetch does).
fetch_refs=()
for src in "${SOURCES[@]}" "$BRANCH"; do
  if [ -n "$(tip_of "$src")" ]; then fetch_refs+=("refs/heads/$src"); fi
done
[ "${#fetch_refs[@]}" -gt 0 ] || die "$remote has none of beta, main or $BRANCH."
git fetch --quiet --no-tags "$remote" "${fetch_refs[@]}" || die "could not fetch from $remote."

git cat-file -e "${sha}^{commit}" 2>/dev/null \
  || die "$sha is not a commit $remote carries on $SOURCES_TEXT (it is not in this checkout after the fetch)."

on_source=""
for src in "${SOURCES[@]}"; do
  src_tip="$(tip_of "$src")"
  [ -n "$src_tip" ] || continue
  if git merge-base --is-ancestor "$sha" "$src_tip" 2>/dev/null; then
    on_source="$src"
    break
  fi
done
[ -n "$on_source" ] \
  || die "$sha is on neither $SOURCES_TEXT of $remote. Only a commit that is already in the shared history can go to Workstations: merge it first, test that commit, then promote it."

subject="$(git log -1 --format='%h %s' "$sha")"
echo "Commit:   $subject (on $on_source)"

if [ -z "$current" ]; then
  echo "Channel:  $remote has no $BRANCH branch yet; this creates it."
  lease="refs/heads/$BRANCH:"
elif [ "$current" = "$sha" ]; then
  echo "Channel:  $BRANCH is already at $sha. Nothing to do."
  exit 0
else
  echo "Channel:  $BRANCH is at $(git log -1 --format='%h %s' "$current")"
  if git merge-base --is-ancestor "$current" "$sha"; then
    count="$(git rev-list --count "$current..$sha")"
    echo "Move:     fast-forward, $count commit(s) reach Workstations:"
    git log --oneline --no-decorate -n 30 "$current..$sha"
    [ "$count" -le 30 ] || echo "          … and $((count - 30)) more"
  elif [ "$rollback" -eq 1 ]; then
    echo "Move:     NOT a fast-forward (--rollback): Workstations go to an older or other line."
    echo "          The updater refuses a harness downgrade on a box whose data a newer core wrote;"
    echo "          see docs/workstation-update-channel.md before rolling back over a harness pin."
  else
    die "moving $BRANCH from $current to $sha is not a fast-forward. Promote a descendant of the current tip, or pass --rollback to move back deliberately."
  fi
  lease="refs/heads/$BRANCH:$current"
fi

if [ "$push" -ne 1 ]; then
  echo "Dry run:  nothing was pushed. Run again with --push to move $BRANCH to $sha."
  exit 0
fi

git push --quiet --force-with-lease="$lease" "$remote" "$sha:refs/heads/$BRANCH" \
  || die "the push was refused ($BRANCH may have moved on $remote while this ran; nothing was changed by this run)."
echo "Promoted: $BRANCH on $remote is now $sha. Workstations offer it at their next update check."
