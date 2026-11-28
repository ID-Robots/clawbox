import { NextResponse } from "next/server";
import { startDraftRun } from "@/lib/coding-agent";
import { runLifecycleRoute } from "@/lib/coding-agent-route";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * POST { runId } → start a drafted run now (202). The owner's drafts start only
 * for the owner. With every slot taken the draft is QUEUED instead — `queued:
 * true`, the record in status `queued` — and starts by itself in its turn.
 */
export const POST = runLifecycleRoute({
  verb: "start",
  noun: "draft",
  act: async (id, _body, request) => {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: "This can only be done from this ClawBox's own pages.", code: "cross_origin" }, { status: 403 });
    }
    const run = await startDraftRun(id);
    return NextResponse.json({ run, queued: run.status === "queued" }, { status: 202 });
  },
});
