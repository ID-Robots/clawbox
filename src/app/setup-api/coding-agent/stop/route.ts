import { NextResponse } from "next/server";
import { stopRun } from "@/lib/coding-agent";
import { runLifecycleRoute } from "@/lib/coding-agent-route";

export const dynamic = "force-dynamic";

/**
 * POST { runId } → ask a running coding run to stop; answers the run record.
 * Idempotent: a run that already finished is returned as it is. The session
 * check, the `id` alias, the 404 and the owner gate are the factory's — see
 * coding-agent-route.ts for why the agent's bearer gets a 403 on an owner's run.
 */
export const POST = runLifecycleRoute({
  verb: "stop",
  act: (id) => NextResponse.json({ run: stopRun(id) }),
});
