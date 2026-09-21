import { NextRequest, NextResponse } from "next/server";

import {
  ClawKeepError,
  clawKeepErrorBody,
  deleteSnapshot,
  SnapshotLockedError,
} from "@/lib/clawkeep";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

// POST /setup-api/clawkeep/snapshots/delete
// Body: { name: "<object>" } — deletes the snapshot object + its manifest
// entry. Refused with 409 / kind:"locked" if the snapshot is locked, so the
// UI can prompt the user to "Unlock first".
export async function POST(request: NextRequest) {
  // OWNER ONLY, and from OUR page. Middleware admits the MCP bearer on every
  // /setup-api route (so the agent can reach the device's own API), and the
  // browser attaches the owner's cookie to a POST any other site fires at the
  // box. Deleting a snapshot is neither the agent's to do nor another
  // page's — so the gate asks both questions and refuses on either, before
  // the body is read.
  if (!(await hasOwnerSession(request)) || !isSameOriginRequest(request)) {
    return NextResponse.json(
      {
        error: "Deleting a snapshot needs a signed-in browser session on this ClawBox's own pages.",
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
      clawKeepErrorBody(err, "Failed to delete snapshot"),
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
