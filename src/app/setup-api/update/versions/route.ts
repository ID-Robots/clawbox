import { NextResponse } from "next/server";
import { getVersionInfo, invalidateVersionCache } from "@/lib/updater";

export const dynamic = "force-dynamic";

/**
 * Lightweight endpoint that always reports current/target versions for both
 * ClawBox and OpenClaw, regardless of update phase. Used by the desktop to
 * surface a "new version available" notification — the existing /update/status
 * route omits version info once `update_completed` has been persisted.
 *
 * Pass `?force=1` to bypass the 60s in-process cache; the System Update
 * window does this on open and on the "Check for updates" button so the user
 * doesn't see a stale "Up to date" while a newer release is sitting on origin.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("force") === "1") invalidateVersionCache();
    const versions = await getVersionInfo();
    return NextResponse.json(versions);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read versions" },
      { status: 500 },
    );
  }
}
