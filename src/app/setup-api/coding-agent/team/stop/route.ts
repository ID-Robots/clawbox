import { NextResponse } from "next/server";
import { CodingAgentError, httpStatusForCodingError } from "@/lib/coding-agent";
import { stopTeam } from "@/lib/coding-team";
import { requireSession } from "@/lib/route-auth";

export const dynamic = "force-dynamic";

/**
 * POST { id } → { team } — stop a coding team: the board goes to `stopped`
 * and the worker in flight is stopped with it. Session-gated like `stop` on
 * a run; the assistant may stop a team it started, and so may the owner.
 */
export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const id = typeof body?.id === "string" ? body.id : typeof body?.teamId === "string" ? body.teamId : "";
  if (!id) return NextResponse.json({ error: "Name the team: id" }, { status: 400 });
  try {
    return NextResponse.json({ team: stopTeam(id) });
  } catch (err) {
    if (err instanceof CodingAgentError) {
      return NextResponse.json({ error: err.message, kind: err.kind }, { status: httpStatusForCodingError(err.kind) });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not stop the team" }, { status: 500 });
  }
}
