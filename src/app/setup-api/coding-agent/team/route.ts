import { NextResponse } from "next/server";
import { CodingAgentError, httpStatusForCodingError, MAX_WAIT_MS } from "@/lib/coding-agent";
import { slimTeam, teamCard } from "@/lib/coding-agent-slim";
import { pushPendingAction } from "@/lib/pending-actions";
import { getTeam, listTeams, startTeam, waitForTeam } from "@/lib/coding-team";
import { hasPersonSession } from "@/lib/owner-session";
import { requireSession } from "@/lib/route-auth";

export const dynamic = "force-dynamic";

/**
 * A coding TEAM — the multi-agent shape of the coding agent
 * (src/lib/coding-team.ts): a planner, workers, a reviewer, a blackboard.
 *
 * GET  ?id=<team-id>            → { team } — the board: tasks, audit log, alerts,
 *                                 the planner's `shape`, and `metrics` (runs per
 *                                 role, tasks planned/added/retired/accepted first
 *                                 try/rejected, tokens — in total, by role, by
 *                                 provider and by kind (input, output, cache
 *                                 written, cache read) — wall time, team messages
 *                                 sent/to the lead/to a sibling/undelivered) as of now
 * GET ?id=<team-id>&wait=<seconds> → the same, held open until the team settles
 *                                 or `wait` elapses (capped at MAX_WAIT_MS), the
 *                                 way the runs route does; the box tells the
 *                                 owner (and, on OpenClaw, the assistant's chat)
 *                                 when a team settles, so nothing need poll this
 * GET                           → { teams } — the recent boards, newest first
 * GET ?slim=1                   → the same with every SETTLED board's log
 *                                 emptied and its tasks' briefs cut short,
 *                                 results and review notes dropped, `slim:
 *                                 true` on it — the app's live poll, merged
 *                                 over the boards it holds
 *                                 (src/lib/coding-agent-slim.ts); a team at
 *                                 work or queued is always whole. Every slim
 *                                 board carries `card` (`teamCard`): phase,
 *                                 tasks done/total, the task titles, the pull
 *                                 request number, the result's first sentence
 *                                 and the agents — the chat's team card
 * POST { goal, projectId | directory } → 202 { started: true, team }, or —
 *                                 while another team works — 202 { started:
 *                                 false, queued: true, team } with the board in
 *                                 status `queued` and its `queuePosition`
 *
 * Session-gated like the runs. POST is admitted to the owner's cookie AND
 * the MCP bearer — the assistant is the party that usually delegates a goal —
 * but the owner's switch (`coding-agent/enable`, owner-only) gates it the way
 * it gates every run, and a team asked for while another works is QUEUED and
 * started by the box in its turn (coding-team.ts startNextQueuedTeam). `source`
 * records who asked, the way a run does, and is what the reads and the stop
 * gate on: the bearer reaches only the teams it started (403 `owner_only`
 * otherwise, and an owner's teams are left out of its listing), the owner
 * reaches every team.
 */
export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  // The owner gate the run routes apply: the MCP bearer sees only the teams
  // it started. An owner's team, its goal and its log are the owner's.
  const owner = await hasPersonSession(request);
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const slim = url.searchParams.get("slim") === "1";
  if (id) {
    const waitRaw = Number(url.searchParams.get("wait") ?? "0");
    const waitMs = Number.isFinite(waitRaw) ? Math.max(0, Math.min(waitRaw, MAX_WAIT_MS / 1000)) * 1000 : 0;
    const team = waitMs > 0 ? await waitForTeam(id, waitMs) : getTeam(id);
    if (!team) return NextResponse.json({ error: "There is no coding team with that id.", kind: "not_found" }, { status: 404 });
    if (!owner && team.source === "owner") {
      return NextResponse.json({ error: "That team was started by the owner; only the owner can read it.", kind: "owner_only" }, { status: 403 });
    }
    return NextResponse.json({ team });
  }
  const teams = listTeams().filter((t) => owner || t.source === "agent");
  // `card` rides on every slim board — a team at work included — so the
  // chat's team card and the app's Now section read the counts, the task
  // titles, the pull request number and the result's first sentence without
  // the board (src/lib/coding-agent-slim.ts `teamCard`). Nested under one
  // key because `tasks` already names the board's own list.
  return NextResponse.json({ teams: slim ? teams.map((t) => ({ ...slimTeam(t), card: teamCard(t) })) : teams });
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
      source: (await hasPersonSession(request)) ? "owner" : "agent",
    });
    const queued = team.status === "queued";
    // Every open desktop hears that a team began (the run route does the
    // same): the chat's team card is there within one poll, whoever asked.
    void pushPendingAction(
      { type: "coding_team", phase: queued ? "queued" : "started", teamId: team.id, projectId: team.projectId, goal: team.goal.split(/\r?\n/)[0].slice(0, 160) },
      `coding-team:${team.id}`,
    ).catch((err: unknown) => {
      console.error("[coding-agent/team] desktop notice failed:", err instanceof Error ? err.message : err);
    });
    return NextResponse.json({ started: !queued, queued, team }, { status: 202 });
  } catch (err) {
    if (err instanceof CodingAgentError) {
      return NextResponse.json({ error: err.message, kind: err.kind }, { status: httpStatusForCodingError(err.kind) });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not start the team" }, { status: 500 });
  }
}
