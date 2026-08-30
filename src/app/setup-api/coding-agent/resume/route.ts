import { NextResponse } from "next/server";
import { resumeRun } from "@/lib/coding-agent";
import { runLifecycleRoute } from "@/lib/coding-agent-route";

export const dynamic = "force-dynamic";

/**
 * POST { runId } → resume a PAUSED run in place (same record, same session).
 * 202: the work carries on in the background, like a start. The ownership
 * gate mirrors /pause: only the owner resumes the owner's runs.
 */
export const POST = runLifecycleRoute({
  verb: "resume",
  act: async (id) => NextResponse.json({ run: await resumeRun(id) }, { status: 202 }),
});
