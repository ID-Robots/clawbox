export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { startOpenclawUpdate, startWouldOverlapUpdate } from "@/lib/updater";
import { requireSession } from "@/lib/route-auth";
import { hasPersonSession } from "@/lib/owner-session";

/**
 * Trigger an OpenClaw-only update — runs `openclaw_install` + `openclaw_patch`
 * via the existing root systemd template, then bounces the gateway. Reuses
 * the global update state so the existing UpdateOverlay UI shows progress.
 *
 * A person's click only, checked here as update/run checks for itself: the
 * agent's MCP bearer passes middleware, and an update it asks for goes through
 * update/request and the owner's Confirm (4.3 bug 2).
 */
export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  if (!(await hasPersonSession(request))) {
    return NextResponse.json(
      { error: "An OpenClaw update needs a signed-in browser session.", code: "owner_only" },
      { status: 403 },
    );
  }

  try {
    // The full update's in-flight check (update/run): beside a restarted
    // server's update this run would also release that update's desktop lock.
    if (await startWouldOverlapUpdate()) {
      return NextResponse.json({ started: false, error: "Update already in progress" }, { status: 409 });
    }
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
