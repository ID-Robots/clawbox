import { NextResponse } from "next/server";
import { getVersionInfo } from "@/lib/updater";

export const dynamic = "force-dynamic";

/**
 * Lightweight endpoint that always reports current/target versions for both
 * ClawBox and OpenClaw, regardless of update phase. Used by the desktop to
 * surface a "new version available" notification — the existing /update/status
 * route omits version info once `update_completed` has been persisted.
 */
export async function GET() {
  try {
    const versions = await getVersionInfo();
    return NextResponse.json(versions);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read versions" },
      { status: 500 },
    );
  }
}
