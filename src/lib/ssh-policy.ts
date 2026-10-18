/**
 * The web side of the SSH policy hand-off (install.sh::step_ssh_policy).
 *
 * SSH is off by default; the owner turns it on in Settings → System → Remote
 * access (src/app/setup-api/system/ssh/route.ts), and a factory reset asks the
 * root side to remove the owner's password and switch SSH off
 * (src/app/setup-api/setup/reset/route.ts). Either writes ONE word to
 * {@link SSH_POLICY_REQUEST_PATH} at mode 0600 and starts the `ssh_policy`
 * root step, which reads the file once, removes it and acts. The root side
 * refuses `enable` unless /etc/shadow holds an owner's password.
 *
 * Keep the path and the words aligned with install.sh — both ends must agree,
 * or the step refuses while the route reports success.
 */
import fs from "fs/promises";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import path from "@/lib/runtime-path";
import { DATA_DIR } from "@/lib/config-store";
import { startRootStep } from "@/lib/root-step-runner";

const execFile = promisify(execFileCb);

export const SSH_POLICY_REQUEST_PATH = path.join(DATA_DIR, ".ssh-policy-request");
export const SSH_POLICY_STEP = "ssh_policy";

export type SshPolicyRequest = "enable" | "disable" | "factory_reset";

/** Write the one-word request and run the root step; throws when it fails. */
export async function requestSshPolicy(request: SshPolicyRequest, timeoutMs = 30_000): Promise<void> {
  await fs.mkdir(path.dirname(SSH_POLICY_REQUEST_PATH), { recursive: true });
  try {
    await fs.writeFile(SSH_POLICY_REQUEST_PATH, request, { mode: 0o600 });
    await startRootStep(SSH_POLICY_STEP, { timeoutMs });
  } catch (err) {
    await fs.unlink(SSH_POLICY_REQUEST_PATH).catch(() => {});
    throw err;
  }
}

/** Is sshd running right now? `systemctl is-active` needs no privilege. */
export async function isSshActive(): Promise<boolean> {
  try {
    const { stdout } = await execFile("/usr/bin/systemctl", ["is-active", "ssh"], { timeout: 5_000 });
    return stdout.trim() === "active";
  } catch {
    // is-active exits non-zero for every state but "active".
    return false;
  }
}
