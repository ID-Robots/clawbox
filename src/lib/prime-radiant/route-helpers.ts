/**
 * Shared bits of the `/setup-api/prime-radiant/*` routes: one JSON shape for
 * answers (never cached) and one for failures (`{ error, code }`).
 *
 * SERVER ONLY.
 */

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function fail(code: string, error: string, status: number): NextResponse {
  return json({ error, code }, status);
}

/** A failure inside the vault layer, logged with its reason and answered without it. */
export function vaultFailure(where: string, err: unknown): NextResponse {
  console.error(`[prime-radiant] ${where}:`, err instanceof Error ? err.message : err);
  return fail("vault_unavailable", "The Prime Radiant vault could not be read.", 500);
}

/**
 * The gate every mutating Prime Radiant route keeps: a session (owner or the
 * MCP bearer, through `requireSession`), then the owner's own browser cookie
 * (the bearer is refused 403 `owner_only`), then our own page (a cross-site
 * form riding the cookie is refused 403 `cross_origin`). Null when admitted.
 */
export async function ownerWriteGuard(req: Request, what: string): Promise<NextResponse | null> {
  const denied = await requireSession(req);
  if (denied) return denied;
  if (!(await hasOwnerSession(req))) return fail("owner_only", `${what} needs a signed-in browser session.`, 403);
  if (!isSameOriginRequest(req)) return fail("cross_origin", "This request did not come from the ClawBox desktop.", 403);
  return null;
}
