import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { hasOwnerSession } from "@/lib/owner-session";
import { CodingAgentError, getRun, stopRun } from "@/lib/coding-agent";

export const dynamic = "force-dynamic";

/**
 * POST { id } → ask a running coding run to stop; answers the run record.
 * Idempotent: a run that already finished is returned as it is.
 *
 * Agent-callable with the in-handler gate every state-changing route carries:
 * the agent started its runs, the agent may end them. A run the OWNER started
 * from Settings is the owner's, though — the agent's bearer gets a 403 for
 * it, so a prompt-injected "stop that" cannot cut short work the person at
 * the desk asked for. An owner's cookie passes both checks.
 */
export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  let body: { id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "A run id is required." }, { status: 400 });

  try {
    const run = getRun(id);
    if (!run) {
      return NextResponse.json({ error: "There is no coding run with that id.", kind: "not_found" }, { status: 404 });
    }
    if (run.source === "owner" && run.status === "running" && !(await hasOwnerSession(request))) {
      return NextResponse.json(
        { error: "That run was started by the owner; only they can stop it.", kind: "owner_only" },
        { status: 403 },
      );
    }
    return NextResponse.json({ run: stopRun(id) });
  } catch (err) {
    if (err instanceof CodingAgentError && err.kind === "not_found") {
      return NextResponse.json({ error: err.message, kind: "not_found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not stop the coding run" },
      { status: 500 },
    );
  }
}
