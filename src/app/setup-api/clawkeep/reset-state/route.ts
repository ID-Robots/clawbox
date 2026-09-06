import { NextRequest, NextResponse } from "next/server";

import { ClawKeepError, resetRunningState } from "@/lib/clawkeep";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

// POST /setup-api/clawkeep/reset-state — clear the "running" / upload-
// progress fields in state.json. Used by the dashboard's "Reset stuck
// backup" button when a daemon crash (systemd restart, OOM kill, manual
// SIGKILL during a `pip install`, …) left a stale heartbeat behind that
// the UI's idle-timeout heuristic would otherwise believe for hours.
//
// Preserves the historical "last successful" stats; only the in-flight
// fields are zeroed. Idempotent — safe to call when nothing is stuck.
export async function POST(request: NextRequest) {
  // Owner-only, on the person's own page: the middleware admits the MCP bearer
  // to every /setup-api route, and no MCP tool exists for this — the same gate
  // restore, unpair and the snapshot mutations carry (security scan #20).
  if (!(await hasOwnerSession(request)) || !isSameOriginRequest(request)) {
    return NextResponse.json(
      {
        error: "Resetting the backup state needs a signed-in browser session on this ClawBox's own pages.",
        code: "owner_only",
        kind: "owner_only",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    await resetRunningState();
    return NextResponse.json({ ok: true });
  } catch (err) {
    const status = err instanceof ClawKeepError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Reset failed" },
      { status },
    );
  }
}
