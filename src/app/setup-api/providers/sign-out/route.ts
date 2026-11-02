export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { hasPersonSession } from "@/lib/owner-session";
import { signOutOfProvider, type ProviderSignOutRefusal } from "@/lib/provider-sign-out";

/** Each refusal's status: the owner's to fix (409), the box's (500/502), or no such row (404). */
const REFUSAL_STATUS: Record<ProviderSignOutRefusal, number> = {
  unknown_provider: 404,
  is_default: 409,
  default_unreadable: 409,
  sign_in_in_progress: 409,
  still_signed_in: 500,
  restart_refused: 502,
};

/**
 * "Sign out of <Provider>" — Settings → AI, any connected provider's row.
 *
 * POST { provider: string } (the row's id) → 200 { signedOut: true, provider,
 * changed, gatewayRestarting } once the box holds no credential for it and no
 * record of it (src/lib/provider-sign-out.ts, which reads that back), on
 * either harness. `changed: false` is a provider that was already signed out —
 * the same answer, nothing done.
 *
 * Refusals, with `kind`:
 * - 403 `owner_only`: OWNER ONLY. Middleware admits every /setup-api/* call
 *   on the MCP bearer, and the agent holds that bearer; signing the box out of
 *   an AI provider is the owner's, the same rule as providers/enabled.
 * - 404 `unknown_provider`: no cloud provider by that id (an on-device engine
 *   has no sign-in; it is turned off in Settings → Local AI).
 * - 409 `is_default`: the chat runs on it — make another provider the default
 *   first. ClawBox AI is the exception, as in #1369.
 * - 409 `default_unreadable`: the box could not read which provider is the
 *   default, so it did not risk signing the chat out from under itself.
 * - 409 `sign_in_in_progress`: a ClawBox AI device login is writing its token.
 * - 500 `still_signed_in`: something of the credential is still on the box,
 *   or a store could not be read to say it is gone.
 * - 502 `restart_refused`: signed out on disk, but the harness could not be
 *   restarted to let go of the sign-in it is running with.
 */
export async function POST(request: Request) {
  if (!(await hasPersonSession(request))) {
    return NextResponse.json(
      { error: "Signing out of an AI provider needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const fields = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as { provider?: unknown })
    : {};
  const provider = typeof fields.provider === "string" ? fields.provider.trim() : "";
  if (!provider) {
    return NextResponse.json({ error: "Invalid body. Expected { provider: string }." }, { status: 400 });
  }

  const result = await signOutOfProvider(provider);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, kind: result.kind }, { status: REFUSAL_STATUS[result.kind] });
  }
  return NextResponse.json({
    signedOut: true,
    provider,
    changed: result.changed,
    gatewayRestarting: result.gatewayRestarting,
  });
}
