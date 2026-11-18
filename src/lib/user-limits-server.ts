/**
 * The owner's per-user limits (src/lib/user-limits.ts), read and written on
 * the server, and who a request is limited as. SERVER ONLY.
 */

import { get, getKnown, set } from "@/lib/config-store";
import { createSerialLock } from "@/lib/serial-lock";
import { USER_LIMITS_KEY, mbToBytes, userLimitsFrom, type UserLimits } from "@/lib/user-limits";

/**
 * The limits in force. A store that cannot be read gives the defaults — never
 * "no limits": a damaged data/config.json must not lift them.
 */
export async function readUserLimits(): Promise<UserLimits> {
  try {
    return userLimitsFrom(await get(USER_LIMITS_KEY));
  } catch {
    return userLimitsFrom(undefined);
  }
}

const withLimitsLock = createSerialLock();

/** Change some limits (already validated by `userLimitsPatch`); the limits now in force. */
export async function writeUserLimits(patch: Partial<UserLimits>): Promise<UserLimits> {
  return withLimitsLock(async () => {
    const { value, known } = await getKnown(USER_LIMITS_KEY);
    if (!known) throw new Error("the settings store could not be read");
    const next = { ...userLimitsFrom(value), ...patch };
    await set(USER_LIMITS_KEY, next);
    return next;
  });
}

/**
 * The signed-in ClawBox user a request is limited as, or null for the owner,
 * the agent's MCP bearer (it acts for the box) and a request with no session
 * — which middleware has already turned away from every route that asks.
 */
export async function limitedUserOf(request: Request): Promise<string | null> {
  // Loaded here: owner-session pulls auth.ts, which builds its secret path at
  // import, and the routes that import this module for the limits alone must
  // not carry that chain into their tests.
  const { personSession } = await import("@/lib/owner-session");
  const who = await personSession(request);
  return who && !who.isOwner ? who.username : null;
}

/** A user's upload ceiling in bytes, or null for none of ours. */
export function uploadLimitBytes(limits: UserLimits): number | null {
  return mbToBytes(limits.uploadMaxMb);
}

/** A user's home quota in bytes, or null for none. */
export function homeQuotaBytes(limits: UserLimits): number | null {
  return mbToBytes(limits.homeQuotaMb);
}
