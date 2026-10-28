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
 * its artifacts — is taken from the tick.
 *
 * Emptied, not deleted: every field keeps its type, so a slim record the app
 * does not yet hold (a team that settled between two ticks) still draws — a
 * run page with no progress lines, a team card with no log — until the next
 * full read fills it, instead of a `.length` on undefined.
 *
 * Pure: no fs, no React, shared by the routes and the component.
 */
import { isSettled, type CodingRunStatus } from "./coding-agent-status";

/** The run fields a slim read empties on a settled run. */
export interface RunSlimFields {
  progress: string[];
  progressAt?: number[];
  resultText?: string | null;
  pipeline?: unknown;
  allowRules?: string[];
  deniedActions?: string[];
  denials?: unknown[];
}

export type SlimmableRun = RunSlimFields & { id: string; status: CodingRunStatus; slim?: boolean };

/** The settled team statuses, as coding-team-board.ts `isSettledTeamStatus` has them (that module reads the disk, so this one does not import it). */
export function isSettledTeamStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "stopped";
}

export interface TeamTaskSlimFields {
  task_id: string;
  task_description: string;
  result: string | null;
  review: { notes: string } | null;
}

export type SlimmableTeam = {
  id: string;
  status: string;
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
  if ("pipeline" in run) out.pipeline = null;
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

/**
 * The run list after a tick: a slim record over a held full one keeps the
 * held text; everything else comes from the tick. The list's order and
 * membership are the tick's — a run that left the list leaves the app too.
 */
export function mergeSlimRuns<T extends SlimmableRun>(held: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map(held.map((run) => [run.id, run]));
  return incoming.map((run) => {
    const prev = byId.get(run.id);
    if (!run.slim || !prev || prev.slim) return run;
    const merged: T = { ...run, progress: prev.progress, slim: false };
    if ("progressAt" in prev) merged.progressAt = prev.progressAt;
    if ("resultText" in prev) merged.resultText = prev.resultText;
    if ("pipeline" in prev) merged.pipeline = prev.pipeline;
    if ("allowRules" in prev) merged.allowRules = prev.allowRules;
    if ("deniedActions" in prev) merged.deniedActions = prev.deniedActions;
    if ("denials" in prev) merged.denials = prev.denials;
    return merged;
  });
}

/** The team list after a tick, on the same rule: a slim board over a held full one keeps the held log and task text. */
export function mergeSlimTeams<T extends SlimmableTeam>(held: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map(held.map((team) => [team.id, team]));
  return incoming.map((team) => {
    const prev = byId.get(team.id);
    if (!team.slim || !prev || prev.slim) return team;
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
