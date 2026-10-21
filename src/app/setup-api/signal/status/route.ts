import { NextResponse } from "next/server";
import { get } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { readGuidedChannelStatus } from "@/lib/guided-channels";
import { previewGate } from "@/lib/guided-channel-routes";
import { findSignalCli } from "@/lib/signal-cli";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = previewGate("signal");
  if (gate) return gate;
  try {
    // Whether signal-cli is on the box at all: without it there is nothing to
    // link with, and the pane says so instead of offering a QR code.
    const signalCli = (await findSignalCli()) !== null;
    const account = await get("signal_account");
    if (!account || typeof account !== "string") {
      return NextResponse.json({ configured: false, signalCli });
    }
    const live = await readGuidedChannelStatus(await getActiveHarness(), "signal");
    return NextResponse.json({ ...live, signalCli, account, tokenRejected: false });
  } catch (err) {
    console.error("[signal/status] failed:", err);
    return NextResponse.json({ error: "Status check failed" }, { status: 500 });
  }
}
