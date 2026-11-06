/**
 * Where a coding run or team stands between being asked for and doing its
 * first piece of work — the step the chat's cards and the Coding Agent app's
 * Now section name while they would otherwise show nothing at all.
 *
 * The owner's report (2026-10-30, a team for "build an invoice reader app"
 * on a real board): minutes without a sign that anything had begun. A run's
 * record was written only after its worktree, its account and its spawn, and
 * a team's board said `planning` with an empty chart until the planner's
 * first turn came back. So a run is ANNOUNCED the moment its request arrives
 * (the runs list's `starting`, src/lib/coding-run-starts.ts) and walks these
 * steps until its record lands; a team's card names its own steps off the
 * board (`teamStartStep`).
 *
 * Pure: the routes, the slim team card and the browser all read it.
 */

/** A run's steps BEFORE its record exists, in order. */
export const RUN_START_STEPS = ["checking", "worktree", "launching"] as const;
export type RunStartStep = (typeof RUN_START_STEPS)[number];

/**
 * The steps a run's card names: the three above, and `agent` — the record is
 * written and the harness spawned, but the harness has not said a word yet.
 */
export type RunCardStartStep = RunStartStep | "agent";

export function isRunStartStep(value: unknown): value is RunStartStep {
  return typeof value === "string" && (RUN_START_STEPS as readonly string[]).includes(value);
}

/** What was asked for: a single run, or a team (a team is only ever listed here when it failed to start). */
export type CodingStartKind = "run" | "team";

/** One start in flight, or one that failed, as the runs list carries it. */
export interface CodingStartView {
  /** The id the run's record will carry — the card keeps it when the record lands. */
  id: string;
  kind: CodingStartKind;
  /** The task, or the team's goal. */
  task: string;
  projectId: string | null;
  directory: string | null;
  source: "owner" | "agent";
  /** When the request arrived: the card's clock starts here. */
  requestedAt: number;
  step: RunStartStep;
  /** Why it did not start — its first line — once it failed; null while it is on its way. */
  error: string | null;
  failedAt: number | null;
}

/**
 * The runs list's `starting`, checked entry by entry: whatever shape a
 * card cannot draw is dropped, never guessed at.
 */
export function readCodingStarts(raw: unknown): CodingStartView[] {
  if (!Array.isArray(raw)) return [];
  const out: CodingStartView[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as Partial<Record<keyof CodingStartView, unknown>>;
    if (typeof s.id !== "string" || !s.id || typeof s.requestedAt !== "number") continue;
    out.push({
      id: s.id,
      kind: s.kind === "team" ? "team" : "run",
      task: typeof s.task === "string" ? s.task : "",
      projectId: typeof s.projectId === "string" ? s.projectId : null,
      directory: typeof s.directory === "string" ? s.directory : null,
      source: s.source === "owner" ? "owner" : "agent",
      requestedAt: s.requestedAt,
      step: isRunStartStep(s.step) ? s.step : RUN_START_STEPS[0],
      error: typeof s.error === "string" && s.error ? s.error : null,
      failedAt: typeof s.failedAt === "number" ? s.failedAt : null,
    });
  }
  return out;
}

/**
 * How often the cards and the app re-ask while something is STARTING — a
 * start announced, a run whose harness has not spoken, a team's planner or
 * first worker on its way: each of those steps lasts seconds, and a card
 * that moves on five seconds late reads as stuck.
 */
export const START_POLL_MS = 1_500;

/**
 * The step a run's card names once its record exists: `agent` while the
 * record is running and the harness has sent nothing (its first event
 * carries the session id, coding-agent.ts's stream reader), else none.
 */
export function runRecordStartStep(run: { status: string; sessionId?: string | null; numTurns?: number | null }): "agent" | null {
  return run.status === "running" && !run.sessionId && !run.numTurns ? "agent" : null;
}

/** A team's steps from asked-for to its first worker at work, in order. */
export const TEAM_START_STEPS = ["planner_starting", "planning", "plan_ready", "worker_starting"] as const;
export type TeamStartStep = (typeof TEAM_START_STEPS)[number];

export function isTeamStartStep(value: unknown): value is TeamStartStep {
  return typeof value === "string" && (TEAM_START_STEPS as readonly string[]).includes(value);
}

/**
 * Where a team is on its way to its first worker, off the board alone (the
 * whole board or the slim one — both carry the status, the tasks and the
 * cast list); null once a worker is at work, or for a team that is queued
 * or over (its status word says that already).
 *
 * The planner joins `runs` only once its start resolved (coding-team.ts
 * `runTeam`), a worker or a single run's lead the same way, and the tasks
 * are posted only when the plan is parsed — so each step below is a fact on
 * the board, never a guess from the clock.
 */
export function teamStartStep(team: {
  status: string;
  tasks?: readonly { status?: string }[] | null;
  runs?: readonly { role: string }[] | null;
}): TeamStartStep | null {
  const runs = team.runs ?? [];
  if (team.status === "planning") {
    if (!runs.some((r) => r.role === "planner")) return "planner_starting";
    const tasks = (team.tasks ?? []).filter((t) => t.status !== "retired");
    return tasks.length > 0 ? "plan_ready" : "planning";
  }
  if (team.status === "working" && !runs.some((r) => r.role === "worker" || r.role === "lead")) return "worker_starting";
  return null;
}
