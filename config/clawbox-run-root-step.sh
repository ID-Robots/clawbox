#!/usr/bin/env bash
#
# The web server's one way to start a root update step.
#
# Until TASK-539 this went through polkit: src/lib/updater.ts and
# /setup-api/install/run-step called `/usr/bin/systemctl start
# clawbox-root-update@<step>.service` with no sudo at all, and
# config/49-clawbox-updates.pkla authorised it. That grant is
# `org.freedesktop.systemd1.manage-units` with no unit condition — `.pkla` on
# polkit 0.105 (what JetPack ships) cannot express one — and manage-units is the
# action systemd checks for StartTransientUnit. So it was `systemd-run /bin/sh
# -c …`: arbitrary root, no password, for the account the web server, the in-UI
# terminal and the agent's shell all run as. It made the whole sudoers allow-list
# bypassable, which is why it had to go rather than be narrowed.
#
# sudoers CAN express a scope, so the operation moves here: one root-owned
# entrypoint, granted once, that decides for itself which unit it will start.
# The scoped polkit twin this replaces said the same thing —
# config/49-clawbox-updates.rules restricts to `clawbox-root-update@` — but only
# polkit >= 0.106 reads it.
#
# What this deliberately does NOT do: take a unit name. It takes a STEP name,
# from a list narrower than the dispatcher's, and builds the unit itself. The
# dispatcher (clawbox-root-step.sh) validates the step again on the other side
# and is the authority on what root then runs; this is the outer bound on what
# the WEB SERVER may ask for.
#
# Usage (root, from a sudoers grant):
#   clawbox-run-root-step.sh [--no-block] <step>
#
# Installed by install.sh::install_root_libexec to
# /usr/local/libexec/clawbox/clawbox-run-root-step.sh, root:root 0755.

set -euo pipefail

# Keep in step with WEB_ROOT_STEPS in src/lib/root-steps.ts —
# src/tests/unit/root-steps.test.ts fails the build otherwise. Every name here
# is a root entrypoint the web server can trigger without a password, so adding
# one is a privilege decision, not a config line.
WEB_ROOT_STEPS="
ai_tools_install apt_update bootstrap_updater chpasswd chromium_install
clawkeep_install cloudflared_install ffmpeg_install fix_git_perms gateway_setup
hermes_edition llamacpp_install nvidia_jetpack ollama_install openclaw_config
openclaw_install openclaw_patch openclaw_setup openclaw_tts performance_mode post_update
rebuild_reboot restart_ap set_hostname vnc_install vnc_refresh
"

NO_BLOCK=""
if [ "${1:-}" = "--no-block" ]; then
  NO_BLOCK="--no-block"
  shift
fi

step="${1:-}"
if [ "$#" -ne 1 ]; then
  echo "usage: $0 [--no-block] <step>" >&2
  exit 64
fi

# Reject anything that is not a plain step identifier before it reaches a unit
# name. systemd instance names cannot contain `/`, but they can contain plenty
# else, and this is the root side of the boundary.
case "$step" in
  *[!a-z0-9_]*|"")
    echo "clawbox-run-root-step: refusing malformed step name: $step" >&2
    exit 64
    ;;
esac

permitted=1
for allowed in $WEB_ROOT_STEPS; do
  if [ "$allowed" = "$step" ]; then
    permitted=0
    break
  fi
done
if [ "$permitted" -ne 0 ]; then
  echo "clawbox-run-root-step: step not permitted from the web server: $step" >&2
  exit 64
fi

service="clawbox-root-update@${step}.service"

# Clear a previous failure first, so a step that failed once is not permanently
# unstartable. Best-effort: a unit that never ran has nothing to reset.
/usr/bin/systemctl reset-failed "$service" >/dev/null 2>&1 || true

if [ -n "$NO_BLOCK" ]; then
  exec /usr/bin/systemctl start --no-block "$service"
fi
exec /usr/bin/systemctl start "$service"
