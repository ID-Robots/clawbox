import { NextResponse } from "next/server";

import {
  clearClawKeepSession,
  isClawKeepSessionExpired,
  readClawKeepSession,
} from "@/lib/clawkeep-connect";

export const dynamic = "force-dynamic";

// Mirrors src/app/setup-api/ai-models/clawai/status/route.ts. The poll
// loop in ClawKeepApp drives /pair/poll directly; this endpoint is only
// for "what's the in-flight session look like right now?" — useful for
// page reloads mid-flow.
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
        { status: 410, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      {
        status: session.status,
        error: session.error ?? null,
        user_code: session.user_code,
        verification_url: session.verificationUrl,
        interval: session.interval,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // Log internally but never leak err.message to clients — it can carry
    // file paths or stack frames the user shouldn't see.
    console.error("[clawkeep/pair/status] internal error:", err);
    return NextResponse.json(
      { status: "error", error: "Internal server error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
