/**
 * Is there a real password on the OS account?
 *
 * data/config.json's `password_configured` flag is a cache, not the truth:
 * factory reset wipes it, a partial restore can drop it, and anything with a
 * write primitive into data/ can clear it. /etc/shadow is the authority.
 * TASK-444a turns on exactly that gap — with the flag falsy the credentials
 * route skips the `currentPassword` check and lets an unauthenticated caller
 * overwrite the owner's OS password.
 *
 * `passwd -S <user>` prints `<user> <status> ...` where status is
 *   P  = usable password set
 *   NP = no password
 *   L  = locked (either `!`-prefixed hash or `!` alone)
 * It reads /etc/shadow through the setuid helper, so it works as `clawbox`
 * for `clawbox`'s own account without sudo.
 */

import { execFile as execFileCb } from "child_process";
import os from "os";
import { promisify } from "util";

const execFile = promisify(execFileCb);

/**
 * The install user. Duplicated from `@/lib/auth`'s `getSystemUsername` rather
 * than imported so this module — which the in-handler auth guard depends on —
 * stays free of `@/lib/config-store`, whose module-scope DATA_DIR makes it a
 * common mock target in route tests.
 */
function systemUsername(): string {
  let osUsername: string | undefined;
  try {
    osUsername = os.userInfo().username;
  } catch {
    osUsername = undefined;
  }
  return process.env.CLAWBOX_USER
    || process.env.SUDO_USER
    || process.env.USER
    || osUsername
    || "clawbox";
}

const PASSWD_BIN = "/usr/bin/passwd";

/** Parse the second field of a `passwd -S` line. Exported for tests. */
export function parsePasswdStatus(stdout: string): boolean | null {
  const line = stdout.split("\n").find((l) => l.trim().length > 0);
  if (!line) return null;
  const status = line.trim().split(/\s+/)[1];
  if (status === "P") return true;
  if (status === "NP" || status === "L") return false;
  return null;
}

/**
 * `true`  — the account has a usable password
 * `false` — it demonstrably does not (NP / locked)
 * `null`  — couldn't tell (helper missing, permission denied, odd output)
 *
 * Callers must treat `null` as "unknown", never as "no password": on a box
 * where `passwd -S` is unavailable, answering `false` would re-open the very
 * initial-set path this exists to close.
 */
export async function hasSystemPassword(user: string = systemUsername()): Promise<boolean | null> {
  try {
    const { stdout } = await execFile(PASSWD_BIN, ["-S", user], { timeout: 5_000 });
    return parsePasswdStatus(stdout);
  } catch {
    return null;
  }
}
