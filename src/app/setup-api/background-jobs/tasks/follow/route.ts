export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { backgroundTaskResponse, getBackgroundTask } from "@/lib/background-tasks";
import { requireSession } from "@/lib/route-auth";

/**
 * GET ?id=<task> — follow a running task again, as the NDJSON stream its
 * starting route answered with (`{status}`, `{completed,total}`, then one
 * `{success}` or `{error}`). This is how a reopened Settings re-attaches: the
 * panel that lost its stream when the window closed reads this one with the
 * reader it already has. A task that already ended answers its ending at once.
 *
 * Closing this stream unsubscribes; it never stops the work.
 */
export async function GET(req: Request) {
  const unauthorized = await requireSession(req);
  if (unauthorized) return unauthorized;

  const id = new URL(req.url).searchParams.get("id");
  if (!id || !getBackgroundTask(id)) {
    return NextResponse.json({ error: "No such task.", code: "unknown_task" }, { status: 404 });
  }
  return backgroundTaskResponse(id);
}
