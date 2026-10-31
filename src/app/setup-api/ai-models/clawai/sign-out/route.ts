export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { signOutOfClawboxAi } from "@/lib/clawai-sign-out";
import { hasPersonSession } from "@/lib/owner-session";

/**
 * "Sign out of ClawBox AI" — Settings → AI, the ClawBox AI row.
 *
 * POST → 200 { signedOut: true, changed, gatewayRestarting } once the box
 * holds no ClawBox AI credential and no record of the account behind it
 * (src/lib/clawai-sign-out.ts, which reads that back). `changed: false` is a
 * box that was already signed out — the same answer, nothing done.
 *
 * Refusals, with `kind`:
 * - 403 `owner_only`: OWNER ONLY. Middleware admits every /setup-api/* call
 *   on the MCP bearer, and the agent holds that bearer; signing the box out
 *   of its AI account is the owner's, the same rule as providers/enabled.
 * - 409 `not_supported`: the Hermes edition, whose sign-out is not built.
 * - 409 `sign_in_in_progress`: a device login is writing its token right now.
 * - 500 `still_signed_in`: something of the credential is still on the box.
 */
export async function POST(request: Request) {
  if (!(await hasPersonSession(request))) {
    return NextResponse.json(
      { error: "Signing out of ClawBox AI needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }
  const result = await signOutOfClawboxAi();
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, kind: result.kind },
      { status: result.kind === "still_signed_in" ? 500 : 409 },
    );
  }
  return NextResponse.json({ signedOut: true, changed: result.changed, gatewayRestarting: result.gatewayRestarting });
}
