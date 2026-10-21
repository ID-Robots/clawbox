import { NextResponse } from "next/server";
import { get } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { readGuidedChannelStatus } from "@/lib/guided-channels";
import { previewGate } from "@/lib/guided-channel-routes";
import { teamsEndpoint } from "@/lib/msteams-endpoint";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = previewGate("msteams");
  if (gate) return gate;
  try {
    const harness = await getActiveHarness();
    // Where Teams must deliver is worth showing before the bot is set up too:
    // the owner needs it to register the bot's messaging endpoint.
    const endpoint = await teamsEndpoint(harness);
    const appId = await get("msteams_app_id");
    if (!appId || typeof appId !== "string") {
      return NextResponse.json({ configured: false, endpoint });
    }
    const live = await readGuidedChannelStatus(harness, "msteams");
    return NextResponse.json({ ...live, endpoint, account: appId, tokenRejected: false });
  } catch (err) {
    console.error("[msteams/status] failed:", err);
    return NextResponse.json({ error: "Status check failed" }, { status: 500 });
  }
}
