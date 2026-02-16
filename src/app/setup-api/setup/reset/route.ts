import { NextResponse } from "next/server";
import { set } from "@/lib/config-store";

export const dynamic = "force-dynamic";

const STEP_KEYS = [
  "setup_complete",
  "wifi_configured",
  "update_completed",
  "ai_model_configured",
  "ai_model_provider",
];

export async function POST() {
  try {
    for (const key of STEP_KEYS) {
      await set(key, undefined);
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Reset failed" },
      { status: 500 },
    );
  }
}
