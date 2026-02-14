import { NextResponse } from "next/server";
import { set } from "@/lib/config-store";

export async function POST() {
  try {
    const timestamp = new Date().toISOString();
    await set("setup_complete", true);
    await set("setup_completed_at", timestamp);
    return NextResponse.json({ success: true });
  } catch (err) {
    // Rollback on partial failure
    await set("setup_complete", undefined).catch(() => {});
    await set("setup_completed_at", undefined).catch(() => {});
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to complete setup",
      },
      { status: 500 }
    );
  }
}
