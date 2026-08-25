import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { hasOwnerSession } from "@/lib/owner-session";
import { CodingAgentError, MAX_TASK_CHARS, startRun } from "@/lib/coding-agent";

export const dynamic = "force-dynamic";

/**
 * POST { task, projectId? | directory?, resumeRunId? } → start a coding run.
 *
 * Answers 202 immediately with the run record; the work continues in the
 * background and is polled through GET /setup-api/coding-agent/runs. The MCP
 * client's default timeout is 8 s and OpenClaw reaps the MCP process after
 * ten idle minutes, so holding this request open for the run was never an
 * option.
 *
 * Agent-callable (bearer or cookie), but re-checked in-handler: starting a
 * process that edits files is a state change, and TASK-443's rule is that
 * every such route carries its own gate. The owner's consent is the switch
 * this route enforces — when it is off the answer is 409, which the MCP layer
 * maps to CONFLICT / do-not-retry (403 would read as "the device needs a
 * restart", 500 as "try again").
 */
const STATUS_FOR: Record<CodingAgentError["kind"], number> = {
  disabled: 409,
  not_ready: 409,
  busy: 409,
  invalid: 400,
  not_found: 404,
};

export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  let body: { task?: unknown; projectId?: unknown; directory?: unknown; resumeRunId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const task = typeof body.task === "string" ? body.task : "";
  if (!task.trim()) {
    return NextResponse.json({ error: "A task is required.", kind: "invalid" }, { status: 400 });
  }
  if (task.length > MAX_TASK_CHARS) {
    return NextResponse.json(
      { error: `The task is too long: at most ${MAX_TASK_CHARS} characters.`, kind: "invalid" },
      { status: 413 },
    );
  }

  // Who is asking decides how the run is labelled, nothing more: an owner
  // clicking in Settings holds a cookie, the agent holds the bearer.
  const source = (await hasOwnerSession(request)) ? "owner" : "agent";

  try {
    const run = await startRun({
      task,
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      directory: typeof body.directory === "string" ? body.directory : null,
      resumeRunId: typeof body.resumeRunId === "string" ? body.resumeRunId : null,
      source,
    });
    return NextResponse.json({ started: true, run }, { status: 202 });
  } catch (err) {
    if (err instanceof CodingAgentError) {
      return NextResponse.json({ error: err.message, kind: err.kind }, { status: STATUS_FOR[err.kind] });
    }
    console.error("[coding-agent/run] failed to start:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not start the coding run" },
      { status: 500 },
    );
  }
}
