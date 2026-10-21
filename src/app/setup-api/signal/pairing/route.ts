import { getActiveHarness } from "@/lib/harness";
import { handleGuidedPairing, previewGate } from "@/lib/guided-channel-routes";

export const dynamic = "force-dynamic";

/** Approve the DM pairing code a new Signal sender got from the bot. */
export async function POST(request: Request) {
  const gate = previewGate("signal");
  if (gate) return gate;
  return handleGuidedPairing(request, "signal", await getActiveHarness());
}
