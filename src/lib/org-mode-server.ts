/**
 * The owner's organisation-box switch (`org_mode`), read and written on the
 * server. What it narrows is src/lib/org-mode.ts; the middleware and
 * production-server.js read the same key out of data/config.json themselves.
 *
 * Off unless the owner turned it on, so a home box keeps the desktop every
 * user had before.
 */

import { get, getKnown, set } from "@/lib/config-store";
import { ORG_MODE_KEY, orgModeFrom } from "@/lib/org-mode";

/** The switch as stored. A store that cannot be read is a home box. */
export async function readOrgMode(): Promise<boolean> {
  try {
    return orgModeFrom(await get(ORG_MODE_KEY));
  } catch {
    return false;
  }
}

/**
 * The switch as stored, or null when it could not be read at all — for a
 * caller that must fail closed rather than read a home box into a failure
 * (the login screen, which would otherwise list an organisation's staff).
 */
export async function readOrgModeStrict(): Promise<boolean | null> {
  // `get` reads an unreadable store as an empty one; `getKnown` says so.
  try {
    const { value, known } = await getKnown(ORG_MODE_KEY);
    return known ? orgModeFrom(value) : null;
  } catch {
    return null;
  }
}

export async function writeOrgMode(on: boolean): Promise<void> {
  await set(ORG_MODE_KEY, on);
}

/**
 * Is a member of staff on an organisation box asking? The switch first, so a
 * home box pays for no cookie verification; never the owner, never the
 * agent's bearer.
 */
export async function isOrgMemberRequest(request: Request): Promise<boolean> {
  if (!(await readOrgMode())) return false;
  // Loaded here, not at the top: owner-session pulls auth.ts, which builds its
  // secret path from config-store's DATA_DIR at import, and the routes that
  // import this module only for the switch must not carry that chain.
  const { personSession } = await import("@/lib/owner-session");
  const who = await personSession(request);
  return !!who && !who.isOwner;
}
