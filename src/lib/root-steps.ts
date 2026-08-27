/**
 * Which `install.sh --step <name>` invocations the web server may start as
 * root, and which of them are allowed to touch the network and the source tree.
 *
 * The privilege hand-off is: clawbox-setup (User=clawbox) →
 * `systemctl start clawbox-root-update@<step>.service` → install.sh as root.
 * The sudoers grants name four exact instances (chpasswd, set_hostname,
 * restart_ap, llamacpp_install) — but systemd will start
 * `clawbox-root-update@anything.service` for anyone who can reach it by another
 * route, so the step name is still attacker-influenced input on the root side
 * of the boundary, and the only real check is whatever the root-owned
 * entrypoint does with it. That check lives in config/clawbox-root-step.sh,
 * which is installed root-owned outside the clawbox-writable tree; the lists
 * here are the same data for the TypeScript side, and `root-steps.test.ts` pins
 * the two together. TASK-445.
 */

/**
 * Every step the WEB SERVER can start as root, from anywhere — the UI buttons,
 * the updater, the wizard's hand-offs. This is the outer bound of that surface,
 * and it is deliberately narrower than install.sh's DISPATCH_STEPS (48) and than
 * the root dispatcher's own allow-list: those two also cover steps only an
 * operator ever runs by hand.
 *
 * It is enforced root-side by config/clawbox-run-root-step.sh, the single
 * command config/clawbox-sudoers grants for this purpose. Adding a name here is
 * adding a passwordless root entrypoint — review it as a privilege decision.
 * The two lists are pinned together by src/tests/unit/root-steps.test.ts.
 * TASK-539.
 */
export const WEB_ROOT_STEPS: readonly string[] = [
  "ai_tools_install",
  "apt_update",
  "bootstrap_updater",
  "chpasswd",
  "chromium_install",
  "clawkeep_install",
  "cloudflared_install",
  "ffmpeg_install",
  "fix_git_perms",
  "gateway_setup",
  "hermes_edition",
  "llamacpp_install",
  "nvidia_jetpack",
  "ollama_install",
  "openclaw_config",
  "openclaw_install",
  "openclaw_patch",
  "openclaw_setup",
  "performance_mode",
  "post_update",
  "rebuild_reboot",
  "restart_ap",
  "set_hostname",
  "vnc_install",
  "vnc_refresh",
];

export function isWebRootStep(step: string): boolean {
  return WEB_ROOT_STEPS.includes(step);
}

/**
 * Steps a UI button may start. A subset of WEB_ROOT_STEPS: anything that
 * reboots, rewrites networking or wipes state stays out, so a one-tap
 * escalation surface never exists.
 */
export const UI_ROOT_STEPS: readonly string[] = [
  "cloudflared_install",
  "vnc_install",
  "vnc_refresh",
  "chromium_install",
  "ai_tools_install",
  "ollama_install",
  "llamacpp_install",
  "ffmpeg_install",
  "openclaw_install",
  "openclaw_setup",
  "openclaw_patch",
  "openclaw_config",
  "clawkeep_install",
];

/**
 * Steps that are allowed to run install.sh's self-update bootstrap —
 * `git fetch` + `git reset --hard origin/<branch>` + re-exec.
 *
 * Everything else runs with `CLAWBOX_INSTALL_BOOTSTRAPPED=1` pre-set so the
 * bootstrap block is skipped. It used to run on EVERY `--step`, which meant a
 * password change reached out to the network and hard-reset the source tree
 * before touching /etc/shadow: the journal shows it firing for `chpasswd`,
 * `set_hostname` and `validate_services`. A credential change must not depend
 * on GitHub being reachable, and must not be a vector for pulling new code.
 * TASK-445.
 */
export const SELF_UPDATING_ROOT_STEPS: readonly string[] = [
  "bootstrap_updater",
  "git_pull",
  "build",
  "rebuild",
  "rebuild_reboot",
  "post_update",
  "update_smoke",
];

export function isUiRootStep(step: string): boolean {
  return UI_ROOT_STEPS.includes(step);
}

export function maySelfUpdate(step: string): boolean {
  return SELF_UPDATING_ROOT_STEPS.includes(step);
}
