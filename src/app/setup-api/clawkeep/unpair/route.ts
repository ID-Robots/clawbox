import { NextResponse } from "next/server";

import { ClawKeepError, deleteToken, resetRunningState } from "@/lib/clawkeep";

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
export async function POST() {
  try {
    await deleteToken();
    await resetRunningState().catch((err) => {
      console.warn("[unpair] could not reset state.json (continuing):", err);
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const status = err instanceof ClawKeepError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unpair failed" },
      { status },
    );
  }
}
