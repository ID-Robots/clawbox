export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { readProviderStatus } from "@/lib/provider-status";

/**
 * Every provider's connected state, and which one is the default, in ONE call.
 *
 * The strip at the top of Settings → AI Provider reads this. One call rather
 * than one per provider is the whole point: the panel it replaces made the
 * customer select a provider before it would say anything about that provider,
 * so learning what the box was connected to cost a click per vendor.
 *
 * STATUSES ONLY. `readProviderStatus` returns a state string, a label and an
 * id per provider and nothing else — no keys, no tokens, no base URLs. Same
 * rule as `/setup-api/chat/capabilities`: the page needs to know whether a
 * provider works, not what the credential is.
 */
export async function GET() {
  const summary = await readProviderStatus();
  return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } });
}
