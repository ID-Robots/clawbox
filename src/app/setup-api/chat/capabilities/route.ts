import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { hasClawaiToken } from "@/lib/harness/credentials";
import type { HarnessFacts } from "@/lib/harness/capabilities";

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
    // Whether the installed `hermes` understands `chat --image`. Reported as
    // false until the version probe that answers it honestly lands: an attach
    // button shown on a guess would stage files into a turn that ignores them,
    // which is worse than no button at all.
    hermesSupportsImages: false,
  };
  return NextResponse.json({ harness, facts });
}
