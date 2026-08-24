import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { hasClawaiToken } from "@/lib/harness/credentials";
import type { HarnessFacts } from "@/lib/harness/capabilities";
import { hermesHasVisionRoute, hermesSupportsImages } from "@/lib/harness/hermes-features";
import { hermesCanStreamTurns } from "@/lib/hermes-dashboard-turn";

export const dynamic = "force-dynamic";

/**
 * What this box can actually do in chat, as facts rather than as answers.
 *
 * The chat surface turns these into capability flags with `capabilitiesFor`, a
 * pure function both the browser and the server can call, so a control is
 * never shown by one rule and served by another.
 *
 * Facts, not the values behind them: `hasClawaiToken` is a boolean precisely so
 * the device credential never travels to a browser. A page needs to know
 * whether the microphone can work, not what the token is.
 *
 * Session-gated by middleware along with the rest of `/setup-api/chat`.
 */
export async function GET() {
  const harness = await getActiveHarness();
  const facts: HarnessFacts = {
    hasClawaiToken: await hasClawaiToken(),
    // Whether the installed `hermes` understands `chat --image` — PROBED, once
    // per process, and only where the answer can matter. An attach button shown
    // on a guess would stage files into a turn that ignores them, which is
    // worse than no button at all.
    //
    // Not asked on an OpenClaw box: `hermes` may not be installed there at all,
    // and the probe would spend a spawn (and a failure) to compute a fact that
    // no OpenClaw capability reads.
    hermesSupportsImages: harness === "hermes" ? await hermesSupportsImages() : false,
    // The second half of the same question: whether anything on this box would
    // LOOK at the picture the flag above lets the turn carry. Read from
    // `auxiliary.vision.model`, which is the store the agent's own image
    // routing reads, through the mtime-keyed config memo — so linking ClawBox
    // AI flips it on the next re-probe rather than on the next restart.
    //
    // Not asked on an OpenClaw box, for the same reason as above: `hermes` may
    // not be installed there, and no OpenClaw capability reads this.
    hermesHasVisionRoute: harness === "hermes" ? await hermesHasVisionRoute() : false,
    // Whether a turn can go through the running dashboard and stream back,
    // rather than spawning a CLI whose answer only exists once it exits. Probed
    // by minting a WebSocket ticket — cheap, local, and the same door the turn
    // itself will use, so a yes here is a yes for the real thing.
    //
    // Not asked on an OpenClaw box: it has its own socket and its own streaming,
    // and `hermes` may not be installed there at all.
    hermesStreamsTurns: harness === "hermes" ? await hermesCanStreamTurns() : false,
  };
  return NextResponse.json({ harness, facts });
}
