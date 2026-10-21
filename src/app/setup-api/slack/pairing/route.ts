import { getActiveHarness } from "@/lib/harness";
import { handleGuidedPairing } from "@/lib/guided-channel-routes";

export const dynamic = "force-dynamic";

/** Approve the DM pairing code a new Slack sender got from the bot. */
export async function POST(request: Request) {
  return handleGuidedPairing(request, "slack", await getActiveHarness());
}
