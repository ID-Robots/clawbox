/**
 * Is there a real password on the OS account — and is it one an owner set?
 *
 * data/config.json's `password_configured` flag is a cache, not the truth:
 * factory reset wipes it, a partial restore can drop it, and anything with a
 * write primitive into data/ can clear it. /etc/shadow is the authority.
 * TASK-444a turns on exactly that gap — with the flag falsy the credentials
 * route skips the `currentPassword` check and lets an unauthenticated caller
 * overwrite the owner's OS password.
 *
 * But "there is a hash in /etc/shadow" is not the same as "someone owns this
 * box". Boxes flashed from older images (and stock not yet provisioned) still
 * carry the legacy image password, which is public, so a gate keyed on the
 * hash alone would lock the first-boot wizard out of them — wifi/connect,
 * update/run and system/credentials all answered 401 on such a box. A
 * provisioned box and a factory reset leave NO password at all (`L`/`NP`).
 * `hasOwnerPassword` below is the question the gates actually need answered.
 *
 * `passwd -S <user>` prints `<user> <status> ...` where status is
 *   P  = usable password set
 *   NP = no password
 *   L  = locked (either `!`-prefixed hash or `!` alone)
 * It reads /etc/shadow through the setuid helper, so it works as `clawbox`
 * for `clawbox`'s own account without sudo.
 */

import { execFile as execFileCb, spawn } from "child_process";
import os from "os";
import { promisify } from "util";

const execFile = promisify(execFileCb);

/**
 * The password older ClawBox images were built with. ClawBox never sets it
 * any more: provisioning and factory reset remove the password entirely, and
 * the hotspot uses per-device credentials from the box's sticker. It is only
 * recognised so a box flashed from an older image (and stock not yet
 * provisioned) is treated as unowned — it is public knowledge, so an account
 * still carrying it has no owner. Mirrored root-side by install.sh's SSH
 * policy, which never enables SSH on an account that still carries it.
 */
export const LEGACY_IMAGE_PASSWORD = "clawbox";

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
const UNIX_CHKPWD_BIN = "/usr/sbin/unix_chkpwd";

// PAM return codes unix_chkpwd exits with. Anything else (PAM_USER_UNKNOWN when
// the helper refuses to check another account, PAM_SYSTEM_ERR, a signal) means
// the check itself did not run, not that the password was wrong.
const PAM_SUCCESS = 0;
const PAM_AUTH_ERR = 7;

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

/**
 * Does the account's password verify as the legacy image password?
 *
 * `true`  — it does: the box was flashed from an older image and is unowned
 * `false` — it does not: somebody has set a password of their own
 * `null`  — couldn't tell (helper missing, refused, timed out)
 *
 * unix_chkpwd is setgid shadow and lets a process check its OWN account's
 * password, which is exactly what the web server (running as the install
 * user) needs here — it is the same helper the login page verifies against
 * (src/lib/auth.ts::verifyPassword). Nothing is logged on success; a mismatch
 * is logged to auth.log like any failed password check — which is why callers
 * consult the config flag first and only ask here when it says "no owner", so
 * the line only ever appears on a box whose flag and /etc/shadow disagree.
 */
export async function isLegacyImagePassword(user: string = systemUsername()): Promise<boolean | null> {
  return new Promise((resolve) => {
    // Everything inside the try: a spawn failure (helper missing, EACCES) must
    // resolve `null` rather than reject, so the gates above fail closed instead
    // of turning into a 500.
    try {
      // SIGKILL, not the default SIGTERM: unix_chkpwd installs SIG_IGN for
      // TERM/INT/QUIT/HUP (PAM's setup_signals), and Node sends `killSignal`
      // exactly once with no escalation — verified on-device, a TERM'd helper
      // just keeps running. With the default the 5 s deadline is decorative.
      const child = spawn(UNIX_CHKPWD_BIN, [user, "nonull"], {
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 5_000,
        killSignal: "SIGKILL",
      });
      child.on("error", (err) => {
        console.warn("[system-password] unix_chkpwd could not be spawned — cannot tell whether the legacy image password is set, failing closed:", err.message);
        resolve(null);
      });
      child.on("close", (code, signal) => {
        if (code === PAM_SUCCESS) resolve(true);
        else if (code === PAM_AUTH_ERR) resolve(false);
        else {
          // Any 401 the bootstrap gate answers from here is otherwise silent.
          console.warn(`[system-password] unix_chkpwd exited ${signal ? `by ${signal}` : `with code ${code}`} — cannot tell whether the legacy image password is set, failing closed`);
          resolve(null);
        }
      });
      // The helper can exit before it reads stdin (bad user, missing shadow
      // access); the resulting EPIPE must not surface as an unhandled error.
      child.stdin?.on("error", () => {});
      child.stdin?.end(LEGACY_IMAGE_PASSWORD + "\0");
    } catch {
      resolve(null);
    }
  });
}

/**
 * Does the OS account carry a password that identifies an OWNER — a usable
 * password that is not the published legacy image password?
 *
 * `true`  — yes: someone set this, and every sensitive route must fail closed
 * `false` — no: there is no password, or only the legacy image one, which
 *           anyone can already log in with. The box is nobody's yet and the
 *           first-boot wizard may claim it.
 * `null`  — /etc/shadow state could not be read at all (see hasSystemPassword)
 *
 * Fails closed on the second step: if shadow says a password exists but the
 * legacy-password check itself cannot run, the answer is `true`.
 */
export async function hasOwnerPassword(user: string = systemUsername()): Promise<boolean | null> {
  const usable = await hasSystemPassword(user);
  if (usable !== true) return usable;
  const isDefault = await isLegacyImagePassword(user);
  return isDefault !== true;
}
