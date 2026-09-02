/**
 * The web server's one way to start a root update step.
 *
 * Every caller used to run `/usr/bin/systemctl start
 * clawbox-root-update@<step>.service` with no sudo at all, and
 * `config/49-clawbox-updates.pkla` authorised it with
 * `org.freedesktop.systemd1.manage-units` and no unit condition — `.pkla` on
 * polkit 0.105 (what JetPack ships) cannot express one. That action is what
 * systemd checks for `StartTransientUnit`, so it was `systemd-run /bin/sh -c …`:
 * arbitrary root, no password, for the account the web server, the in-UI
 * terminal and the agent's shell all run as. It made the sudoers allow-list
 * bypassable, which is why it is gone rather than narrowed (TASK-539).
 *
 * sudoers can express a scope, so the operation goes through one root-owned
 * entrypoint instead: `/usr/local/libexec/clawbox/clawbox-run-root-step.sh`,
 * granted once, which validates the step against WEB_ROOT_STEPS and builds the
 * unit name itself. The root dispatcher validates it again on the far side.
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCb);

/** Installed by install.sh::install_root_libexec, root:root 0755. */
export const ROOT_STEP_LAUNCHER = "/usr/local/libexec/clawbox/clawbox-run-root-step.sh";

/**
 * Start `clawbox-root-update@<step>.service`.
 *
 * `sudo -n`, never a bare `sudo`: on a device whose allow-list is missing this
 * grant the call has to fail in milliseconds, not block a route handler on a
 * password prompt nobody can answer. The launcher clears a previous failure
 * itself, so callers do not need their own `reset-failed`.
 */
export async function startRootStep(
  step: string,
  opts: { noBlock?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const argv = ["-n", ROOT_STEP_LAUNCHER];
  if (opts.noBlock) argv.push("--no-block");
  argv.push(step);
  await execFile("/usr/bin/sudo", argv, { timeout: opts.timeoutMs ?? 30_000 });
}
