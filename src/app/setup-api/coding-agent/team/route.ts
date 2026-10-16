import { NextResponse } from "next/server";
import { CodingAgentError, httpStatusForCodingError } from "@/lib/coding-agent";
import { getTeam, listTeams, startTeam } from "@/lib/coding-team";
import { hasPersonSession } from "@/lib/owner-session";
import { requireSession } from "@/lib/route-auth";
import { budgetAnswer, resolveStartBudget } from "@/lib/coding-time-budget-server";
import { readTimeRecordSummary, type TimeRecordPayload } from "@/lib/coding-time-record";

export const dynamic = "force-dynamic";

/** How many record lines each team of the LIST carries — the latest; one team's read (`?id=`) carries the default. */
const LIST_TIME_RECORDS = 50;

/**
 * A team as the GET answers it: with its time record (`timeRecord`,
 * readTimeRecordSummary — the plan, the estimates, the skips and the
 * checkpoints, summarized as of now) when it has a budget and a record.
 * Without either, the board exactly as before: no key at all.
 */
function withTimeRecord<T extends { id: string; timeBudget?: unknown }>(team: T, now: number, maxRecords?: number): T & { timeRecord?: TimeRecordPayload } {
  if (!team.timeBudget) return team;
  const timeRecord = readTimeRecordSummary(team.id, now, maxRecords);
  return timeRecord ? { ...team, timeRecord } : team;
}

/**
 * A coding TEAM — the multi-agent shape of the coding agent
 * (src/lib/coding-team.ts): a planner, workers, a reviewer, a blackboard.
 *
 * GET  ?id=<team-id>            → { team } — the board: tasks, audit log, alerts,
 *                                 the planner's `shape`, and `metrics` (runs per
 *                                 role, tasks planned/added/retired/accepted first
 *                                 try/rejected, tokens, wall time, team messages
 *                                 sent/to the lead/to a sibling/undelivered) as of now;
 *                                 a team with a time budget also carries its
 *                                 `timeRecord` (the plan, estimates, skips and
 *                                 checkpoints, as of now) once it has one
 * GET                           → { teams } — the recent boards, newest first,
 *                                 each budgeted one with its `timeRecord` cut to
 *                                 the latest LIST_TIME_RECORDS record lines
 * POST { goal, projectId | directory, budget? } → 202 { started: true, team }, or —
 *                                 while another team works — 202 { started:
 *                                 false, queued: true, team } with the board in
 *                                 status `queued` and its `queuePosition`.
 *                                 `budget` as the run route takes it (a chip, a
 *                                 length, an end time, { preset: "custom", end,
 *                                 start? } or "none"); it beats the goal's own
 *                                 words, which beat the owner's default. The
 *                                 board and the answer carry the resolved
 *                                 `timeBudget`; an unreadable, past or >14-day
 *                                 one is 400 `invalid`, `code: "budget"`.
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
  const id = new URL(request.url).searchParams.get("id");
  if (id) {
    const team = getTeam(id);
    if (!team) return NextResponse.json({ error: "There is no coding team with that id.", kind: "not_found" }, { status: 404 });
    if (!owner && team.source === "owner") {
      return NextResponse.json({ error: "That team was started by the owner; only the owner can read it.", kind: "owner_only" }, { status: 403 });
    }
    return NextResponse.json({ team: withTimeRecord(team, Date.now()) });
  }
  const now = Date.now();
  return NextResponse.json({ teams: listTeams().filter((t) => owner || t.source === "agent").map((t) => withTimeRecord(t, now, LIST_TIME_RECORDS)) });
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
  const goal = typeof body.goal === "string" ? body.goal : "";
  // The picker's budget, else the goal's words, else the owner's default —
  // resolved on the box's clock and kept on the board as an absolute deadline.
  const resolved = await resolveStartBudget({ explicit: body.budget, text: goal, applyDefault: true });
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error, kind: "invalid", code: "budget" }, { status: 400 });
  }
  try {
    const team = await startTeam({
      goal,
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      directory: typeof body.directory === "string" ? body.directory : null,
      source: (await hasPersonSession(request)) ? "owner" : "agent",
      // Absent without one: a team without a budget starts exactly as before.
      ...(resolved.budget ? { timeBudget: resolved.budget } : {}),
    });
    const queued = team.status === "queued";
    return NextResponse.json({ started: !queued, queued, team, ...budgetAnswer(resolved) }, { status: 202 });
  } catch (err) {
    if (err instanceof CodingAgentError) {
      return NextResponse.json({ error: err.message, kind: err.kind }, { status: httpStatusForCodingError(err.kind) });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not start the team" }, { status: 500 });
  }
}
