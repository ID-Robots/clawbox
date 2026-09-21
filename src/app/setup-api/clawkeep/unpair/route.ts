import { NextResponse } from "next/server";

import { ClawKeepError, unpairLocal } from "@/lib/clawkeep";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

// POST /setup-api/clawkeep/unpair — delete the local token. Does NOT
// revoke server-side; the user must also delete the token from the portal
// dashboard if they want it dead remotely. We keep this purely local so
// "unpair this device" is fast and offline-safe.
//
// Also clears any "running" leftover in state.json. Without this, a
// daemon that was killed mid-backup (systemd restart, OOM, …) leaves
// `last_heartbeat_status === "running"` behind, and re-pairing inherits
// the stuck spinner — the unpair → pair cycle silently fails to recover
// the dashboard.
export async function POST(request: Request) {
  // OWNER ONLY, and from OUR page. Middleware admits the MCP bearer on every
  // /setup-api route (so the agent can reach the device's own API), and the
  // browser attaches the owner's cookie to a POST any other site fires at the
  // box. Unpairing the device from its backups is neither the agent's to do nor another
  // page's — so the gate asks both questions and refuses on either, before
  // the body is read.
  if (!(await hasOwnerSession(request)) || !isSameOriginRequest(request)) {
    return NextResponse.json(
      {
        error: "Unpairing needs a signed-in browser session on this ClawBox's own pages.",
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
    await unpairLocal();
    return NextResponse.json({ ok: true });
  } catch (err) {
    const status = err instanceof ClawKeepError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unpair failed" },
      { status },
    );
  }
}
