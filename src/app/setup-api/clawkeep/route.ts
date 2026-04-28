import { NextResponse } from "next/server";

import { ClawKeepError, getStatus } from "@/lib/clawkeep";

export const dynamic = "force-dynamic";

// GET /setup-api/clawkeep → unified status snapshot used by ClawKeepApp.tsx.
// Sub-actions live under /setup-api/clawkeep/{config,backup,unpair,pair/*}.
export async function GET() {
  try {
    const body = await getStatus();
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const statusCode = err instanceof ClawKeepError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load ClawKeep status" },
      { status: statusCode, headers: { "Cache-Control": "no-store" } },
    );
  }
}
