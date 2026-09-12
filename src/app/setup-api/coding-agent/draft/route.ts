import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { hasOwnerSession } from "@/lib/owner-session";
import { CodingAgentError, MAX_TASK_CHARS, ProviderChoiceError, createDraftRun, deleteDraftRun, httpStatusForCodingError } from "@/lib/coding-agent";
import { runLifecycleRoute } from "@/lib/coding-agent-route";

export const dynamic = "force-dynamic";

/**
 * POST { task, projectId? | directory?, provider?, model?, deliverable? } →
 * create a run to start LATER. The record is validated the way a start is, but
 * nothing spawns — it sits in the list as "draft" until /start runs it or
 * DELETE discards it.
 *
 * The account is frozen here rather than at /start, like the effort and the
 * ceilings: the owner may change their default in between, and the draft on
 * the list already says which one it will use.
 */
export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  let body: {
    task?: unknown; projectId?: unknown; directory?: unknown;
    provider?: unknown; model?: unknown; deliverable?: unknown;
  };
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
      // Validated when the draft is MADE, by the same reader the run route
      // hands it to — a deliverable this box will not accept is refused at the
      // keystroke rather than at the start hours later.
      deliverable: body.deliverable,
    });
    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    if (err instanceof CodingAgentError) {
      // The provider/model refusal carries a `code` beside the shared 400, so a
      // caller can tell "that pair is not on this box" from "that folder is not
      // allowed" — both are `kind: "invalid"`, and the MCP tool advises on the
      // wrong argument without it. Anything else answers exactly as before.
      const code = err instanceof ProviderChoiceError ? { code: err.code } : {};
      return NextResponse.json({ error: err.message, kind: err.kind, ...code }, { status: httpStatusForCodingError(err.kind) });
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
