import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { hasOwnerSession } from "@/lib/owner-session";
import { CodingAgentError, MAX_TASK_CHARS, createDraftRun, deleteDraftRun, httpStatusForCodingError } from "@/lib/coding-agent";
import { runLifecycleRoute } from "@/lib/coding-agent-route";

export const dynamic = "force-dynamic";

/**
 * POST { task, projectId? | directory?, provider?, model? } → create a run to
 * start LATER. The record is validated the way a start is, but nothing spawns
 * — it sits in the list as "draft" until /start runs it or DELETE discards it.
 *
 * The account is frozen here rather than at /start, like the effort and the
 * ceilings: the owner may change their default in between, and the draft on
 * the list already says which one it will use.
 */
export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  let body: { task?: unknown; projectId?: unknown; directory?: unknown; provider?: unknown; model?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const task = typeof body?.task === "string" ? body.task : "";
  if (!task.trim()) {
    return NextResponse.json({ error: "A task is required.", kind: "invalid" }, { status: 400 });
  }
  if (task.length > MAX_TASK_CHARS) {
    return NextResponse.json(
      { error: `The task is too long: at most ${MAX_TASK_CHARS} characters.`, kind: "invalid" },
      { status: 413 },
    );
  }
  const source = (await hasOwnerSession(request)) ? "owner" : "agent";
  try {
    const run = await createDraftRun({
      task,
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      directory: typeof body.directory === "string" ? body.directory : null,
      provider: body.provider,
      model: body.model,
      source,
    });
    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    if (err instanceof CodingAgentError) {
      return NextResponse.json({ error: err.message, kind: err.kind }, { status: httpStatusForCodingError(err.kind) });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not draft the coding run" },
      { status: 500 },
    );
  }
}

/** DELETE ?runId= → discard a draft. Drafts only; finished runs are history. */
export const DELETE = runLifecycleRoute({
  verb: "discard",
  noun: "draft",
  idFrom: "query",
  act: (id) => {
    deleteDraftRun(id);
    return NextResponse.json({ ok: true });
  },
});
