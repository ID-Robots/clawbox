export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { startOpenclawUpdate } from "@/lib/updater";

/**
 * Trigger an OpenClaw-only update — runs `openclaw_install` + `openclaw_patch`
 * via the existing root systemd template, then bounces the gateway. Reuses
 * the global update state so the existing UpdateOverlay UI shows progress.
 */
export async function POST() {
  try {
    const result = startOpenclawUpdate();
    if (!result.started) {
      return NextResponse.json(result, { status: 409 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to start OpenClaw update" },
      { status: 500 },
    );
  }
}
