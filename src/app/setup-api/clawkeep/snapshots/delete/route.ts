import { NextRequest, NextResponse } from "next/server";

import { ClawKeepError, deleteSnapshot, SnapshotLockedError } from "@/lib/clawkeep";

export const dynamic = "force-dynamic";

// POST /setup-api/clawkeep/snapshots/delete
// Body: { name: "<object>" } — deletes the snapshot object + its manifest
// entry. Refused with 409 / kind:"locked" if the snapshot is locked, so the
// UI can prompt the user to "Unlock first".
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

    await deleteSnapshot(name);
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof SnapshotLockedError) {
      // Distinct envelope so the UI distinguishes "locked, unlock first" from
      // a generic delete failure without parsing the message string.
      return NextResponse.json(
        { error: err.message, kind: err.kind },
        { status: err.status, headers: { "Cache-Control": "no-store" } },
      );
    }
    const status = err instanceof ClawKeepError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete snapshot" },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
