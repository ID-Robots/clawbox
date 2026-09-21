import { NextResponse } from "next/server";
import { pauseRun } from "@/lib/coding-agent";
import { runLifecycleRoute } from "@/lib/coding-agent-route";

export const dynamic = "force-dynamic";

/**
 * POST { runId } → pause a running coding run; answers the run record.
 * Same shape and the same ownership gate as /stop: the agent may pause its
 * own runs, only the owner may pause a run the owner started.
 */
export const POST = runLifecycleRoute({
  verb: "pause",
  act: (id) => NextResponse.json({ run: pauseRun(id) }),
});
