/**
 * The server-side OAuth token handoff file.
 *
 * One file with five call sites: the device-code flow (`oauth/device-poll`) and
 * the authorization-code flow (`oauth/exchange`) both write it, the configure
 * route consumes it, and both flow entry points (`oauth/device-start`,
 * `oauth/start`) clear it before starting a new sign-in.
 *
 * Its path and its lifetime live here so those call sites cannot describe the
 * same file differently — a second spelling of either is a divergence nobody
 * notices until the two disagree.
 */

import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "./config-store";

export const HANDOFF_TOKENS_PATH = path.join(DATA_DIR, "oauth-device-tokens.json");

/**
 * How long a sign-in may stay in flight. The configure route refuses handoff
 * material older than this, and the sweep below removes it.
 */
export const HANDOFF_TTL_MS = 15 * 60 * 1000;

/**
 * Best-effort removal of the handoff file. Called when a new flow starts and
 * when a flow ends without completing, so a sign-in leaves nothing behind.
 */
export async function clearHandoffTokens(): Promise<void> {
  await fs.unlink(HANDOFF_TOKENS_PATH).catch(() => {});
}

/**
 * Remove a handoff file older than the TTL. Past that age configure refuses it,
 * so the file has no reader left and its age alone is reason enough to drop it.
 *
 * Ages by mtime rather than by the `createdAt` the writers record inside the
 * file: this runs on a polled endpoint, and mtime costs one stat instead of a
 * read plus a parse. The two agree, because the file is written once by an
 * atomic rename and never updated in place.
 */
export async function sweepStaleHandoffTokens(): Promise<void> {
  try {
    const stat = await fs.stat(HANDOFF_TOKENS_PATH);
    if (Date.now() - stat.mtimeMs > HANDOFF_TTL_MS) {
      await clearHandoffTokens();
    }
  } catch {
    // No handoff file — nothing to sweep.
  }
}
