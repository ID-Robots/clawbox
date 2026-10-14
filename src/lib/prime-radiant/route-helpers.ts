/**
 * Shared bits of the `/setup-api/prime-radiant/*` routes: one JSON shape for
 * answers (never cached) and one for failures (`{ error, code }`).
 *
 * SERVER ONLY.
 */

import { NextResponse } from "next/server";

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
