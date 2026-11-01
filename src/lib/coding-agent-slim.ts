/**
 * The SLIM shape of a coding run and a coding team, for the Coding Agent
 * app's live poll.
 *
 * While a run or a team works, the app re-reads the run list and the team
 * list every 5 s (CodingAgentApp.tsx `load({ tick: true })`). Measured on a
 * box with 30 runs and 19 teams on record, none of them live: 337 KB of runs
 * and 694 KB of teams per tick — over 8 MB a minute serialised on the box and
 * parsed on the desktop, for records that had settled days before and would
 * never change again. The bulk is the settled records' free text: a run's
 * progress lines and result text, a team's audit log and its tasks' briefs
 * and results.
 *
 * `?slim=1` on the two list routes answers a SETTLED record with that text
 * emptied and `slim: true` on it; a live run and a team at work are always
 * sent in full, as is every record on a read without the flag. The app asks
 * slim only on a tick and MERGES what comes back over the full records it
 * already holds (`mergeSlimRuns` / `mergeSlimTeams`): a settled record's
 * text was read in full on mount (or by the read after it settled, which is
 * never a tick), so a slim tick cannot take it away, while what a settled
 * record can still change — its pull request's checks, a leftover listener,
 * its artifacts — is taken from the tick. The merge takes the held text ONLY
 * when the held record had already settled: a record the app held LIVE that
 * a tick brings back settled and slim has final text the app never read (the
 * last live copy's progress lines are not the final ones), so the tick's slim
 * record is taken as it is and `runsSettledSinceHeld` / `teamsSettledSinceHeld`
 * name it, which is the app's cue to read whole again at once — a team at
 * work, another live run or a pull request waiting on its checks can keep the
 * poll ticking past that moment, so the settle read cannot be left to the
 * poll's end.
 *
 * Emptied, not deleted: every field keeps its type, so a slim record the app
 * does not yet hold (a team that settled between two ticks) still draws — a
 * run page with no progress lines, a team card with no log — until the next
 * full read fills it, instead of a `.length` on undefined.
 *
 * Pure: no fs, no React, shared by the routes and the component.
 */
import { isSettled, type CodingRunStatus } from "./coding-agent-status";
import { isSettledTeamStatus, type TeamStatus } from "./coding-team-status";
import { teamStartStep, type TeamStartStep } from "./coding-start-phase";

/** The run fields a slim read empties on a settled run. */
export interface RunSlimFields {
  progress: string[];
  progressAt?: number[];
  resultText?: string | null;
  allowRules?: string[];
  deniedActions?: string[];
  denials?: unknown[];
}

export type SlimmableRun = RunSlimFields & { id: string; status: CodingRunStatus; slim?: boolean };

export interface TeamTaskSlimFields {
  task_id: string;
  task_description: string;
  result: string | null;
  review: { notes: string } | null;
}

export type SlimmableTeam = {
  id: string;
  status: TeamStatus;
  log: unknown[];
  tasks: TeamTaskSlimFields[];
  slim?: boolean;
};

/** How much of a task's brief a slim team keeps: enough for a node's name and a row's first line. */
export const SLIM_TASK_DESCRIPTION_CHARS = 160;

/** A settled run with its free text emptied and `slim: true`; a held run unchanged. */
export function slimRun<T extends SlimmableRun>(run: T): T {
  if (!isSettled(run.status)) return run;
  const out: T = { ...run, progress: [], slim: true };
  if ("progressAt" in run) out.progressAt = [];
  if ("resultText" in run) out.resultText = null;
  if ("allowRules" in run) out.allowRules = [];
  if ("deniedActions" in run) out.deniedActions = [];
  if ("denials" in run) out.denials = [];
  return out;
}

/** A settled team without its log and its tasks' free text, and `slim: true`; a team at work (or queued) unchanged. */
export function slimTeam<T extends SlimmableTeam>(team: T): T {
  if (!isSettledTeamStatus(team.status)) return team;
  return {
    ...team,
    slim: true,
    log: [],
    tasks: team.tasks.map((task) => ({
      ...task,
      task_description: task.task_description.length > SLIM_TASK_DESCRIPTION_CHARS
        ? task.task_description.slice(0, SLIM_TASK_DESCRIPTION_CHARS - 1) + "…"
        : task.task_description,
      result: null,
      review: task.review ? { ...task.review, notes: "" } : null,
    })),
  };
}

/** The ids a tick brings back settled that the app held unsettled (live, paused, drafted, queued): their final text is still to be read. */
function newlySettled<T extends { id: string }>(held: readonly T[], incoming: readonly T[], settled: (x: T) => boolean): string[] {
  const byId = new Map(held.map((x) => [x.id, x]));
  return incoming.filter((x) => settled(x) && byId.has(x.id) && !settled(byId.get(x.id)!)).map((x) => x.id);
}

export function runsSettledSinceHeld<T extends { id: string; status: CodingRunStatus }>(held: readonly T[], incoming: readonly T[]): string[] {
  return newlySettled(held, incoming, (run) => isSettled(run.status));
}

export function teamsSettledSinceHeld<T extends { id: string; status: TeamStatus }>(held: readonly T[], incoming: readonly T[]): string[] {
  return newlySettled(held, incoming, (team) => isSettledTeamStatus(team.status));
}

/**
 * The run list after a tick: a slim record over a held SETTLED full one keeps
 * the held text; everything else comes from the tick — a record the app held
 * live included, whose final text the next whole read brings. The list's
 * order and membership are the tick's: a run that left the list leaves the
 * app too.
 */
export function mergeSlimRuns<T extends SlimmableRun>(held: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map(held.map((run) => [run.id, run]));
  return incoming.map((run) => {
    const prev = byId.get(run.id);
    if (!run.slim || !prev || prev.slim || !isSettled(prev.status)) return run;
    const merged: T = { ...run, progress: prev.progress, slim: false };
    if ("progressAt" in prev) merged.progressAt = prev.progressAt;
    if ("resultText" in prev) merged.resultText = prev.resultText;
    if ("allowRules" in prev) merged.allowRules = prev.allowRules;
    if ("deniedActions" in prev) merged.deniedActions = prev.deniedActions;
    if ("denials" in prev) merged.denials = prev.denials;
    return merged;
  });
}

/** The team list after a tick, on the same rule: a slim board over a held SETTLED full one keeps the held log and task text. */
export function mergeSlimTeams<T extends SlimmableTeam>(held: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map(held.map((team) => [team.id, team]));
  return incoming.map((team) => {
    const prev = byId.get(team.id);
    if (!team.slim || !prev || prev.slim || !isSettledTeamStatus(prev.status)) return team;
    const prevTasks = new Map(prev.tasks.map((task) => [task.task_id, task]));
    return {
      ...team,
      slim: false,
      log: prev.log,
      tasks: team.tasks.map((task) => {
        const was = prevTasks.get(task.task_id);
        if (!was) return task;
        return {
          ...task,
          task_description: was.task_description,
          result: was.result,
          review: task.review && was.review ? { ...task.review, notes: was.review.notes } : task.review,
        };
      }),
    };
  });
}

// ── What the CHAT's cards read ───────────────────────────────────────────────
//
// The chat shows every run and team as a card (CodingChatCards.tsx), polled
// on the same beat as the Coding Agent app. A card needs a line, not a board:
// the result's first sentence, how many tasks are done, whether there is a
// pull request. These are worked out here, server side, so the chat never
// parses a result text or walks a task list, and so the runs route and the
// team route hand out the same shape the app's own Now section can read.

/** The longest line a card draws: the result's first sentence, an error's first line. */
export const CARD_LINE_CHARS = 160;

/**
 * The first sentence of a text, cut to `max` characters. Markdown headings
 * and list marks on the first line come off, so "## Done" reads as "Done";
 * a text with no sentence end is its first line.
 */
export function firstSentence(text: string | null | undefined, max = CARD_LINE_CHARS): string | null {
  if (typeof text !== "string") return null;
  const line = text.split(/\r?\n/).map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+\.\s+)?/, "").trim()).find((l) => l.length > 0);
  if (!line) return null;
  const m = /^(.+?[.!?])(?:\s|$)/.exec(line);
  const sentence = (m ? m[1] : line).trim();
  return sentence.length > max ? sentence.slice(0, max - 1).trimEnd() + "…" : sentence;
}

/** A run's result in one line — `resultText ?? summary`, first sentence — or null before it has one. */
export function runSummaryLine(run: { summary?: string | null; resultText?: string | null }): string | null {
  return firstSentence(run.resultText ?? run.summary);
}

/** One task of a team, as the card lists it. */
export interface TeamCardTask {
  id: string;
  title: string;
  status: string;
  verdict: "accepted" | "rejected" | null;
  workerRunId: string | null;
  reviewerRunId: string | null;
}

/** One of the team's runs: who, and whether it is still at work. */
export interface TeamCardAgent {
  role: "planner" | "worker" | "reviewer" | "lead";
  runId: string;
  state: "active" | "done";
  /** The model it runs on, from the cast list (`TeamRunRef.model`); absent when the board names none. */
  model?: string;
}

/** What the chat's team card and Home's Now section draw without the board. */
export interface TeamCard {
  /** The team's status word; the card's chip. */
  phase: string;
  /** Where it is on its way to its first worker (src/lib/coding-start-phase.ts); null once one is at work. */
  startStep: TeamStartStep | null;
  tasksDone: number;
  tasksTotal: number;
  /** In outline order (the board's), at most TEAM_CARD_TASKS. */
  tasks: TeamCardTask[];
  prNumber: number | null;
  /** The final review's first sentence, or the error's, or null. */
  resultLine: string | null;
  agents: TeamCardAgent[];
}

/** Tasks a card lists; the board keeps them all. */
export const TEAM_CARD_TASKS = 20;
/** A task's title on a card: the brief's first line, this long. */
const TEAM_CARD_TITLE_CHARS = 80;

type CardableTask = {
  task_id: string;
  task_description: string;
  status: string;
  assigned_to?: string | null;
  reviewRunId?: string | null;
  review?: { verdict: "accepted" | "rejected" } | null;
};

type CardableTeam = {
  status: string;
  tasks: readonly CardableTask[];
  runs?: readonly { id: string; role: TeamCardAgent["role"]; taskId: string | null; model?: string | null }[];
  pr?: { number: number } | null;
  finalReview?: { verdict: "accepted" | "rejected"; notes: string } | null;
  error?: string | null;
};

/**
 * The card's figures from a board, however whole or slim the board is.
 *
 * A retired task will never be done, so it is neither counted nor listed
 * (the finish notice counts the same way). An agent is `active` while the
 * board still expects something of it: the planner while the team plans, a
 * worker while its task is in progress, a reviewer while its task is
 * complete and unruled; every other run on the cast list is done.
 */
export function teamCard(team: CardableTeam): TeamCard {
  const tasks = team.tasks.filter((t) => t.status !== "retired");
  const done = tasks.filter((t) => t.status === "complete").length;
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const agents: TeamCardAgent[] = (team.runs ?? []).map((run) => {
    const task = run.taskId ? byId.get(run.taskId) : undefined;
    let active = false;
    if (run.role === "planner") active = team.status === "planning";
    else if (run.role === "worker") active = !!task && task.status === "in_progress" && task.assigned_to === run.id;
    else if (run.role === "reviewer") active = !!task && task.status === "complete" && !task.review && task.reviewRunId === run.id;
    const settled = team.status === "done" || team.status === "failed" || team.status === "stopped";
    const agent: TeamCardAgent = { role: run.role, runId: run.id, state: active && !settled ? "active" : "done" };
    if (typeof run.model === "string" && run.model) agent.model = run.model;
    return agent;
  });
  return {
    phase: team.status,
    startStep: teamStartStep(team),
    tasksDone: done,
    tasksTotal: tasks.length,
    tasks: tasks.slice(0, TEAM_CARD_TASKS).map((t) => ({
      id: t.task_id,
      title: firstSentence(t.task_description, TEAM_CARD_TITLE_CHARS) ?? t.task_id,
      status: t.status,
      verdict: t.review?.verdict ?? null,
      workerRunId: t.assigned_to ?? null,
      reviewerRunId: t.reviewRunId ?? null,
    })),
    prNumber: team.pr?.number ?? null,
    resultLine: firstSentence(team.finalReview?.notes) ?? firstSentence(team.error),
    agents,
  };
}
