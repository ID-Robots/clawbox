/**
 * The owner's "Share OpenClaw with all users" switch, read and written on the
 * server. What it opens and what it never does is src/lib/non-owner-scope.ts;
 * the routes that hold the gateway token ask {@link mayHaveGatewayToken}.
 *
 * Off unless the owner turned it on, so a box that never saw the switch keeps
 * the Control UI the owner's alone.
 */

import { get, set } from "@/lib/config-store";
import { OPENCLAW_SHARED_KEY, openclawSharedFrom } from "@/lib/non-owner-scope";
import type { SessionIdentity } from "@/lib/session-identity";

/** The switch as stored. A store that cannot be read shares nothing. */
export async function readOpenclawShared(): Promise<boolean> {
  try {
    return openclawSharedFrom(await get(OPENCLAW_SHARED_KEY));
  } catch {
    return false;
  }
}

export async function writeOpenclawShared(shared: boolean): Promise<void> {
  await set(OPENCLAW_SHARED_KEY, shared);
}

/**
 * May this signed-in person's page carry the gateway's token? The owner's
 * always; another ClawBox user's only while the owner shares OpenClaw.
 */
export async function mayHaveGatewayToken(person: Pick<SessionIdentity, "isOwner"> | null): Promise<boolean> {
  if (!person) return false;
  return person.isOwner || await readOpenclawShared();
}
