import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { readSlackManifest } from "@/lib/slack-manifest";

export const dynamic = "force-dynamic";

/** The Slack app manifest for the active harness, for pasting at api.slack.com/apps. */
export async function GET() {
  try {
    return NextResponse.json(await readSlackManifest(await getActiveHarness()));
  } catch (err) {
    console.error("[slack/manifest] failed:", err);
    return NextResponse.json({ error: "Manifest unavailable" }, { status: 500 });
  }
}
