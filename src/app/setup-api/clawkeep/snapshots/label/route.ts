import { NextRequest, NextResponse } from "next/server";

import { ClawKeepError, setSnapshotLabel } from "@/lib/clawkeep";

export const dynamic = "force-dynamic";

// POST /setup-api/clawkeep/snapshots/label
// Body: { name: "<object>", label: "<text>" } — an empty/missing label
// clears the snapshot's name. Spawns `clawkeep label` which rewrites the
// sidecar manifest (no S3 object copy).
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
    // `label` is optional — undefined/null clears it. A non-string is a bug
    // in the caller, so reject rather than coerce.
    const labelRaw = body.label;
    if (labelRaw !== undefined && labelRaw !== null && typeof labelRaw !== "string") {
      return NextResponse.json(
        { error: "'label' must be a string when provided" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const label = typeof labelRaw === "string" ? labelRaw : "";

    await setSnapshotLabel(name, label);
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const status = err instanceof ClawKeepError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to set label" },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
