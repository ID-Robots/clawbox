export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { guardGoogleConnect, readGoogleConnectStatus } from "@/lib/google-connect";
import { googleWorkspaceOAuth } from "@/lib/oauth-config";

/**
 * /setup-api/google/connect — "Connect Google" (Calendar + Drive through
 * ClawBox's own Google client). 404 unless CLAWBOX_GOOGLE_CONNECT=1; owner only.
 *
 * GET: `{ configured, hermes, connected, ownClient, scopes, pending }` — see
 * GoogleConnectStatus. The tokens themselves never leave the box.
 */
export async function GET(req: Request) {
  const denied = await guardGoogleConnect(req, { write: false });
  if (denied) return denied;
  const status = await readGoogleConnectStatus(googleWorkspaceOAuth());
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}
