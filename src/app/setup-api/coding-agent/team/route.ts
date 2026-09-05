import { NextResponse } from "next/server";
import { CodingAgentError, httpStatusForCodingError } from "@/lib/coding-agent";
import { getTeam, listTeams, startTeam } from "@/lib/coding-team";
import { hasOwnerSession } from "@/lib/owner-session";
import { requireSession } from "@/lib/route-auth";

export const dynamic = "force-dynamic";

/**
 * A coding TEAM — the multi-agent shape of the coding agent
 * (src/lib/coding-team.ts): a planner, workers, a reviewer, a blackboard.
 *
 * GET  ?id=<team-id>            → { team } — the board: tasks, audit log, alerts
 * GET                           → { teams } — the recent boards, newest first
 * POST { goal, projectId | directory } → 202 { started: true, team }
 *
 * Session-gated like the runs. POST is admitted to the owner's cookie AND
 * the MCP bearer — the assistant is the party that usually delegates a goal —
 * but the owner's switch (`coding-agent/enable`, owner-only) gates it the way
 * it gates every run, and a team is refused while another works. `source`
 * records who asked, the way a run does.
 */
export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  const id = new URL(request.url).searchParams.get("id");
  if (id) {
    const team = getTeam(id);
    if (!team) return NextResponse.json({ error: "There is no coding team with that id.", kind: "not_found" }, { status: 404 });
    return NextResponse.json({ team });
  }
  return NextResponse.json({ teams: listTeams() });
}

export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  try {
    const team = await startTeam({
      goal: typeof body.goal === "string" ? body.goal : "",
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      directory: typeof body.directory === "string" ? body.directory : null,
      source: (await hasOwnerSession(request)) ? "owner" : "agent",
    });
    return NextResponse.json({ started: true, team }, { status: 202 });
  } catch (err) {
    if (err instanceof CodingAgentError) {
      return NextResponse.json({ error: err.message, kind: err.kind }, { status: httpStatusForCodingError(err.kind) });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not start the team" }, { status: 500 });
  }
}
