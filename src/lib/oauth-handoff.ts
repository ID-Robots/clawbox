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

/** What a completed sign-in left in the handoff file, checked. */
export interface HandoffTokens {
  provider: string | null;
  accessToken: string;
  refreshToken: string | null;
  /** Seconds, as the token endpoint answered it. */
  expiresIn: number | null;
  /** Anthropic only: the account the tokens belong to — a label. */
  accountEmail: string | null;
  createdAt: number;
}

/**
 * Read the handoff the way the configure route does — same TTL, same shape
 * rules — for a consumer that is not that route: the Anthropic account pool,
 * which takes a SECOND (third, …) Claude account from the very same sign-in
 * flow. Material that cannot be used is removed rather than left for every
 * retry to trip over; usable material is left for the caller to consume with
 * `clearHandoffTokens` once it has stored it.
 */
export async function readHandoffTokens(): Promise<{ ok: true; tokens: HandoffTokens } | { ok: false; error: string }> {
  let raw: string;
  try {
    raw = await fs.readFile(HANDOFF_TOKENS_PATH, "utf-8");
  } catch {
    return { ok: false, error: "No pending sign-in. Start it again." };
  }
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    parsed = value as Record<string, unknown>;
  } catch {
    await clearHandoffTokens();
    return { ok: false, error: "No pending sign-in. Start it again." };
  }
  const createdAt = typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt) ? parsed.createdAt : null;
  const age = createdAt === null ? null : Date.now() - createdAt;
  const access = typeof parsed.access_token === "string" ? parsed.access_token.trim() : "";
  if (!access || age === null || age < 0 || age > HANDOFF_TTL_MS || (parsed.provider !== undefined && typeof parsed.provider !== "string")) {
    await clearHandoffTokens();
    return { ok: false, error: "The sign-in is missing or has expired. Start it again." };
  }
  return {
    ok: true,
    tokens: {
      provider: typeof parsed.provider === "string" ? parsed.provider : null,
      accessToken: access,
      refreshToken: typeof parsed.refresh_token === "string" && parsed.refresh_token.trim() ? parsed.refresh_token.trim() : null,
      expiresIn: typeof parsed.expires_in === "number" && parsed.expires_in > 0 ? parsed.expires_in : null,
      accountEmail: typeof parsed.account_email === "string" ? parsed.account_email : null,
      createdAt: createdAt as number,
    },
  };
}
