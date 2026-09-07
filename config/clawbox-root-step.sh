#!/usr/bin/env bash
#
# Root entrypoint for clawbox-root-update@<step>.service.
#
# Installed by install.sh to /usr/local/libexec/clawbox/clawbox-root-step.sh as
# root:root 0755, under root-owned directories. That location matters: the unit
# used to ExecStart /home/clawbox/clawbox/install.sh directly, and every path
# component of that — the project dir, and install.sh itself — is writable by
# the clawbox user the web server runs as. install.sh even hands the tree back
# with `chown -R clawbox:clawbox` on every root run. So "clawbox may start
# clawbox-root-update@*.service" meant "clawbox may edit the file root is about
# to execute": a scoped NOPASSWD grant that is a one-step local root. TASK-445.
#
# This script cannot make install.sh itself immutable — the updater has to be
# able to replace it, and the app has to be able to build in the same tree — so
# it does the three things a root-owned entrypoint can:
#
#   1. Validates the instance name against its own allow-list. Even with the
#      sudoers grants enumerated per instance, systemd will happily start
#      `clawbox-root-update@anything.service`, so without this the step name is
#      unvalidated input on the root side of the boundary.
#
#   2. Never execs the tree. install.sh writes a root-owned sha256 manifest of
#      everything root runs on clawbox's behalf (install.sh, scripts/, config/)
#      at the end of every install and immediately after every successful `git
#      reset --hard` to the update branch, and keeps a root-owned MIRROR of the
#      same paths beside it. This script verifies the record and then execs the
#      MIRROR — so the file root opens is one the clawbox user cannot write, and
#      cannot swap between the check and the exec. Without that,
#      "clawbox may start clawbox-root-update@chpasswd.service" also means
#      "clawbox may choose the program root runs", because install.sh is
#      clawbox:clawbox 0755 inside a clawbox-writable directory — a one-step
#      local root.
#
#      The mirror is what closed TASK-733. The record alone could only ever
#      cover the PINNED steps: an update legitimately rewrites the recorded
#      files, so `bootstrap_updater`, `post_update` and `rebuild_reboot` were
#      exempt from the check and exec'd $PROJECT_DIR/install.sh with nothing
#      verified at all — while all three are startable by the web server
#      through config/clawbox-run-root-step.sh. Write install.sh, start the
#      step, and the payload ran as root in one move.
#
#      What makes the exemption safe now is WHEN the mirror is restaged: only
#      from a tree that still matches the record. A tree that changed because an
#      update replaced it is re-recorded by install.sh at that moment, so it
#      mirrors on the next dispatch; a tree that changed because something
#      rewrote install.sh matches nothing, is never copied, and root runs the
#      previous root-owned build. Both answers are "run the mirror". See
#      clawbox-root-manifest.sh for what the record and the mirror cover.
#
#   3. Decides whether this step may self-update. install.sh's bootstrap block
#      does `git fetch` + `git reset --hard origin/<branch>` + re-exec, and it
#      ran on EVERY `--step` — including `chpasswd`. A password change must not
#      reach out to the network, and must not be a way to pull new code onto the
#      box. Only the update family gets CLAWBOX_ALLOW_SELF_UPDATE=1; everything
#      else is pinned to the on-disk copy.
#
# Keep the two lists below in step with src/lib/root-steps.ts and install.sh's
# DISPATCH_STEPS — src/tests/unit/root-steps.test.ts fails the build otherwise.
# src/tests/unit/root-exec-mirror.test.ts fails if a step joins the exempt family
# without going through the mirror.

set -euo pipefail

PROJECT_DIR="/home/clawbox/clawbox"
TREE_ENTRYPOINT="$PROJECT_DIR/install.sh"
MANIFEST_HELPER="/usr/local/libexec/clawbox/clawbox-root-manifest.sh"
# Kept in step with MIRROR_DIR in clawbox-root-manifest.sh. The two files are
# installed separately and cannot share a constant — the same reason
# SELFTEST_TOKEN is repeated as a literal — so a test pins them together.
MIRROR_DIR="/var/lib/clawbox/root-exec-mirror"
ENTRYPOINT="$MIRROR_DIR/install.sh"

step="${1:-}"

if [ -z "$step" ]; then
  echo "clawbox-root-step: no step given" >&2
  exit 64
fi

# Reject anything that isn't a plain step identifier before it reaches a case
# match, a path, or a git ref.
case "$step" in
  *[!a-z0-9_]*)
    echo "clawbox-root-step: refusing malformed step name: $step" >&2
    exit 64
    ;;
esac

# Every step the root-update template is allowed to run. Mirrors install.sh's
# DISPATCH_STEPS.
ALLOWED_STEPS="
bootstrap_updater apt_update nvidia_jetpack performance_mode jtop_install
ollama_install llamacpp_install llamacpp_model embed_model chromium_install ai_tools_install
coding_harness codex_cli vnc_install vnc_refresh openclaw_setup openclaw_install
openclaw_patch openclaw_config openclaw_models openclaw_tts edition_lock
edition_foreign_teardown hermes_install hermes_edition network_setup
set_hostname set_timezone setup_config system_config git_pull build rebuild rebuild_reboot
restart restart_ap recover chpasswd gateway_setup ffmpeg_install polkit_rules
systemd_services directories_permissions captive_portal_dns desktop_theme
fix_git_perms browser_launch cloudflared_install nm_dispatcher sysctl_linkdown
post_update update_smoke validate_services clawkeep_install
"

# Steps allowed to run install.sh's git fetch / reset --hard self-update.
SELF_UPDATING_STEPS="
bootstrap_updater git_pull build rebuild rebuild_reboot post_update update_smoke
"

contains() {
  local needle="$1" haystack="$2" item
  for item in $haystack; do
    [ "$item" = "$needle" ] && return 0
  done
  return 1
}

# Does the manifest helper actually run, or is it only present?
#
# An empty or half-copied helper exits 0 for every verb without doing any of
# them — see SELFTEST_TOKEN in clawbox-root-manifest.sh for how one gets there.
# Reading that 0 turns this gate from fail-closed into fail-OPEN: the exec below
# would run /home/clawbox/clawbox as root on the word of a program that hashed
# nothing, and that tree is writable by the unprivileged user the web server
# runs as. Which is the whole of TASK-445.
#
# Two answers count, and both prove the same thing — the verb dispatcher at the
# bottom of the helper ran: the token from a helper that knows --selftest, or
# exit 64 from an older one rejecting a verb it does not know. A stub does
# neither: it prints nothing and exits 0.
#
# This file is the side of that comparison that can be OLDER than the helper:
# install_root_libexec installs the helper unconditionally and this dispatcher
# only if the manifest write succeeded. So the token below is a wire format —
# see SELFTEST_TOKEN in clawbox-root-manifest.sh. Changing it there without
# adding the old value as a second accepted answer here would make this refuse a
# healthy helper, fleet-wide.
manifest_helper_alive() {
  local out rc=0
  out="$("$MANIFEST_HELPER" --selftest 2>/dev/null)" || rc=$?
  [ "$out" = "clawbox-root-manifest alive" ] && return 0
  [ "$rc" -eq 64 ] && return 0
  return 1
}

if ! contains "$step" "$ALLOWED_STEPS"; then
  echo "clawbox-root-step: step not permitted: $step" >&2
  exit 64
fi

# There is deliberately NO check that $TREE_ENTRYPOINT exists.
#
# It used to be a hard exit 66, from when this script exec'd it. Root does not
# read it any more — it is only quoted in the repair hints below — and keeping
# the check would leave a box whose install.sh was lost (a power cut mid-checkout,
# a botched manual restore) unable to run `git_pull` or `bootstrap_updater` to
# restore itself, even though the mirror holds an install.sh whose step_git_pull
# would re-clone. The mirror exists to remove root's dependence on that tree.

# The verifier has to work before ANY step, not just the pinned ones.
#
# It used to be probed only inside the pinned branch, because only that branch
# read an exit status from it. The mirror gives the update family a stake in it
# too: `--mirror` is the verb that decides which bytes root executes, and a
# 0-byte or half-copied helper answers it with a clean 0 without copying
# anything (see SELFTEST_TOKEN in clawbox-root-manifest.sh). Reading that 0
# would leave root exec'ing whatever happens to sit at the mirror path on the
# word of a program that copied nothing.
if [ ! -x "$MANIFEST_HELPER" ]; then
  echo "clawbox-root-step: $MANIFEST_HELPER is missing — cannot tell what root is about to run" >&2
  echo "clawbox-root-step: recover with: sudo bash $TREE_ENTRYPOINT --step systemd_services" >&2
  exit 65
fi
if ! manifest_helper_alive; then
  echo "clawbox-root-step: $MANIFEST_HELPER is installed but does nothing — it cannot tell what root is about to run" >&2
  echo "clawbox-root-step: recover with: sudo bash $TREE_ENTRYPOINT --step systemd_services" >&2
  exit 65
fi

# Does $PROJECT_DIR still hold exactly what root recorded? Asked ONCE, and both
# branches below turn on the answer.
tree_matches_record=0
if "$MANIFEST_HELPER" --verify >/dev/null 2>&1; then
  tree_matches_record=1
fi

if contains "$step" "$SELF_UPDATING_STEPS"; then
  export CLAWBOX_ALLOW_SELF_UPDATE=1
else
  # Pin this run to the on-disk copy: no fetch, no reset --hard, no re-exec.
  export CLAWBOX_INSTALL_BOOTSTRAPPED=1

  # ...and, because it is pinned, root must be able to say what "the on-disk
  # copy" is. A mismatch here is tampering: these are the steps a foothold can
  # reach and repeat — chpasswd, set_hostname, restart_ap, llamacpp_install are
  # the four instances config/clawbox-sudoers grants — and nothing about them is
  # supposed to change the covered files. So root refuses, loudly, with the
  # command that re-records the tree as the operator.
  #
  # The update family does NOT refuse here, and that asymmetry is still the
  # design: an update IS a legitimate rewrite of exactly these files, and it is
  # not always install.sh that performs it (src/lib/updater.ts does its own
  # fetch/reset/clean as the clawbox user before the rebuild step, and
  # scripts/force-update.sh does the same by hand). Refusing would fail those
  # flows at their next step and leave the device refusing every root step
  # afterwards. What the family gets instead is the mirror below — the previous
  # root-established build — rather than the tree.
  if [ "$tree_matches_record" -ne 1 ]; then
    echo "clawbox-root-step: refusing '$step' — $PROJECT_DIR does not match the root-exec manifest." >&2
    echo "clawbox-root-step: root will not run code it did not record. If this is a deliberate" >&2
    echo "clawbox-root-step: local change, re-record it as the operator: sudo bash $TREE_ENTRYPOINT --step systemd_services" >&2
    exit 65
  fi
fi

# Restage the mirror from the tree — but only while the tree is still what root
# recorded, whichever family this step belongs to.
#
# EVERY dispatch, not once at install time: the mirror has to follow the tree
# through an update or `post_update` would keep applying the fixups of the build
# before it, and a mirror written once and trusted forever is the probe-once
# defect wearing a different hat. It is also idempotent — the same walk over the
# same bytes — so the healthy path costs one directory copy and changes nothing.
#
# A failure is NOT fatal on its own. The mirror already on disk is a previous
# root-established build, which is a worse answer than the current one and a far
# better answer than the tree; the pinned branch catches a stale copy one check
# below, and an update that ran the previous install.sh converges on its next
# pass. Refusing here instead would turn a full /var into an appliance that
# cannot update itself out of it.
if [ "$tree_matches_record" -eq 1 ]; then
  if ! "$MANIFEST_HELPER" --mirror; then
    echo "clawbox-root-step: WARNING: could not restage $MIRROR_DIR — running the copy already there" >&2
  fi
elif [ -f "$ENTRYPOINT" ]; then
  # SAID, not inferred from silence. Running the previous build's install.sh —
  # and the previous build's units, sudoers and scripts with it — is the right
  # answer here, but a box can sit in this state for a whole update while the
  # updater reports success, so the journal has to carry the reason. The two
  # ordinary causes are an update in flight (src/lib/updater.ts hard-resets and
  # cleans the tree as clawbox before rebuild_reboot, and scripts/force-update.sh
  # does the same by hand) and a tree something rewrote.
  echo "clawbox-root-step: $PROJECT_DIR does not match the root-exec manifest — running the mirror staged $(date -u -r "$ENTRYPOINT" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo 'at an unknown time')" >&2
fi

if [ ! -f "$ENTRYPOINT" ]; then
  echo "clawbox-root-step: refusing '$step' — there is no root-owned copy of install.sh at $MIRROR_DIR." >&2
  echo "clawbox-root-step: root will not fall back to $PROJECT_DIR: that tree is writable by the" >&2
  echo "clawbox-root-step: unprivileged user the web server runs as, which is the whole point of the mirror." >&2
  echo "clawbox-root-step: recover with: sudo bash $TREE_ENTRYPOINT --step systemd_services" >&2
  exit 65
fi

if [ "$tree_matches_record" -eq 1 ] && ! contains "$step" "$SELF_UPDATING_STEPS"; then
  # Check the copy root is about to run, not the path it verified.
  #
  # `--verify` answers a question about $PROJECT_DIR and the answer is stale the
  # moment it returns — the clawbox user can replace a file between the check
  # and the exec, and a rewrite loop wins that window easily. Hashing the MIRROR
  # closes it for good: those bytes are root-owned, so nothing can change them
  # after the check, and they are the bytes that run.
  #
  # This also covers what the old single-file staging under /run left as a
  # recorded residual: the scripts install.sh goes on to hand to bash as root
  # (start-ap.sh, launch-browser.sh, setup-hermes-edition.sh, …) are opened
  # LATER, by install.sh itself. They now come out of the mirror too — install.sh
  # resolves scripts/ and config/ relative to the directory it was started from.
  if ! "$MANIFEST_HELPER" --verify-file install.sh "$ENTRYPOINT"; then
    echo "clawbox-root-step: refusing '$step' — $MIRROR_DIR does not hold the install.sh that was recorded." >&2
    echo "clawbox-root-step: recover with: sudo bash $TREE_ENTRYPOINT --step systemd_services" >&2
    exit 65
  fi
fi

exec /bin/bash "$ENTRYPOINT" --step "$step"
