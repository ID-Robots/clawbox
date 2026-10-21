export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import {
  applyGoogleSkill,
  disconnectGoogle,
  guardGoogleConnect,
  readGoogleConnectStatus,
} from "@/lib/google-connect";
import { googleWorkspaceOAuth } from "@/lib/oauth-config";

/**
 * POST /setup-api/google/connect/disconnect — revoke the grant "Connect Google"
 * made (best effort), remove it from the box, and put the google-workspace
 * skill back on `skills.disabled`. A grant made with the owner's own Google
 * client is refused with 409 and left alone. 404 unless
 * CLAWBOX_GOOGLE_CONNECT=1; owner only, same-origin.
 */
export async function POST(req: Request) {
  const denied = await guardGoogleConnect(req, { write: true });
  if (denied) return denied;

  const config = googleWorkspaceOAuth();
  let result;
  try {
    result = await disconnectGoogle(config);
  } catch (err) {
    console.error("[google-connect] disconnect failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "The Google sign-in could not be removed from the box.", code: "disconnect_failed" },
      { status: 500 },
    );
  }
  if (!result.ok) {
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }

  const applied = await applyGoogleSkill();
  const status = await readGoogleConnectStatus(config);
  const body = { ...status, revoked: result.revoked, applied: applied.applied };
  if (applied.error) {
    return NextResponse.json({ ...body, error: applied.error, code: "apply_failed" }, { status: 502 });
  }
  return NextResponse.json(body);
}
