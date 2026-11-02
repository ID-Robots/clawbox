export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { hasPersonSession } from "@/lib/owner-session";
import { CLAWAI_ROW, signOutOfProvider } from "@/lib/provider-sign-out";

/**
 * "Sign out of ClawBox AI" — the ClawBox AI row's sign-out as PR #1369 shipped
 * it, kept for anything that already calls it. Settings → AI now signs every
 * row out through POST /setup-api/providers/sign-out, and this is that same
 * call for ClawBox AI (src/lib/provider-sign-out.ts), on either harness.
 *
 * POST → 200 { signedOut: true, changed, gatewayRestarting } once the box
 * holds no ClawBox AI credential and no record of the account behind it.
 * `changed: false` is a box that was already signed out.
 *
 * Refusals, with `kind`:
 * - 403 `owner_only`: OWNER ONLY, the rule of providers/enabled.
 * - 409 `sign_in_in_progress`: a device login is writing its token right now.
 * - 500 `still_signed_in`: something of the credential is still on the box,
 *   or a store could not be read to say it is gone.
 * - 502 `restart_refused`: the box is signed out on disk, but the harness
 *   could not be restarted to let go of the sign-in it is running with.
 */
export async function POST(request: Request) {
  if (!(await hasPersonSession(request))) {
    return NextResponse.json(
      { error: "Signing out of ClawBox AI needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }
  const result = await signOutOfProvider(CLAWAI_ROW);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, kind: result.kind },
      { status: result.kind === "still_signed_in" ? 500 : result.kind === "restart_refused" ? 502 : 409 },
    );
  }
  return NextResponse.json({ signedOut: true, changed: result.changed, gatewayRestarting: result.gatewayRestarting });
}
