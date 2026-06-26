import { NextRequest, NextResponse } from "next/server";

import { ClawKeepError, lockSnapshot, unlockSnapshot } from "@/lib/clawkeep";

export const dynamic = "force-dynamic";

// POST /setup-api/clawkeep/snapshots/lock
// Body: { name: "<object>", locked: boolean } — locks (true) or unlocks
// (false) the snapshot in the sidecar manifest. A locked snapshot can't be
// deleted manually or by auto-cleanup until it's unlocked.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const name = body.name;
    if (typeof name !== "string" || !name) {
      return NextResponse.json(
        { error: "'name' is required" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (typeof body.locked !== "boolean") {
      return NextResponse.json(
        { error: "'locked' must be a boolean" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    if (body.locked) {
      await lockSnapshot(name);
    } else {
      await unlockSnapshot(name);
    }
    return NextResponse.json(
      { ok: true, locked: body.locked },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const status = err instanceof ClawKeepError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update lock" },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
