import { NextRequest, NextResponse } from "next/server";

import { ClawKeepError, clawKeepErrorBody, setSnapshotLabel } from "@/lib/clawkeep";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

// POST /setup-api/clawkeep/snapshots/label
// Body: { name: "<object>", label: "<text>" } — an empty/missing label
// clears the snapshot's name. Spawns `clawkeep label` which rewrites the
// sidecar manifest (no S3 object copy).
export async function POST(request: NextRequest) {
  // OWNER ONLY, and from OUR page. Middleware admits the MCP bearer on every
  // /setup-api route (so the agent can reach the device's own API), and the
  // browser attaches the owner's cookie to a POST any other site fires at the
  // box. Renaming a snapshot is neither the agent's to do nor another
  // page's — so the gate asks both questions and refuses on either, before
  // the body is read.
  if (!(await hasOwnerSession(request)) || !isSameOriginRequest(request)) {
    return NextResponse.json(
      {
        error: "Labelling a snapshot needs a signed-in browser session on this ClawBox's own pages.",
        code: "owner_only",
        // `kind` beside `code`: every other refusal on the clawkeep routes
        // (clawKeepErrorBody, a locked snapshot, needs_passphrase, the setup
        // route's own owner_only) is keyed `kind`, so the one field a surface
        // already reads carries this refusal too.
        kind: "owner_only",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
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
      clawKeepErrorBody(err, "Failed to set label"),
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
