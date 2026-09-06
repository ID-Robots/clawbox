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
#   2. Refuses to exec a tree it did not record — for every step that is NOT an
#      update. install.sh writes a root-owned sha256 manifest of everything root
#      runs on clawbox's behalf (install.sh, scripts/, config/) at the end of
#      every install and immediately after every successful `git reset --hard` to
#      the update branch; this script verifies it before the exec below. Without
#      that check, "clawbox may start clawbox-root-update@chpasswd.service" also
#      means "clawbox may choose the program root runs", because install.sh is
#      clawbox:clawbox 0755 inside a clawbox-writable directory — a one-step
#      local root. See clawbox-root-manifest.sh for what the record does and does
#      not cover, and the comment on the check below for why the update family is
#      excluded.
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

set -euo pipefail

PROJECT_DIR="/home/clawbox/clawbox"
ENTRYPOINT="$PROJECT_DIR/install.sh"
MANIFEST_HELPER="/usr/local/libexec/clawbox/clawbox-root-manifest.sh"
RUN_DIR="/run/clawbox"

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
coding_harness vnc_install vnc_refresh openclaw_setup openclaw_install
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

if [ ! -f "$ENTRYPOINT" ]; then
  echo "clawbox-root-step: $ENTRYPOINT is missing" >&2
  exit 66
fi

if contains "$step" "$SELF_UPDATING_STEPS"; then
  export CLAWBOX_ALLOW_SELF_UPDATE=1
else
  # Pin this run to the on-disk copy: no fetch, no reset --hard, no re-exec.
  export CLAWBOX_INSTALL_BOOTSTRAPPED=1

  # ...and, because it is pinned, root must be able to say what "the on-disk
  # copy" is. Verify the record before the exec below.
  #
  # ONLY for the pinned steps, and that asymmetry is the whole design:
  #
  #   * These are the steps a foothold can reach and repeat — chpasswd,
  #     set_hostname, restart_ap, llamacpp_install are the four instances
  #     config/clawbox-sudoers grants. Nothing about them is supposed to change
  #     the covered files, so a mismatch is tampering and root refuses.
  #   * The update family is excluded because an update IS a legitimate rewrite
  #     of exactly these files, and it is not always install.sh that performs it:
  #     src/lib/updater.ts does its own fetch/reset/clean as the clawbox user
  #     before it starts the rebuild step, and scripts/force-update.sh does the
  #     same by hand. Verifying here would fail those flows at their next step
  #     and leave the device refusing every root step afterwards. Instead the
  #     update family re-records as its first action (install.sh's bootstrap
  #     block does it right after `git reset --hard`), which is also what heals
  #     a device whose tree was replaced from the outside.
  #   * That is not a hole the allow-list leaves open: TASK-445 removed every
  #     sudo grant for a self-updating instance, so `sudo systemctl start
  #     clawbox-root-update@git_pull.service` is denied. What can still reach
  #     them is the unscoped polkit `manage-units` grant, tracked as TASK-539 —
  #     and when that goes, the update path must NOT simply be re-granted
  #     through sudo without moving the git work itself to the root side.
  if [ ! -x "$MANIFEST_HELPER" ]; then
    echo "clawbox-root-step: $MANIFEST_HELPER is missing — cannot tell what root is about to run" >&2
    echo "clawbox-root-step: recover with: sudo bash $ENTRYPOINT --step systemd_services" >&2
    exit 65
  fi
  if ! manifest_helper_alive; then
    echo "clawbox-root-step: $MANIFEST_HELPER is installed but does nothing — it cannot tell what root is about to run" >&2
    echo "clawbox-root-step: recover with: sudo bash $ENTRYPOINT --step systemd_services" >&2
    exit 65
  fi
  if ! "$MANIFEST_HELPER" --verify; then
    echo "clawbox-root-step: refusing '$step' — $PROJECT_DIR does not match the root-exec manifest." >&2
    echo "clawbox-root-step: root will not run code it did not record. If this is a deliberate" >&2
    echo "clawbox-root-step: local change, re-record it as the operator: sudo bash $ENTRYPOINT --step systemd_services" >&2
    exit 65
  fi

  # COPY, then check the copy, then run the copy.
  #
  # Verifying $ENTRYPOINT and then exec'ing $ENTRYPOINT is a race: bash opens
  # the file after the check returns, and the clawbox user can replace it in
  # between — a rewrite loop wins that window easily. Hashing a copy that
  # clawbox cannot reach removes the window for the one file this script
  # executes directly.
  #
  # /run is tmpfs and root-owned, so the copy cannot survive a reboot and cannot
  # be touched by clawbox. The name is fixed rather than mktemp'd because `exec`
  # replaces this shell and no EXIT trap would ever fire to clean it up.
  STAGED_ENTRYPOINT="$RUN_DIR/root-step-install.sh"
  if ! install -d -o root -g root -m 0700 "$RUN_DIR"; then
    echo "clawbox-root-step: cannot create $RUN_DIR" >&2
    exit 66
  fi
  rm -f "$STAGED_ENTRYPOINT"
  if ! install -o root -g root -m 0500 "$ENTRYPOINT" "$STAGED_ENTRYPOINT"; then
    echo "clawbox-root-step: cannot stage $ENTRYPOINT for execution" >&2
    exit 66
  fi
  if ! "$MANIFEST_HELPER" --verify-file install.sh "$STAGED_ENTRYPOINT"; then
    rm -f "$STAGED_ENTRYPOINT"
    echo "clawbox-root-step: refusing '$step' — install.sh changed between the check and the copy." >&2
    exit 65
  fi
  ENTRYPOINT="$STAGED_ENTRYPOINT"

  # Residual, recorded rather than implied: the scripts install.sh goes on to run
  # as root (scripts/start-ap.sh, launch-browser.sh, setup-hermes-edition.sh, …)
  # are covered by the --verify above but are opened LATER, by install.sh itself,
  # so the same window exists for them. Closing it means the tree install.sh
  # reads from being root-owned too — the follow-up this design is pointed at,
  # and a bigger change than a copy of one file. TASK-445.
fi

exec /bin/bash "$ENTRYPOINT" --step "$step"
