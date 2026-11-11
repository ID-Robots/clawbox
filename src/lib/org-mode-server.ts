/**
 * The owner's organisation-box switch (`org_mode`), read and written on the
 * server. What it narrows is src/lib/org-mode.ts; the middleware and
 * production-server.js read the same key out of data/config.json themselves.
 *
 * Off unless the owner turned it on, so a home box keeps the desktop every
 * user had before.
 */

import { get, set } from "@/lib/config-store";
import { ORG_MODE_KEY, orgModeFrom } from "@/lib/org-mode";

/** The switch as stored. A store that cannot be read is a home box. */
export async function readOrgMode(): Promise<boolean> {
  try {
    return orgModeFrom(await get(ORG_MODE_KEY));
  } catch {
    return false;
  }
}

export async function writeOrgMode(on: boolean): Promise<void> {
  await set(ORG_MODE_KEY, on);
}
