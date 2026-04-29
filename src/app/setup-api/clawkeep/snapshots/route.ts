import { NextResponse } from "next/server";

import { ClawKeepError, listCloudSnapshots } from "@/lib/clawkeep";

export const dynamic = "force-dynamic";

// GET /setup-api/clawkeep/snapshots
// Spawns `clawkeep snapshots` which mints fresh portal credentials and
// list-objects-v2's the user's R2 prefix. Newest first.
export async function GET() {
  try {
    const snapshots = await listCloudSnapshots();
    return NextResponse.json(
      { snapshots },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const status = err instanceof ClawKeepError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list snapshots" },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
