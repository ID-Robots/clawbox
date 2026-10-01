import os from "os";

/**
 * The box owner's Linux username: the install user across default,
 * sudo-launched and x64 setups. `getSystemUsername()` in src/lib/auth.ts is
 * this function; it lives on its own so middleware and src/lib/route-auth.ts —
 * which deliberately import neither auth.ts nor config-store — resolve the
 * owner exactly the way the login route does.
 */
export function ownerUsername(): string {
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
