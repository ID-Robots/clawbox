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
#   2. Refuses to exec a tree it did not record. install.sh writes a root-owned
#      sha256 manifest of everything root runs on clawbox's behalf (install.sh,
#      scripts/, config/) at the end of every install and immediately after every
#      successful `git reset --hard` to the update branch; this script verifies it
#      before the exec below. Without that check, "clawbox may start
#      clawbox-root-update@chpasswd.service" also means "clawbox may choose the
#      program root runs", because install.sh is clawbox:clawbox 0755 inside a
#      clawbox-writable directory — a one-step local root. See
#      clawbox-root-manifest.sh for what the record does and does not cover.
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
ollama_install llamacpp_install llamacpp_model chromium_install ai_tools_install
coding_harness vnc_install vnc_refresh openclaw_setup openclaw_install
openclaw_patch openclaw_config openclaw_models openclaw_tts edition_lock
edition_foreign_teardown hermes_install hermes_edition network_setup
set_hostname setup_config system_config git_pull build rebuild rebuild_reboot
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

if ! contains "$step" "$ALLOWED_STEPS"; then
  echo "clawbox-root-step: step not permitted: $step" >&2
  exit 64
fi

if [ ! -f "$ENTRYPOINT" ]; then
  echo "clawbox-root-step: $ENTRYPOINT is missing" >&2
  exit 66
fi

# Verify BEFORE the exec, and for every step including the update family. An
# update legitimately replaces the covered files — but it does so from inside
# install.sh, after this gate, and re-records them as it goes. So a device whose
# tree still matches its record updates normally, while one where the clawbox
# user edited install.sh (or any script a step runs as root) cannot turn a
# granted unit into root: the step fails here instead.
#
# Fail-closed on a missing helper too. install.sh installs the helper, writes the
# manifest and only THEN (re)installs this dispatcher, so "no helper" means a
# half-installed device, not an older one.
if [ ! -x "$MANIFEST_HELPER" ]; then
  echo "clawbox-root-step: $MANIFEST_HELPER is missing — cannot tell what root is about to run" >&2
  echo "clawbox-root-step: recover with: sudo bash $ENTRYPOINT --step systemd_services" >&2
  exit 65
fi
if ! "$MANIFEST_HELPER" --verify; then
  echo "clawbox-root-step: refusing '$step' — $PROJECT_DIR does not match the root-exec manifest." >&2
  echo "clawbox-root-step: root will not run code it did not record. If this is a deliberate" >&2
  echo "clawbox-root-step: local change, re-record it as the operator: sudo bash $ENTRYPOINT --step systemd_services" >&2
  exit 65
fi

if contains "$step" "$SELF_UPDATING_STEPS"; then
  export CLAWBOX_ALLOW_SELF_UPDATE=1
else
  # Pin this run to the on-disk copy: no fetch, no reset --hard, no re-exec.
  export CLAWBOX_INSTALL_BOOTSTRAPPED=1
fi

exec /bin/bash "$ENTRYPOINT" --step "$step"
