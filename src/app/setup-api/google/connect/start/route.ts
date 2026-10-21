export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { guardGoogleConnect, startGoogleConnect } from "@/lib/google-connect";
import { harnessesHere } from "@/lib/clawbox-mcp-registration";
import { googleWorkspaceOAuth } from "@/lib/oauth-config";

/**
 * POST /setup-api/google/connect/start → `{ url }`, the Google consent page for
 * Calendar + Drive (drive.file). 404 unless CLAWBOX_GOOGLE_CONNECT=1; owner
 * only, same-origin. Its own state file: an AI-model sign-in in flight is left
 * as it is.
 */
export async function POST(req: Request) {
  const denied = await guardGoogleConnect(req, { write: true });
  if (denied) return denied;

  const config = googleWorkspaceOAuth();
  if (!config) {
    return NextResponse.json(
      { error: "ClawBox's Google sign-in is not set up on this box yet.", code: "not_configured" },
      { status: 503 },
    );
  }
  if (!harnessesHere().hermes) {
    return NextResponse.json(
      { error: "Calendar and Drive are used by the Hermes assistant, which this ClawBox does not run.", code: "no_hermes" },
      { status: 409 },
    );
  }

  try {
    return NextResponse.json(await startGoogleConnect(config));
  } catch (err) {
    console.error("[google-connect] start failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "The Google sign-in could not be started — the box could not save it.", code: "start_failed" },
      { status: 500 },
    );
  }
}
