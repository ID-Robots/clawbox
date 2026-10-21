export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import {
  applyGoogleSkill,
  finishGoogleConnect,
  guardGoogleConnect,
  readGoogleConnectStatus,
} from "@/lib/google-connect";
import { googleWorkspaceOAuth } from "@/lib/oauth-config";

/**
 * POST /setup-api/google/connect/exchange `{ redirect }` — the address the
 * browser landed on after Google's consent page (or its code alone). Exchanges
 * the code, stores the grant under HERMES_HOME for the google-workspace skill,
 * and re-applies the skill switch. Answers the new status; the tokens stay on
 * the box. 404 unless CLAWBOX_GOOGLE_CONNECT=1; owner only, same-origin.
 */
export async function POST(req: Request) {
  const denied = await guardGoogleConnect(req, { write: true });
  if (denied) return denied;

  let pasted: string;
  try {
    const body: unknown = await req.json();
    const value = typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as { redirect?: unknown }).redirect
      : undefined;
    if (typeof value !== "string" || !value.trim()) {
      return NextResponse.json({ error: "Paste the address Google sent you to.", code: "bad_body" }, { status: 400 });
    }
    pasted = value;
  } catch {
    return NextResponse.json({ error: "Invalid JSON.", code: "bad_body" }, { status: 400 });
  }

  const config = googleWorkspaceOAuth();
  if (!config) {
    return NextResponse.json(
      { error: "ClawBox's Google sign-in is not set up on this box yet.", code: "not_configured" },
      { status: 503 },
    );
  }

  let result;
  try {
    result = await finishGoogleConnect(config, pasted);
  } catch (err) {
    console.error("[google-connect] the grant could not be stored:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Google said yes, but the box could not save the sign-in. Start again.", code: "store_failed" },
      { status: 500 },
    );
  }
  if (!result.ok) {
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }

  const applied = await applyGoogleSkill();
  const status = await readGoogleConnectStatus(config);
  if (applied.error) {
    return NextResponse.json({ ...status, applied: false, error: applied.error, code: "apply_failed" }, { status: 502 });
  }
  return NextResponse.json({ ...status, applied: applied.applied });
}
