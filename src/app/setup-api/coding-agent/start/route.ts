import { NextResponse } from "next/server";
import { startDraftRun } from "@/lib/coding-agent";
import { runLifecycleRoute } from "@/lib/coding-agent-route";

export const dynamic = "force-dynamic";

/**
 * POST { runId } → start a drafted run now (202). The owner's drafts start only
 * for the owner. With every slot taken the draft is QUEUED instead — `queued:
 * true`, the record in status `queued` — and starts by itself in its turn.
 */
export const POST = runLifecycleRoute({
  verb: "start",
  noun: "draft",
  act: async (id) => {
    const run = await startDraftRun(id);
    return NextResponse.json({ run, queued: run.status === "queued" }, { status: 202 });
  },
});
