/**
 * A coding TEAM: the multi-agent shape of the coding agent (owner's brief,
 * 2026-09-04), v0.
 *
 *   Planner  → posts tasks to the Blackboard (coding-team-board.ts)
 *   Workers  → take tasks, execute, post results
 *   Reviewer → checks each result (v0: a rule; v1: the review pass)
 *   Bus      → the one way any of them changes the board (coding-team-bus.ts)
 *
 * Every agent here IS a coding run (src/lib/coding-agent.ts) — the sandbox
 * the device already has: capability drop, Bash allow/deny lists, file deny
 * rules, folder containment, step and token ceilings. The planner is a run
 * that may only read; a worker is an ordinary run whose task is one board
 * task with the team's context around it. The orchestrator is this module,
 * in the web server: it starts runs one at a time (the runner's own rule on
 * a Jetson), listens for them to settle, and speaks on the bus in the role
 * the message belongs to — as the planner when posting the plan it parsed,
 * as the worker when relaying that worker's outcome, as the reviewer when
 * ruling, as the system when assigning and when a guardrail spoke.
 *
 * Guardrails (v0): the board refuses any message its sender's role may not
 * send and logs the refusal; a worker that hit a permission denial, or that
 * touched files outside its task's files_hint, raises an ALERT; after
 * MAX_ALERTS the team stops. A failed task fails the team unless other
 * tasks can still run; a task the reviewer rejects is re-posted once.
 *
 * A team lives in this process; its board is on disk after every message.
 * A team the web server was restarted under is settled as failed on the
 * next read, with the reason, never left "working" forever.
 */

import {
  CodingAgentError,
  getRun,
  isCodingAgentEnabled,
  MAX_TASK_CHARS,
  resolveWorkingDirectory,
  startRun,
  stopRun,
  waitForRun,
  type CodingRun,
  type CodingRunSource,
} from "@/lib/coding-agent";
import { isLive } from "@/lib/coding-agent-status";
import {
  allComplete,
  createBoard,
  isExhausted,
  listBoards,
  loadBoard,
  readyTasks,
  saveBoard,
  setTeamStatus,
  TEAM_ID_RE,
  type Actor,
  type TeamBoard,
  type TeamTask,
} from "@/lib/coding-team-board";
import { TeamBus } from "@/lib/coding-team-bus";
import { parsePlan, PLANNER_BRIEF } from "@/lib/coding-team-planner";

/** A team stops after this many alerts: something is going wrong repeatedly. */
export const MAX_ALERTS = 3;
/** How long the orchestrator waits on one run per poll; the runner caps a wait anyway. */
const WAIT_SLICE_MS = 60_000;
/** A planner or a worker that has not settled by then is stopped and the team failed. */
export const RUN_BUDGET_MS = 60 * 60_000;
/** Sibling results quoted into a worker's task are cut here each. */
const RESULT_QUOTE_CHARS = 400;

export const WORKER_BRIEF = [
  "You are ONE WORKER of a small coding team. The task you were given is one part of a larger goal; other workers do the other parts in their own sessions, before or after you.",
  "Do your task and only your task: do not redo, undo or 'improve' the parts that belong to others, and stay inside the files your task names unless the task cannot be done otherwise — say so in your report if you had to.",
  "Your final message is read by the team's reviewer and quoted to the next worker: state what you changed (file names), how it can be checked, and anything you could not finish.",
].join(" ");

export interface StartTeamInput {
  goal: string;
  projectId?: string | null;
  directory?: string | null;
  source: CodingRunSource;
}

interface LiveTeam {
  board: TeamBoard;
  bus: TeamBus;
  stopRequested: boolean;
  currentRunId: string | null;
  done: Promise<void>;
}

const live = new Map<string, LiveTeam>();

const SYSTEM: Actor = { kind: "system" };
const PLANNER: Actor = { kind: "planner" };
const REVIEWER: Actor = { kind: "reviewer" };
const OWNER: Actor = { kind: "owner" };
const worker = (id: string): Actor => ({ kind: "worker", id });

// ─── Public API ──────────────────────────────────────────────────────────────

export function activeTeamId(): string | null {
  for (const [id, team] of live) if (!isSettledStatus(team.board.status)) return id;
  return null;
}

/**
 * Start a team on a goal. Refuses while the switch is off, while another
 * team is working (one team, one worker at a time — the box has one shell
 * budget), and for a folder a run could not be pointed at.
 */
export async function startTeam(input: StartTeamInput): Promise<TeamBoard> {
  if (!(await isCodingAgentEnabled())) {
    throw new CodingAgentError("disabled", "The coding agent is switched off. Turn it on in the Coding Agent app first.");
  }
  const goal = typeof input.goal === "string" ? input.goal.trim() : "";
  if (!goal) throw new CodingAgentError("invalid", "A team needs a goal.");
  if (goal.length > MAX_TASK_CHARS) throw new CodingAgentError("invalid", `The goal is too long (${goal.length} > ${MAX_TASK_CHARS} characters).`);
  const busy = activeTeamId();
  if (busy) throw new CodingAgentError("busy", `Team ${busy} is still working; wait for it to finish or stop it first.`);
  const { directory, projectId } = await resolveWorkingDirectory({ projectId: input.projectId ?? null, directory: input.directory ?? null });

  const board = createBoard({ goal, projectId, directory }, OWNER);
  saveBoard(board);
  const bus = new TeamBus(board);
  const team: LiveTeam = { board, bus, stopRequested: false, currentRunId: null, done: Promise.resolve() };
  live.set(board.id, team);
  team.done = runTeam(team, input.source)
    .catch((err) => {
      if (!isSettledStatus(board.status)) {
        setTeamStatus(board, SYSTEM, "failed", err instanceof Error ? err.message : String(err));
        saveBoard(board);
      }
    })
    .finally(() => {
      // Kept in the map only while it works; a settled team is read from disk.
      if (isSettledStatus(board.status)) live.delete(board.id);
    });
  return snapshot(board);
}

/** Stop a team: the owner's gesture. The worker in flight is stopped too. */
export function stopTeam(id: string): TeamBoard {
  const team = live.get(id);
  if (!team) {
    const board = loadBoard(id);
    if (!board) throw new CodingAgentError("not_found", "There is no coding team with that id.");
    if (isSettledStatus(board.status)) return board;
    // A team from before a restart: settle it now.
    setTeamStatus(board, SYSTEM, "failed", "The web server restarted while the team was working.");
    saveBoard(board);
    return board;
  }
  team.stopRequested = true;
  if (team.currentRunId) {
    try { stopRun(team.currentRunId); } catch { /* already settled */ }
  }
  if (!isSettledStatus(team.board.status)) {
    setTeamStatus(team.board, OWNER, "stopped", "Stopped by the owner");
    saveBoard(team.board);
  }
  return snapshot(team.board);
}

export function getTeam(id: string): TeamBoard | null {
  if (!TEAM_ID_RE.test(id)) return null;
  const team = live.get(id);
  if (team) return snapshot(team.board);
  const board = loadBoard(id);
  if (!board) return null;
  return settleOrphan(board);
}

export function listTeams(limit = 20): TeamBoard[] {
  return listBoards().slice(0, limit).map((b) => live.get(b.id)?.board ?? settleOrphan(b)).map(snapshot);
}

/** The team a run belongs to, for the run page's chip. */
export function teamOfRun(run: Pick<CodingRun, "team">): TeamBoard | null {
  return run.team ? getTeam(run.team.id) : null;
}

/** Tests only. */
export function _resetCodingTeamStateForTests(): void {
  live.clear();
}

// ─── The loop ────────────────────────────────────────────────────────────────

async function runTeam(team: LiveTeam, source: CodingRunSource): Promise<void> {
  const { board, bus } = team;

  // 1. The planner: a read-only run whose final message is the plan.
  const planner = await startRun({
    task: board.goal,
    projectId: board.projectId,
    directory: board.directory,
    source,
    team: { id: board.id, role: "planner", taskId: null },
    readOnly: true,
    extraBrief: PLANNER_BRIEF,
  });
  board.plannerRunId = planner.id;
  saveBoard(board);
  const planned = await settle(team, planner.id);
  if (team.stopRequested) return;
  if (!planned || planned.status !== "completed") {
    setTeamStatus(board, SYSTEM, "failed", `The planner did not finish: ${planned?.error ?? planned?.status ?? "no run"}.`);
    saveBoard(board);
    return;
  }
  const plan = parsePlan(planned.summary);
  if (!plan.ok) {
    setTeamStatus(board, SYSTEM, "failed", plan.reason);
    saveBoard(board);
    return;
  }
  for (const task of plan.tasks) bus.send(PLANNER, { type: "task", ...task });
  setTeamStatus(board, SYSTEM, "working");
  saveBoard(board);

  // 2. Workers, one at a time, each task when its dependencies are done.
  while (!team.stopRequested) {
    if (board.alerts >= MAX_ALERTS) {
      setTeamStatus(board, SYSTEM, "failed", `Stopped after ${board.alerts} alerts.`);
      saveBoard(board);
      return;
    }
    const [next] = readyTasks(board);
    if (!next) {
      if (isExhausted(board)) break;
      continue;
    }
    await workTask(team, next, source);
  }
  if (team.stopRequested) return;

  // 3. The verdict on the team.
  if (allComplete(board)) {
    setTeamStatus(board, SYSTEM, "done");
  } else {
    const failed = board.tasks.filter((t) => t.status === "failed" || t.status === "rejected").map((t) => t.task_id);
    const blocked = board.tasks.filter((t) => t.status === "pending").map((t) => t.task_id);
    setTeamStatus(board, SYSTEM, "failed", `Tasks ${failed.join(", ") || "none"} failed${blocked.length ? `; ${blocked.join(", ")} never ran` : ""}.`);
  }
  saveBoard(board);
}

async function workTask(team: LiveTeam, task: TeamTask, source: CodingRunSource): Promise<void> {
  const { board, bus } = team;
  const run = await startRun({
    task: workerTask(board, task),
    projectId: board.projectId,
    directory: board.directory,
    source,
    team: { id: board.id, role: "worker", taskId: task.task_id },
    extraBrief: WORKER_BRIEF,
  });
  const me = worker(run.id);
  bus.send(SYSTEM, { type: "assign", task_id: task.task_id, worker_id: run.id });
  bus.send(me, { type: "status_update", task_id: task.task_id, status: "in_progress", worker_id: run.id });

  const settled = await settle(team, run.id);
  if (team.stopRequested) return;
  const ok = settled?.status === "completed";
  const result = settled?.summary?.trim() || settled?.error || (ok ? "(no summary)" : `The run ended ${settled?.status ?? "without a record"}.`);
  bus.send(me, { type: "result", task_id: task.task_id, result, worker_id: run.id });
  bus.send(me, { type: "status_update", task_id: task.task_id, status: ok ? "complete" : "failed", worker_id: run.id });

  // Guardrails: what the worker did, against what it was asked.
  if (settled) {
    if (settled.permissionDenials > 0) {
      bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `Worker ${run.id} was refused ${settled.permissionDenials} action(s): ${settled.deniedActions.slice(0, 3).join("; ")}` });
    }
    const strayed = outsideHint(settled.filesTouched, task.files_hint);
    if (strayed.length) {
      bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `Worker ${run.id} touched files outside its task: ${strayed.slice(0, 5).join(", ")}` });
    }
  }

  // The review loop, v0: a rule — accepted when the run completed with no
  // refusals and no straying; otherwise rejected, which re-posts the task
  // once. v1 puts the review pass's findings here.
  if (ok) {
    const clean = settled && settled.permissionDenials === 0 && outsideHint(settled.filesTouched, task.files_hint).length === 0;
    bus.send(REVIEWER, {
      type: "review",
      task_id: task.task_id,
      verdict: clean ? "accepted" : "rejected",
      notes: clean ? "" : "The worker was refused an action or strayed outside its files; the task is offered once more.",
    });
  }
}

/** Wait for a run to settle, in slices, honouring a stop and the budget. */
async function settle(team: LiveTeam, runId: string): Promise<CodingRun | null> {
  team.currentRunId = runId;
  const started = Date.now();
  try {
    for (;;) {
      const run = await waitForRun(runId, WAIT_SLICE_MS);
      if (!run) return null;
      if (!isLive(run.status)) return run;
      if (team.stopRequested) {
        try { stopRun(runId); } catch { /* raced with its own settle */ }
        return getRun(runId);
      }
      if (Date.now() - started > RUN_BUDGET_MS) {
        team.bus.send(SYSTEM, { type: "alert", reason: `Run ${runId} outlived the team's budget and was stopped.` });
        try { stopRun(runId); } catch { /* raced */ }
        return getRun(runId);
      }
    }
  } finally {
    team.currentRunId = null;
  }
}

// ─── Words ───────────────────────────────────────────────────────────────────

/** One worker's task text: the goal, its own task, what teammates did, where to work. */
export function workerTask(board: TeamBoard, task: TeamTask): string {
  const done = board.tasks
    .filter((t) => t.task_id !== task.task_id && t.status === "complete" && t.result)
    .map((t) => `- ${t.task_id}: ${firstLine(t.result ?? "", RESULT_QUOTE_CHARS)}`);
  const parts = [
    `Team goal: ${board.goal}`,
    `Your task (${task.task_id} of ${board.tasks.length}): ${task.task_description}`,
  ];
  if (task.files_hint.length) parts.push(`Files this task is expected to touch: ${task.files_hint.join(", ")}`);
  if (done.length) parts.push(`Already done by teammates:\n${done.join("\n")}`);
  if (task.attempts > 0 && task.review?.verdict === "rejected") parts.push(`A previous attempt was rejected: ${task.review.notes}`);
  let text = parts.join("\n\n");
  if (text.length > MAX_TASK_CHARS) text = `${text.slice(0, MAX_TASK_CHARS - 1)}…`;
  return text;
}

/** Files a worker touched that its task's hint does not cover (a hint names files or folders). */
export function outsideHint(touched: string[], hint: string[]): string[] {
  if (hint.length === 0) return [];
  const norm = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");
  const hints = hint.map(norm);
  return touched.map(norm).filter((f) => !hints.some((h) => f === h || f.startsWith(`${h}/`)));
}

// ─── Internals ───────────────────────────────────────────────────────────────

function isSettledStatus(status: TeamBoard["status"]): boolean {
  return status === "done" || status === "failed" || status === "stopped";
}

/** A board that says "working" with nobody working — the web server restarted under it. */
function settleOrphan(board: TeamBoard): TeamBoard {
  if (isSettledStatus(board.status) || live.has(board.id)) return board;
  setTeamStatus(board, SYSTEM, "failed", "The web server restarted while the team was working.");
  saveBoard(board);
  return board;
}

function snapshot(board: TeamBoard): TeamBoard {
  return JSON.parse(JSON.stringify(board)) as TeamBoard;
}

function firstLine(text: string, max: number): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
