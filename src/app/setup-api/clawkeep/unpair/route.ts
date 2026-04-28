import { NextResponse } from "next/server";

import { ClawKeepError, deleteToken } from "@/lib/clawkeep";

export const dynamic = "force-dynamic";

// POST /setup-api/clawkeep/unpair — delete the local token. Does NOT
// revoke server-side; the user must also delete the token from the portal
// dashboard if they want it dead remotely. We keep this purely local so
// "unpair this device" is fast and offline-safe.
export async function POST() {
  try {
    await deleteToken();
    return NextResponse.json({ ok: true });
  } catch (err) {
    const status = err instanceof ClawKeepError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unpair failed" },
      { status },
    );
  }
}
