import { NextResponse } from "next/server";
import { startDraftRun } from "@/lib/coding-agent";
import { runLifecycleRoute } from "@/lib/coding-agent-route";

export const dynamic = "force-dynamic";

/** POST { runId } → start a drafted run now (202). The owner's drafts start only for the owner. */
export const POST = runLifecycleRoute({
  verb: "start",
  noun: "draft",
  act: async (id) => NextResponse.json({ run: await startDraftRun(id) }, { status: 202 }),
});
