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
  MAX_TEAM_WORKERS,
  resolveWorkingDirectory,
  startRun,
  stopRun,
  teamSpawnSlot,
  waitForRun,
  type CodingRun,
  type CodingRunSource,
} from "@/lib/coding-agent";
import { addWorkerWorktree, changedFiles, ensureTeamBranch, mergeWorkerBranch, removeWorktree } from "@/lib/coding-team-worktree";
import { parseVerdict, REVIEWER_BRIEF, reviewerTask } from "@/lib/coding-team-reviewer";
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
  teamAgents,
  TEAM_ID_RE,
  type Actor,
  type TeamAgents,
  type TeamBoard,
  type TeamTask,
} from "@/lib/coding-team-board";

/** The board as the routes and the app read it: with who worked, counted. */
export type TeamView = TeamBoard & { agents: TeamAgents };
import { TeamBus } from "@/lib/coding-team-bus";
import { parsePlan, PLANNER_BRIEF } from "@/lib/coding-team-planner";

/** A team stops after this many alerts: something is going wrong repeatedly. */
export const MAX_ALERTS = 3;
/** How long the orchestrator waits on one run per poll; the runner caps a wait anyway. */
const WAIT_SLICE_MS = 60_000;
/** How long the loop waits for a slot (memory, the cap) before looking again. */
const SLOT_WAIT_MS = 15_000;
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
  /** Every run of the team still going — several workers at once. */
  currentRunIds: Set<string>;
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
export async function startTeam(input: StartTeamInput): Promise<TeamView> {
  if (!(await isCodingAgentEnabled())) {
    throw new CodingAgentError("disabled", "The coding agent is switched off. Turn it on in the Coding Agent app first.");
  }
  const goal = typeof input.goal === "string" ? input.goal.trim() : "";
  if (!goal) throw new CodingAgentError("invalid", "A team needs a goal.");
  if (goal.length > MAX_TASK_CHARS) throw new CodingAgentError("invalid", `The goal is too long (${goal.length} > ${MAX_TASK_CHARS} characters).`);
  const busy = activeTeamId();
  if (busy) throw new CodingAgentError("busy", `Team ${busy} is still working; wait for it to finish or stop it first.`);
  const { directory, projectId } = await resolveWorkingDirectory({ projectId: input.projectId ?? null, directory: input.directory ?? null });

  // The owner's team is created in the owner's name; the assistant's by the
  // system on its behalf — the audit says which, and the routes gate on it.
  const board = createBoard({ goal, projectId, directory, source: input.source }, input.source === "owner" ? OWNER : SYSTEM);
  saveBoard(board);
  const bus = new TeamBus(board);
  const team: LiveTeam = { board, bus, stopRequested: false, currentRunIds: new Set(), done: Promise.resolve() };
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
export function stopTeam(id: string): TeamView {
  const team = live.get(id);
  if (!team) {
    const board = loadBoard(id);
    if (!board) throw new CodingAgentError("not_found", "There is no coding team with that id.");
    if (isSettledStatus(board.status)) return snapshot(board);
    // A team from before a restart: settle it now.
    setTeamStatus(board, SYSTEM, "failed", "The web server restarted while the team was working.");
    saveBoard(board);
    return snapshot(board);
  }
  team.stopRequested = true;
  for (const runId of team.currentRunIds) {
    try { stopRun(runId); } catch { /* already settled */ }
  }
  if (!isSettledStatus(team.board.status)) {
    setTeamStatus(team.board, OWNER, "stopped", "Stopped by the owner");
    saveBoard(team.board);
  }
  return snapshot(team.board);
}

export function getTeam(id: string): TeamView | null {
  if (!TEAM_ID_RE.test(id)) return null;
  const team = live.get(id);
  if (team) return snapshot(team.board);
  const board = loadBoard(id);
  if (!board) return null;
  return snapshot(settleOrphan(board));
}

export function listTeams(limit = 20): TeamView[] {
  return listBoards().slice(0, limit).map((b) => live.get(b.id)?.board ?? settleOrphan(b)).map(snapshot);
}

/** The team a run belongs to, for the run page's chip. */
export function teamOfRun(run: Pick<CodingRun, "team">): TeamView | null {
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
  board.runs.push({ id: planner.id, role: "planner", taskId: null });
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

  // The team's own branch in a folder project: workers get worktrees off it
  // and their branches merge back into it. A code project sits inside the
  // ClawBox checkout under rules of its own, so its workers work in place,
  // one at a time, as v0 did.
  if (!board.projectId) {
    const branched = await ensureTeamBranch(board.directory, board.id);
    if (!branched.ok) {
      setTeamStatus(board, SYSTEM, "failed", branched.detail);
      saveBoard(board);
      return;
    }
    board.branch = branched.branch;
    board.base = branched.base;
  }
  setTeamStatus(board, SYSTEM, "working");
  saveBoard(board);

  // 2. Workers: every task whose dependencies are done gets a worker as soon
  //    as the box has room for one (MAX_TEAM_WORKERS, the memory guard),
  //    and they settle in whatever order they finish. In place (no team
  //    branch) there is one slot: two workers in one checkout write over
  //    each other.
  const inFlight = new Map<string, Promise<void>>();
  const slots = board.branch ? MAX_TEAM_WORKERS : 1;
  while (!team.stopRequested) {
    if (board.alerts >= MAX_ALERTS) {
      setTeamStatus(board, SYSTEM, "failed", `Stopped after ${board.alerts} alerts.`);
      saveBoard(board);
      break;
    }
    const ready = readyTasks(board).filter((t) => !inFlight.has(t.task_id));
    let waitingForRoom = false;
    for (const task of ready) {
      if (inFlight.size >= slots) break;
      if (inFlight.size >= 1) {
        const slot = await teamSpawnSlot({ id: board.id, role: "worker", taskId: task.task_id });
        if (!slot.ok) { waitingForRoom = slot.wait; break; }
      }
      const work = workTask(team, task, source)
        .catch((err) => {
          bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `Task ${task.task_id} could not be worked: ${err instanceof Error ? err.message : String(err)}` });
        })
        .finally(() => { inFlight.delete(task.task_id); });
      inFlight.set(task.task_id, work);
    }
    if (inFlight.size === 0) {
      if (isExhausted(board)) break;
      if (!waitingForRoom) break;
      await sleep(SLOT_WAIT_MS);
      continue;
    }
    // Something is working: wake on the first settle, or after a while to
    // try for another slot (memory frees up as a worker ends).
    await Promise.race([...inFlight.values(), sleep(SLOT_WAIT_MS)]);
  }
  await Promise.allSettled([...inFlight.values()]);
  if (team.stopRequested) return;
  if (isSettledStatus(board.status)) return;

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

  // Its own worktree and branch, when the team has a branch to fork from.
  let directory = board.directory;
  let worktree: { path: string; branch: string } | null = null;
  if (board.branch) {
    const made = await addWorkerWorktree(board.directory, board.id, task.task_id, task.attempts + 1);
    if (!made.ok) throw new Error(`No worktree for ${task.task_id}: ${made.detail}`);
    worktree = { path: made.path, branch: made.branch };
    directory = made.path;
  }

  let run: CodingRun;
  try {
    run = await startRun({
      task: workerTask(board, task),
      projectId: worktree ? null : board.projectId,
      directory,
      source,
      team: { id: board.id, role: "worker", taskId: task.task_id },
      extraBrief: WORKER_BRIEF,
    });
  } catch (err) {
    if (worktree) await removeWorktree(board.directory, worktree.path);
    throw err;
  }
  const me = worker(run.id);
  bus.send(SYSTEM, { type: "assign", task_id: task.task_id, worker_id: run.id });
  const row = board.tasks.find((t) => t.task_id === task.task_id);
  if (row) { row.worktree = worktree?.path ?? null; row.branch = worktree?.branch ?? null; row.reviewRunId = null; }
  board.runs.push({ id: run.id, role: "worker", taskId: task.task_id });
  saveBoard(board);
  bus.send(me, { type: "status_update", task_id: task.task_id, status: "in_progress", worker_id: run.id });

  const settled = await settle(team, run.id);
  if (team.stopRequested) {
    if (worktree) await removeWorktree(board.directory, worktree.path);
    return;
  }
  const ok = settled?.status === "completed";
  let result = settled?.summary?.trim() || settled?.error || (ok ? "(no summary)" : `The run ended ${settled?.status ?? "without a record"}.`);

  // The worker's commits come home. A merge git cannot do alone is not
  // guessed at: the task is REJECTED with the conflict named and offered
  // once more, and the next attempt starts from the merged state.
  let files: string[] = settled?.filesTouched ?? [];
  let mergeRefusal: string | null = null;
  if (worktree) {
    if (ok) {
      // What the branch changed; a worker that committed nothing has no
      // branch diff, and what it touched uncommitted is still what it touched.
      const diffed = await changedFiles(board.directory, worktree.branch);
      if (diffed.length) files = diffed;
      const merged = await mergeWorkerBranch(board.directory, worktree.branch, `Coding team ${board.id}: ${task.task_id} — ${firstLine(task.task_description, 72)}`);
      if (!merged.ok) {
        mergeRefusal = `${merged.conflict ? "MERGE CONFLICT" : "MERGE FAILED"}: ${firstLine(merged.detail, 300)}`;
        result = `${result}\n\n${mergeRefusal}`;
        bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `${merged.conflict ? "Merge conflict" : "Merge failed"} for ${task.task_id} (${run.id}): ${firstLine(merged.detail, 200)}` });
      }
    }
    await removeWorktree(board.directory, worktree.path);
  }
  bus.send(me, { type: "result", task_id: task.task_id, result, worker_id: run.id });
  bus.send(me, { type: "status_update", task_id: task.task_id, status: ok ? "complete" : "failed", worker_id: run.id });
  if (mergeRefusal) {
    bus.send(REVIEWER, { type: "review", task_id: task.task_id, verdict: "rejected", notes: `${mergeRefusal} The work could not be merged; redo the task on the current files.` });
    return;
  }

  // Guardrails: what the worker did, against what it was asked.
  if (settled) {
    if (settled.permissionDenials > 0) {
      bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `Worker ${run.id} was refused ${settled.permissionDenials} action(s): ${settled.deniedActions.slice(0, 3).join("; ")}` });
    }
    const strayed = outsideHint(files, task.files_hint);
    if (strayed.length) {
      bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `Worker ${run.id} touched files outside its task: ${strayed.slice(0, 5).join(", ")}` });
    }
  }

  // The review loop: the rule first (v0 — a refusal or a stray file is a
  // rejection without a model), then the REVIEWER, a read-only run on the
  // merged work that answers a verdict. A review that was not done is not
  // an acceptance: a garbled answer falls back to the rule with an alert.
  if (ok) {
    const clean = settled && settled.permissionDenials === 0 && outsideHint(files, task.files_hint).length === 0;
    if (!clean) {
      bus.send(REVIEWER, { type: "review", task_id: task.task_id, verdict: "rejected", notes: "The worker was refused an action or strayed outside its files; the task is offered once more." });
      return;
    }
    const verdict = await reviewTask(team, task, source, { files, report: result });
    if (team.stopRequested) return;
    bus.send(REVIEWER, { type: "review", task_id: task.task_id, ...verdict });
  }
}

/** The reviewer's run and its verdict; the rule's acceptance when the run cannot say. */
async function reviewTask(team: LiveTeam, task: TeamTask, source: CodingRunSource, work: { files: string[]; report: string }): Promise<{ verdict: "accepted" | "rejected"; notes: string }> {
  const { board, bus } = team;
  let run: CodingRun;
  try {
    run = await startRun({
      task: reviewerTask({ taskId: task.task_id, description: task.task_description, files: work.files, report: work.report, goal: board.goal }),
      projectId: board.projectId,
      directory: board.directory,
      source,
      team: { id: board.id, role: "reviewer", taskId: task.task_id },
      readOnly: true,
      extraBrief: REVIEWER_BRIEF,
    });
  } catch (err) {
    bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `No reviewer for ${task.task_id}: ${err instanceof Error ? err.message : String(err)}` });
    return { verdict: "accepted", notes: "Accepted by rule: the reviewer could not start." };
  }
  const row = board.tasks.find((t) => t.task_id === task.task_id);
  if (row) row.reviewRunId = run.id;
  board.runs.push({ id: run.id, role: "reviewer", taskId: task.task_id });
  saveBoard(board);
  const settled = await settle(team, run.id);
  if (settled?.status !== "completed") {
    bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `The reviewer of ${task.task_id} (${run.id}) ended ${settled?.status ?? "without a record"}.` });
    return { verdict: "accepted", notes: "Accepted by rule: the reviewer did not finish." };
  }
  const parsed = parseVerdict(settled.summary);
  if (!parsed.ok) {
    bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `The reviewer of ${task.task_id} gave no verdict: ${parsed.reason}` });
    return { verdict: "accepted", notes: `Accepted by rule: ${parsed.reason}` };
  }
  return parsed.verdict;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for a run to settle, in slices, honouring a stop and the budget. */
async function settle(team: LiveTeam, runId: string): Promise<CodingRun | null> {
  team.currentRunIds.add(runId);
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
    team.currentRunIds.delete(runId);
  }
}

// ─── Words ───────────────────────────────────────────────────────────────────

/** One worker's task text: the goal, its own task, what teammates did, where to work. */
export function workerTask(board: TeamBoard, task: TeamTask): string {
  const done = board.tasks
    .filter((t) => t.task_id !== task.task_id && t.status === "complete" && t.result)
    .map((t) => `- ${t.task_id}: ${firstLine(t.result ?? "", RESULT_QUOTE_CHARS)}`);
  // The task line comes FIRST: a run's commit subject and its row in the
  // app are the task text's first line, and "Team goal: …" four times over
  // told the owner nothing about which worker did what.
  const parts = [
    `Your task (${task.task_id} of ${board.tasks.length}): ${task.task_description}`,
    `Team goal: ${board.goal}`,
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

/** The board as the routes answer it, with the agent count worked out from it. */
function snapshot(board: TeamBoard): TeamView {
  return { ...(JSON.parse(JSON.stringify(board)) as TeamBoard), agents: teamAgents(board) };
}

function firstLine(text: string, max: number): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
