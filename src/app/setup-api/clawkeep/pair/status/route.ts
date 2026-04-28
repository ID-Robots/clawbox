import { NextResponse } from "next/server";

import {
  clearClawKeepSession,
  isClawKeepSessionExpired,
  readClawKeepSession,
} from "@/lib/clawkeep-connect";

export const dynamic = "force-dynamic";

// Mirrors src/app/setup-api/ai-models/clawai/status/route.ts. Polled by
// the desktop ClawKeep app while a pairing is in flight.
export async function GET() {
  try {
    const session = await readClawKeepSession();
    if (!session) {
      return NextResponse.json({ status: "idle" }, { headers: { "Cache-Control": "no-store" } });
    }
    if (isClawKeepSessionExpired(session)) {
      await clearClawKeepSession();
      return NextResponse.json(
        { status: "error", error: "ClawKeep pairing expired. Please try again." },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { status: session.status, error: session.error ?? null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { status: "error", error: err instanceof Error ? err.message : "Internal error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
