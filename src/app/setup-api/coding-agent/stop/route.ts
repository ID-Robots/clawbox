import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { CodingAgentError, stopRun } from "@/lib/coding-agent";

export const dynamic = "force-dynamic";

/**
 * POST { id } → ask a running coding run to stop; answers the run record.
 * Idempotent: a run that already finished is returned as it is.
 *
 * Agent-callable with the in-handler gate every state-changing route carries.
 * Stopping is not owner-only: the agent started the run, the agent may end
 * it, and an owner in Settings holds a cookie that passes the same check.
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
