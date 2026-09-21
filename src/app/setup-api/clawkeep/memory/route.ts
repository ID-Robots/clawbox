import { NextResponse } from "next/server";

import { getMemoryStatus } from "@/lib/clawkeep-memory";

export const dynamic = "force-dynamic";

/**
 * Embedding and index health for the ClawKeep UI.
 *
 * Never 500s on a sick box: `getMemoryStatus` already turns an unreachable or
 * unparseable `openclaw memory status` into an explicit `unavailable` status.
 * A panel that renders "unavailable" is useful; one that renders an error
 * toast tells the owner nothing about their index.
 */
export async function GET() {
  const status = await getMemoryStatus();
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}
