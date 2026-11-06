import { NextResponse } from "next/server";
import { getRun, httpStatusForCodingError, resumeRun } from "@/lib/coding-agent";
import { runLifecycleRoute } from "@/lib/coding-agent-route";
import { ownerStopRefusal, releaseOwnerStopHold } from "@/lib/coding-team";
import { hasPersonSession } from "@/lib/owner-session";

export const dynamic = "force-dynamic";

/**
 * POST { runId } → resume a PAUSED run in place (same record, same session).
 * 202: the work carries on in the background, like a start. The ownership
 * gate mirrors /pause: only the owner resumes the owner's runs. The bearer's
 * resume of a run on the work of a team of its own that the owner stopped —
 * one of that team's workers, or a run in its folder — is 409 `code:
 * "owner_stopped"` unless the body says `userAskedAgain: true`, as a start is
 * (coding-team.ts ownerStopRefusal).
 */
export const POST = runLifecycleRoute({
  verb: "resume",
  act: async (id, body, request) => {
    const run = (await hasPersonSession(request)) ? null : getRun(id);
    const work = run ? { directory: run.directory, text: run.task, runId: id } : null;
    const askedAgain = (body as { userAskedAgain?: unknown } | undefined)?.userAskedAgain === true;
    if (work && !askedAgain) {
      const held = ownerStopRefusal(work);
      if (held) return NextResponse.json({ error: held.message, kind: held.kind, code: held.code }, { status: httpStatusForCodingError(held.kind) });
    }
    const resumed = await resumeRun(id);
    if (work && askedAgain) releaseOwnerStopHold(work);
    return NextResponse.json({ run: resumed }, { status: 202 });
  },
});
