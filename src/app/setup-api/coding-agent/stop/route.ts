import { NextResponse } from "next/server";
import { cancelQueuedRun, getRun, stopRun } from "@/lib/coding-agent";
import { runLifecycleRoute } from "@/lib/coding-agent-route";
import { hasPersonSession } from "@/lib/owner-session";

export const dynamic = "force-dynamic";

/**
 * POST { runId } → ask a running coding run to stop; answers the run record.
 * Idempotent: a run that already finished is returned as it is. The session
 * check, the `id` alias, the 404 and the owner gate are the factory's — see
 * coding-agent-route.ts for why the agent's bearer gets a 403 on an owner's run.
 *
 * A QUEUED run has no process to stop: Stop takes it out of the queue
 * (`cancelQueuedRun`) — the OWNER's gesture alone, whoever queued it. The MCP
 * bearer may queue a run and read the queue, but a queue another caller could
 * empty would be no promise to the one who queued; it answers 403 `owner_only`.
 */
export const POST = runLifecycleRoute({
  verb: "stop",
  act: async (id, _body, request) => {
    if (getRun(id)?.status === "queued") {
      if (!(await hasPersonSession(request))) {
        return NextResponse.json({ error: "That run is waiting in the queue; only the owner can cancel a queued run.", kind: "owner_only" }, { status: 403 });
      }
      return NextResponse.json({ run: await cancelQueuedRun(id) });
    }
    return NextResponse.json({ run: stopRun(id) });
  },
});
