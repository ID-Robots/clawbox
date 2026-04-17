import { NextResponse } from "next/server";
import { clearClawAiSession, isClawAiSessionExpired, readClawAiSession } from "@/lib/clawai-connect";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await readClawAiSession();
  if (!session) {
    return NextResponse.json({ status: "idle" }, { headers: { "Cache-Control": "no-store" } });
  }

  if (isClawAiSessionExpired(session)) {
    await clearClawAiSession();
    return NextResponse.json({
      status: "error",
      error: "ClawBox AI login expired. Please try again.",
    }, { headers: { "Cache-Control": "no-store" } });
  }

  return NextResponse.json({
    status: session.status,
    error: session.error ?? null,
  }, { headers: { "Cache-Control": "no-store" } });
}
