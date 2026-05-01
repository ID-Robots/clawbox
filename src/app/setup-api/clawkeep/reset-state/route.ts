import { NextResponse } from "next/server";

import { ClawKeepError, resetRunningState } from "@/lib/clawkeep";

export const dynamic = "force-dynamic";

// POST /setup-api/clawkeep/reset-state — clear the "running" / upload-
// progress fields in state.json. Used by the dashboard's "Reset stuck
// backup" button when a daemon crash (systemd restart, OOM kill, manual
// SIGKILL during a `pip install`, …) left a stale heartbeat behind that
// the UI's idle-timeout heuristic would otherwise believe for hours.
//
// Preserves the historical "last successful" stats; only the in-flight
// fields are zeroed. Idempotent — safe to call when nothing is stuck.
export async function POST() {
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
