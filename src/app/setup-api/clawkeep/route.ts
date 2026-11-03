import { NextResponse } from "next/server";

import { ClawKeepError, getStatus } from "@/lib/clawkeep";

export const dynamic = "force-dynamic";

// GET /setup-api/clawkeep → unified status snapshot used by ClawKeepApp.tsx.
// Sub-actions live under /setup-api/clawkeep/{config,backup,unpair,pair/*}.
//
// `serverNowMs` is the box's clock as the answer leaves: the page measures its
// own clock against it (`src/lib/box-clock.ts`), so "Last backup: just now" is
// judged against the clock that wrote `lastBackupAtMs`, not the browser's.
export async function GET() {
  try {
    const body = await getStatus();
    return NextResponse.json({ ...body, serverNowMs: Date.now() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const statusCode = err instanceof ClawKeepError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load ClawKeep status" },
      { status: statusCode, headers: { "Cache-Control": "no-store" } },
    );
  }
}
