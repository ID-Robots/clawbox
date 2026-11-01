"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isCodingRunStatus, parsePauseReason, type CodingPauseReason, type CodingRunStatus } from "@/lib/coding-agent-status";
import { onCodingRunStarted, onCodingTeamChanged } from "@/lib/ui-events";
import { isPrPending, isPrPhase, type PrPhase, type PrState } from "@/lib/coding-pr-state";
import { samePlainData } from "@/lib/same-plain-data";
import { isSettledTeamStatus, TEAM_STATUSES, type TeamStatus } from "@/lib/coding-team-status";
import type { TeamCard, TeamCardAgent, TeamCardTask } from "@/lib/coding-agent-slim";
import { isTeamStartStep, readCodingStarts, runRecordStartStep, START_POLL_MS, type CodingStartView, type RunCardStartStep, type TeamStartStep } from "@/lib/coding-start-phase";

/**
 * The coding runs this conversation has seen, and what became of them.
 *
 * WHY THE TOOL PILLS ARE NOT ENOUGH
 *
 * `coding_agent_run` returns as soon as the device has SPAWNED the run — the
 * route answers 202 in milliseconds, by design, because an MCP call must not
 * hold a connection open for twenty minutes. So the chat's tool pill goes
 * "🔧 coding agent run" → "✓" within a second, while the actual work carries
 * on. The pill is telling the truth about the tool call and the wrong thing
 * about the box.
 *
 * WHY A BADGE STAYS AFTER THE RUN ENDS
 *
 * The first version of this dropped the badge the moment the run finished, and
 * on a real box that made it nearly invisible: measured runs here take 9-15
 * seconds, so it appeared and vanished while the owner was still reading the
 * agent's previous message. A delegated run is a thing that HAPPENED in this
 * conversation — the same class of fact as the tool-summary chips, which stay
 * attached to their message — so the badge stays too, and changes tone to
 * report the outcome.
 *
 * Stays, that is, until the OWNER puts it away: the card carries a × and the
 * chat keeps the dismissed run ids (ChatPopup's `dismissedCodingRuns`), with
 * one small 🤖 chip at the end of the transcript that brings every dismissed
 * card back in its place. A card whose run the chat SAW finish cleanly — and
 * whose pull request, if it has one, merged — also goes on its own after five
 * seconds (src/lib/use-coding-run-auto-hide.ts), behind the same chip. This hook knows nothing of either — a hidden run is
 * still a run it holds and polls; only the card is not drawn.
 *
 * WHAT IT ADOPTS, AND WHAT IT LEAVES ALONE
 *
 * Only runs that belong to THIS conversation: one that is in flight right now,
 * or one that started around the time the chat opened (see RECENT_MS).
 * Yesterday's finished runs are history and belong in the Coding Agent app,
 * not in today's transcript.
 *
 * WHY IT COSTS ALMOST NOTHING
 *
 * No steady-state timer. It probes once when the chat opens, again whenever
 * `nudge()` is called (which the chat does the moment a coding-agent tool call
 * goes past, and this hook does itself when the desktop says a run started or
 * the tab comes back into view), polls every five seconds only while a run is
 * actually in flight, and otherwise re-asks once every IDLE_POLL_MS while the
 * chat is open and visible — runs started from the API, MCP, another session
 * or the review pass send this tab no event — plus ONE round after the last live run settled, because the runner
 * persists the settled record before it commits the work and starts the
 * automatic review pass, so the poll that saw the finish cannot yet have seen
 * the run that follows it. An idle box is asked once per chat open and then
 * asked twice a minute, and a closed chat or hidden tab not at all.
 */

export type { CodingRunStatus };
export type CodingTodoStatus = "pending" | "in_progress" | "completed";

/** One item of the run's own plan — see CodingRun.todos in coding-agent.ts. */
export interface CodingTodo {
  content: string;
  status: CodingTodoStatus;
  activeForm?: string;
}

export interface CodingAgentActivity {
  id: string;
  projectId: string | null;
  task: string;
  startedAt: number;
  completedAt: number | null;
  status: CodingRunStatus;
  source: "agent" | "owner";
  /**
   * How the run is spending its effort, live off the same record the Coding
   * Agent app reads. `subagentsActive`/`activeSubagents` exist only while the
   * run is in flight (the server zeroes them when it settles); the totals and
   * the per-type breakdown are cumulative and survive the finish.
   */
  subagentsTotal: number;
  subagentsActive: number;
  subagentsByType: Record<string, number>;
  tokensUsed: number;
  /** Reasoning tokens so far; 0 on a record from before the runner counted them. */
  thinkingTokens: number;
  filesTouched: number;
  /** Agent turns — counted live, then pinned by the final result event. */
  numTurns: number;
  /**
   * The run's newest progress lines, oldest first, at most PROGRESS_SHOWN:
   * the last one is "what it is doing right now", the rest are the card's
   * live-work panel. The runner keeps more on the record; the card has no
   * room for them, so they are cut here rather than held in every badge.
   */
  progress: string[];
  /**
   * The newest screenshots the run saved, oldest first, by file name — the
   * card turns a name into its served URL with artifactUrl(). Images only:
   * the card thumbnails nothing else, so nothing else is kept.
   */
  screenshots: string[];
  /**
   * The run's plan, as it last wrote it with TodoWrite: what it means to do,
   * what it is on now, what is done. Empty for a run that never planned. The
   * runner already caps and trims it; this only refuses a shape it cannot
   * draw.
   */
  todos: CodingTodo[];
  /**
   * What the chat's Live view needs to tail or resume the run: the transcript
   * Claude Code writes, the session to `--resume`, and the folder it works in.
   * Null until the runner has them (the transcript lands seconds after spawn).
   */
  transcriptPath: string | null;
  sessionId: string | null;
  directory: string | null;
  /**
   * Where the run's pull request stands, or null when it has none (auto-PR
   * off, a folder with no repository, a record from before the feature). The
   * card does not draw it; the chat reads it to tell a run that is done with
   * from one still waiting on GitHub or on the owner — see
   * use-coding-run-auto-hide.ts. Optional so a hand-built activity need not
   * carry it.
   */
  prPhase?: PrPhase | null;
  /** The pull request's number, for the settled card's chip; null without one. */
  prNumber?: number | null;
  /**
   * The team this run works for, or null for a run of its own. A member run
   * is never drawn as a card: the team's card shows it (CodingChatCards.tsx),
   * and the hook holds it back — see `useCodingAgentActivity`.
   */
  teamId?: string | null;
  /** The result's first sentence (the runs route's `summaryLine`), for the settled card; null before there is one. */
  summaryLine?: string | null;
  /** A failed run's error, first line, for the settled card in the danger tone. */
  errorLine?: string | null;
  /**
   * The run is PAUSED and waits on the owner — a refused action it cannot go
   * on without, or an allowance that ran out. The card says "Needs you" and
   * its Open lands on the run page's refusal card.
   */
  needsYou?: boolean;
  /** The newest refused action, in the owner's words, when the run needs them for one. */
  refusedLine?: string | null;
  /**
   * WHY a paused run is paused (coding-agent-status.ts `CodingPauseReason`):
   * the card explains an `allowance` pause — which meter ran out and when it
   * is back — since Resume only buys the same refusal until then. Null for an
   * owner's pause, a run never paused, or a record from before the field.
   */
  pauseReason?: CodingPauseReason | null;
  /**
   * Where the run is on its way to its first step of work
   * (src/lib/coding-start-phase.ts): the box's checks, its own copy of the
   * project, the launch, then the harness's first word. Null once it works.
   */
  startStep?: RunCardStartStep | null;
  /**
   * ANNOUNCED, not yet a record: the runs list's `starting`. Nothing on the
   * box answers to its id until the record lands (Pause, the run's page), so
   * the card offers neither. Set on a start that failed, too.
   */
  announced?: boolean;
  /**
   * The model the run answered on (the CLI's own word), every model its usage
   * was billed to, and the one it was started with — the card's model chip
   * (`runModelId` in coding-model-names.ts). Absent on an announced start and
   * on a record from before the fields.
   */
  model?: string | null;
  modelsUsed?: string[];
  requestedModel?: string | null;
}

/**
 * A coding TEAM, as the chat's team card draws it: the slim board's `card`
 * (src/lib/coding-agent-slim.ts `teamCard`) with the few board fields the
 * card names beside it. Polled with the runs, on the same beat.
 */
export interface TeamActivity {
  id: string;
  projectId: string | null;
  directory: string | null;
  /** The goal as written; the card draws its first line. */
  goal: string;
  status: TeamStatus;
  source: "agent" | "owner";
  startedAt: number;
  finishedAt: number | null;
  tasksDone: number;
  tasksTotal: number;
  tasks: TeamCardTask[];
  prNumber: number | null;
  resultLine: string | null;
  agents: TeamCardAgent[];
  tokensUsed: number;
  /** Why the team stopped short, first line, or null. */
  errorLine: string | null;
  /** Where it is on its way to its first worker (src/lib/coding-start-phase.ts); null once one is at work. */
  startStep?: TeamStartStep | null;
  /** A team the box refused to start: no board exists, so nothing opens. */
  announced?: boolean;
}

interface TeamPayload {
  id: string;
  goal?: unknown;
  projectId?: unknown;
  directory?: unknown;
  status?: unknown;
  source?: unknown;
  createdAt?: unknown;
  finishedAt?: unknown;
  error?: unknown;
  metrics?: { tokensUsed?: unknown } | null;
  card?: Partial<TeamCard> | null;
}

interface RunPayload {
  /** The team the run works for; absent or null on a run of its own. */
  team?: { id?: unknown } | null;
  summaryLine?: unknown;
  error?: unknown;
  denials?: { text?: unknown }[];
  deniedActions?: unknown;
  pauseReason?: unknown;
  /** The pull request this run's work went into, when the auto-PR switch is
   *  on. Optional: a run recorded before the feature has none. */
  pr?: PrState | null;
  id: string;
  projectId: string | null;
  task: string;
  status: string;
  startedAt: number;
  completedAt: number | null;
  source: string;
  subagentsTotal?: number;
  subagentsActive?: number;
  subagentsByType?: Record<string, number>;
  tokensUsed?: number;
  thinkingTokens?: number;
  filesTouched?: string[];
  numTurns?: number;
  progress?: string[];
  todos?: unknown;
  artifacts?: { name?: unknown; kind?: unknown }[];
  transcriptPath?: unknown;
  sessionId?: unknown;
  directory?: unknown;
  model?: unknown;
  modelsUsed?: unknown;
  requestedModel?: unknown;
}

const TODO_STATUSES: readonly CodingTodoStatus[] = ["pending", "in_progress", "completed"];
/** The runner's own cap, repeated so a hand-edited record cannot flood a card. */
const TODOS_KEPT = 20;

function toTodos(raw: unknown): CodingTodo[] {
  if (!Array.isArray(raw)) return [];
  const todos: CodingTodo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const t = item as { content?: unknown; status?: unknown; activeForm?: unknown };
    if (typeof t.content !== "string" || !t.content) continue;
    const status = (TODO_STATUSES as readonly unknown[]).includes(t.status) ? t.status as CodingTodoStatus : "pending";
    const activeForm = typeof t.activeForm === "string" && t.activeForm ? t.activeForm : undefined;
    todos.push(activeForm ? { content: t.content, status, activeForm } : { content: t.content, status });
    if (todos.length >= TODOS_KEPT) break;
  }
  return todos;
}

/** How often to re-ask while a run is actually in flight. */
const POLL_MS = 5_000;
/** The quick beat while something is starting (src/lib/coding-start-phase.ts). */
export { START_POLL_MS };
/** How long after a nudge the chat keeps the start beat when nothing is listed yet: the tool's request may reach the box a moment after its event. */
export const START_WATCH_MS = 10_000;
/** How often to re-ask while nothing is in flight and the chat is visible. */
export const IDLE_POLL_MS = 30_000;
/** Enough to catch a run even if a couple of others finished meanwhile. */
const LOOK_BACK = 5;
/** Progress lines a card lists when expanded. */
const PROGRESS_SHOWN = 8;
/** Screenshots a card thumbnails; the Coding Agent app shows the whole folder. */
const SCREENSHOTS_SHOWN = 3;

/** The served URL of one run artifact — cookie auth rides along like any app asset. */
export function artifactUrl(runId: string, name: string): string {
  return `/setup-api/coding-agent/artifacts?runId=${encodeURIComponent(runId)}&file=${encodeURIComponent(name)}`;
}
/** Cards kept in one conversation — runs and teams each, oldest dropped first. */
export const MAX_BADGES = 6;
/**
 * How far back a finished run still counts as "this conversation".
 *
 * Not zero: a run that ended in the seconds before the chat opened is the one
 * the owner is about to ask about, and hiding its badge would be the same
 * disappearing act this whole file exists to fix. Not unbounded either —
 * yesterday's runs are history and belong in the Coding Agent app.
 */
const RECENT_MS = 120_000;

function toActivity(r: RunPayload): CodingAgentActivity {
  return {
    id: r.id,
    projectId: r.projectId,
    task: r.task,
    startedAt: r.startedAt,
    completedAt: typeof r.completedAt === "number" ? r.completedAt : null,
    status: isCodingRunStatus(r.status) ? r.status : "completed",
    source: r.source === "owner" ? "owner" : "agent",
    subagentsTotal: typeof r.subagentsTotal === "number" ? r.subagentsTotal : 0,
    subagentsActive: typeof r.subagentsActive === "number" ? r.subagentsActive : 0,
    subagentsByType: r.subagentsByType && typeof r.subagentsByType === "object" ? r.subagentsByType : {},
    tokensUsed: typeof r.tokensUsed === "number" ? r.tokensUsed : 0,
    thinkingTokens: typeof r.thinkingTokens === "number" ? r.thinkingTokens : 0,
    filesTouched: Array.isArray(r.filesTouched) ? r.filesTouched.length : 0,
    numTurns: typeof r.numTurns === "number" ? r.numTurns : 0,
    progress: Array.isArray(r.progress)
      ? r.progress.filter((p): p is string => typeof p === "string").slice(-PROGRESS_SHOWN)
      : [],
    // The route lists a run's folder oldest first; the newest few are the
    // ones worth a thumbnail (the last screenshot is the state of the page).
    screenshots: Array.isArray(r.artifacts)
      ? r.artifacts
        .filter((a) => a && a.kind === "image" && typeof a.name === "string" && a.name)
        .map((a) => a.name as string)
        .slice(-SCREENSHOTS_SHOWN)
      : [],
    todos: toTodos(r.todos),
    transcriptPath: typeof r.transcriptPath === "string" && r.transcriptPath ? r.transcriptPath : null,
    sessionId: typeof r.sessionId === "string" && r.sessionId ? r.sessionId : null,
    directory: typeof r.directory === "string" && r.directory ? r.directory : null,
    prPhase: toPrPhase(r.pr),
    prNumber: r.pr && typeof r.pr.number === "number" ? r.pr.number : null,
    teamId: r.team && typeof r.team.id === "string" && r.team.id ? r.team.id : null,
    summaryLine: typeof r.summaryLine === "string" && r.summaryLine ? r.summaryLine : null,
    errorLine: firstLineOf(r.error),
    needsYou: r.status === "paused",
    refusedLine: refusedLineOf(r),
    pauseReason: parsePauseReason(r.pauseReason),
    startStep: runRecordStartStep({ status: r.status, sessionId: typeof r.sessionId === "string" ? r.sessionId : null, numTurns: r.numTurns }),
    announced: false,
    model: typeof r.model === "string" && r.model ? r.model : null,
    modelsUsed: Array.isArray(r.modelsUsed) ? r.modelsUsed.filter((m): m is string => typeof m === "string" && m.length > 0) : [],
    requestedModel: typeof r.requestedModel === "string" && r.requestedModel ? r.requestedModel : null,
  };
}

/** A run start as a run card draws it: "Starting…" at its step, or failed with the reason. */
function startActivity(start: CodingStartView): CodingAgentActivity {
  const failed = start.failedAt !== null;
  return {
    id: start.id,
    projectId: start.projectId,
    task: start.task,
    startedAt: start.requestedAt,
    completedAt: failed ? start.failedAt : null,
    status: failed ? "failed" : "running",
    source: start.source,
    subagentsTotal: 0,
    subagentsActive: 0,
    subagentsByType: {},
    tokensUsed: 0,
    thinkingTokens: 0,
    filesTouched: 0,
    numTurns: 0,
    progress: [],
    screenshots: [],
    todos: [],
    transcriptPath: null,
    sessionId: null,
    directory: start.directory,
    errorLine: failed ? start.error : null,
    startStep: failed ? null : start.step,
    announced: true,
  };
}

/** A team the box refused to start, as the team card draws a team that failed. */
function startTeamActivity(start: CodingStartView): TeamActivity {
  return {
    id: start.id,
    projectId: start.projectId,
    directory: start.directory,
    goal: start.task,
    status: "failed",
    source: start.source,
    startedAt: start.requestedAt,
    finishedAt: start.failedAt ?? start.requestedAt,
    tasksDone: 0,
    tasksTotal: 0,
    tasks: [],
    prNumber: null,
    resultLine: null,
    agents: [],
    tokensUsed: 0,
    errorLine: start.error,
    startStep: null,
    announced: true,
  };
}

/** The first non-empty line of a text, cut to the card's width. */
function firstLineOf(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  return line.length > 160 ? line.slice(0, 159).trimEnd() + "…" : line;
}

/** The newest refused action on the record, from either list the record keeps (CodingRunDenials.tsx says why there are two). */
function refusedLineOf(r: RunPayload): string | null {
  const structured = Array.isArray(r.denials) ? r.denials.map((d) => d?.text).filter((t): t is string => typeof t === "string" && t.length > 0) : [];
  const plain = Array.isArray(r.deniedActions) ? r.deniedActions.filter((t): t is string => typeof t === "string" && t.length > 0) : [];
  const list = structured.length > 0 ? structured : plain;
  return list.length > 0 ? firstLineOf(list[list.length - 1]) : null;
}

/** A slim board's row as the team card draws it; null for a shape it cannot draw. */
function toTeam(t: TeamPayload): TeamActivity | null {
  if (typeof t.id !== "string" || !t.id) return null;
  const status = (TEAM_STATUSES as readonly unknown[]).includes(t.status) ? t.status as TeamStatus : "working";
  const card = t.card ?? {};
  return {
    id: t.id,
    projectId: typeof t.projectId === "string" ? t.projectId : null,
    directory: typeof t.directory === "string" && t.directory ? t.directory : null,
    goal: typeof t.goal === "string" ? t.goal : "",
    status,
    source: t.source === "owner" ? "owner" : "agent",
    startedAt: typeof t.createdAt === "number" ? t.createdAt : 0,
    finishedAt: typeof t.finishedAt === "number" ? t.finishedAt : null,
    tasksDone: typeof card.tasksDone === "number" ? card.tasksDone : 0,
    tasksTotal: typeof card.tasksTotal === "number" ? card.tasksTotal : 0,
    tasks: Array.isArray(card.tasks) ? card.tasks : [],
    prNumber: typeof card.prNumber === "number" ? card.prNumber : null,
    resultLine: typeof card.resultLine === "string" && card.resultLine ? card.resultLine : null,
    agents: Array.isArray(card.agents) ? card.agents : [],
    tokensUsed: typeof t.metrics?.tokensUsed === "number" ? t.metrics.tokensUsed : 0,
    errorLine: firstLineOf(t.error),
    startStep: isTeamStartStep(card.startStep) ? card.startStep : null,
    announced: false,
  };
}

/**
 * Where the run's pull request stands — null when there is none. A record
 * that went `blocked` without ever getting a number is a pull request the box
 * never opened: the run committed nothing (maybeOpenPullRequest in
 * coding-agent.ts), so there is nothing on GitHub and nothing for the owner
 * to decide. Every other `blocked` is written by the watcher of a pull
 * request that exists.
 */
function toPrPhase(pr: PrState | null | undefined): PrPhase | null {
  if (!pr || !isPrPhase(pr.phase)) return null;
  if (pr.phase === "blocked" && pr.number == null) return null;
  return pr.phase;
}

/** The same runs, in the same order, each the very object already held. */
function sameRuns(a: readonly CodingAgentActivity[], b: readonly CodingAgentActivity[]): boolean {
  return a.length === b.length && a.every((run, i) => run === b[i]);
}

/**
 * True when the tool the chat just saw is one of the coding family — a run,
 * a team, a run message, a project tool, or the scaffold that precedes a run
 * (`code_project_init`): each of them may have started, or be about to
 * start, something a card should show.
 */
export function isCodingAgentTool(name: string): boolean {
  return /coding_(agent|team|run|project)|code_project_init/i.test(name);
}

/** The same teams, in the same order, each the very object already held. */
function sameTeams(a: readonly TeamActivity[], b: readonly TeamActivity[]): boolean {
  return a.length === b.length && a.every((team, i) => team === b[i]);
}

/**
 * How many polls a member run whose team the list does not hold yet is held
 * back before it is shown on its own: the run record can land a poll before
 * its board is listed, and a card that appears for one poll and vanishes
 * into the team card is a flicker.
 */
const MEMBER_HOLD_POLLS = 1;

export function useCodingAgentActivity(active: boolean): {
  /** Runs of their own — a team's member runs are left to the team's card. */
  runs: CodingAgentActivity[];
  /** The teams this conversation has seen, oldest first. */
  teams: TeamActivity[];
  nudge: () => void;
} {
  const [runs, setRuns] = useState<CodingAgentActivity[]>([]);
  const [teams, setTeams] = useState<TeamActivity[]>([]);
  // Member runs seen without their team, and for how many polls: shown on
  // their own only once the hold has passed (MEMBER_HOLD_POLLS).
  const orphanPolls = useRef(new Map<string, number>());
  // When each announced start's request arrived, by run id: the record that
  // takes its card over is stamped when it is WRITTEN — after the checks,
  // the worktree, a wait on the folder's lock — and its clock must not jump
  // back by that much in front of the owner.
  const requestedAt = useRef(new Map<string, number>());
  // Bumped by nudge(); the effect below re-runs and probes immediately.
  const [probe, setProbe] = useState(0);
  // When this conversation started caring. A run older than this belongs to a
  // previous conversation and is not adopted.
  const openedAtRef = useRef(0);
  // Until when a nudge keeps the start beat (START_WATCH_MS): a coding tool's
  // event can reach the chat a moment before its request reaches the box.
  const watchUntilRef = useRef(0);

  const nudge = useCallback(() => {
    watchUntilRef.current = Date.now() + START_WATCH_MS;
    setProbe((n) => n + 1);
  }, []);

  // The two probe sources the chat itself cannot see: a run started from the
  // Coding Agent app (or finished, as the desktop's notice reports) while the
  // chat sat open, and a tab that was hidden while a run came and went. Both
  // are one re-ask, not a timer — and neither is listened for while the chat
  // is closed, which is when this hook asks nothing at all.
  useEffect(() => {
    if (!active) return;
    const onVisible = () => { if (document.visibilityState === "visible") nudge(); };
    const off = onCodingRunStarted(nudge);
    const offTeam = onCodingTeamChanged(nudge);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      off();
      offTeam();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, nudge]);

  useEffect(() => {
    if (!active) {
      // `prev` when there is nothing to drop: a new empty array is still a
      // new state, and a render of the chat for it.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the chat closed: the cards it held go with it
      setRuns((prev) => (prev.length === 0 ? prev : []));
      setTeams((prev) => (prev.length === 0 ? prev : []));
      orphanPolls.current.clear();
      requestedAt.current.clear();
      openedAtRef.current = 0;
      return;
    }
    if (openedAtRef.current === 0) openedAtRef.current = Date.now();

    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Whether a poll of THIS probe has seen a run in flight — the one round
    // that follows its settling is owed only then.
    let sawLive = false;

    // A run started where this chat cannot see it (the API or MCP, another
    // session, the automatic review pass) fires no event here. So while the
    // chat is open and the tab visible, ask again slowly. A hidden tab is not
    // asked; the visibilitychange nudge re-probes when it comes back.
    const scheduleIdle = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      timer = setTimeout(() => { void read(); }, IDLE_POLL_MS);
    };

    const read = async () => {
      try {
        // `artifacts=1` on EVERY poll, not only for the runs a card has
        // expanded. The route's listing is one readdir plus one stat per file
        // for each of the LOOK_BACK runs — and most runs never save anything,
        // so for them it is a single failed open. Measured against the
        // alternative (a second fetch shape, and the card's expanded state
        // plumbed up into this hook so it knows which runs to ask for), the
        // per-poll cost is a handful of syscalls every five seconds while a
        // run is in flight, and nothing at all once it is not; the plumbing
        // would be the larger cost, paid in code.
        // The runs and the teams on ONE beat: two requests in flight
        // together, one timer. The team list may be refused (403 to a
        // signed-in person who is not the owner — the team route is
        // owner-only); then the teams this chat holds are left as they are
        // and the runs still come through.
        const [res, teamRes] = await Promise.all([
          fetch(`/setup-api/coding-agent/runs?limit=${LOOK_BACK}&artifacts=1`, { cache: "no-store" }),
          fetch("/setup-api/coding-agent/team?slim=1", { cache: "no-store" }).catch(() => null),
        ]);
        if (!res.ok) throw new Error("runs");
        const data = await res.json() as { runs?: RunPayload[]; starting?: unknown };
        let fetchedTeams: TeamPayload[] | null = null;
        if (teamRes && teamRes.ok) {
          try {
            const teamData = await teamRes.json() as { teams?: TeamPayload[] };
            fetchedTeams = Array.isArray(teamData.teams) ? teamData.teams : [];
          } catch {
            fetchedTeams = null;
          }
        }
        if (!alive) return;
        const fetched = data.runs ?? [];
        const listedTeams = new Set((fetchedTeams ?? []).map((t) => t.id));
        // The starts the box announced and the ones it refused (the runs
        // list's `starting`, src/lib/coding-run-starts.ts). A start whose
        // record is listed is the record's to show.
        const recorded = new Set(fetched.map((r) => r.id));
        const starts = readCodingStarts(data.starting).filter((x) => !recorded.has(x.id));
        const inFlight = new Set(starts.filter((x) => x.failedAt === null).map((x) => x.id));

        setTeams((prev) => {
          if (fetchedTeams === null) return prev;
          const byId = new Map(prev.map((t) => [t.id, t]));
          for (const raw of fetchedTeams) {
            const team = toTeam(raw);
            if (!team) continue;
            const known = byId.get(team.id);
            // Adopted on the run's rule: at work now, or begun around the
            // time the chat opened; yesterday's teams are the app's history.
            const mine = known !== undefined
              || !isSettledTeamStatus(team.status)
              || team.startedAt >= openedAtRef.current - RECENT_MS;
            if (mine) byId.set(team.id, known && samePlainData(known, team) ? known : team);
          }
          // A team the box refused to start has no board: its card says why.
          for (const start of starts) {
            if (start.kind !== "team") continue;
            const known = byId.get(start.id);
            if (known === undefined && start.requestedAt < openedAtRef.current - RECENT_MS) continue;
            const team = startTeamActivity(start);
            byId.set(start.id, known && samePlainData(known, team) ? known : team);
          }
          const next = [...byId.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_BADGES);
          return sameTeams(prev, next) ? prev : next;
        });

        setRuns((prev) => {
          const byId = new Map(prev.map((r) => [r.id, r]));
          const orphans = orphanPolls.current;
          for (const raw of fetched) {
            const record = toActivity(raw);
            const asked = requestedAt.current.get(record.id);
            const run = asked !== undefined && asked < record.startedAt ? { ...record, startedAt: asked } : record;
            // A team's member run is the team card's to show, never a card of
            // its own. Its team may land in the list a poll after the run
            // does, so a member whose team is not listed yet is HELD for a
            // poll rather than drawn and then withdrawn.
            if (run.teamId) {
              if (fetchedTeams === null || listedTeams.has(run.teamId)) {
                orphans.delete(run.id);
                byId.delete(run.id);
                continue;
              }
              const seen = (orphans.get(run.id) ?? 0) + 1;
              orphans.set(run.id, seen);
              if (seen <= MEMBER_HOLD_POLLS) continue;
            }
            // Adopt what belongs to this conversation: in flight now, or
            // started around the time the chat opened (a 9-second run can
            // begin and end between two polls, and it still happened here).
            const known = byId.get(run.id);
            const mine = known !== undefined
              || run.status === "running"
              || run.startedAt >= openedAtRef.current - RECENT_MS;
            // A run whose record has not moved keeps the object already on
            // screen, so its card is handed the same props it drew last time.
            if (mine) byId.set(run.id, known && samePlainData(known, run) ? known : run);
          }
          // Announced starts: "Starting…" from the moment the request
          // arrived, under the id the record will take — so the record, when
          // it lands, replaces this card in place rather than beside it.
          for (const start of starts) {
            if (start.kind !== "run") continue;
            const known = byId.get(start.id);
            const mine = known !== undefined
              || start.failedAt === null
              || start.requestedAt >= openedAtRef.current - RECENT_MS;
            if (!mine) continue;
            const run = startActivity(start);
            requestedAt.current.set(start.id, start.requestedAt);
            byId.set(start.id, known && samePlainData(known, run) ? known : run);
          }
          // A start that is neither on its way nor recorded any more went
          // somewhere this list cannot follow (dropped as stale): its
          // "Starting…" must not tick on for ever. One that FAILED stays,
          // with its reason, until the owner puts it away.
          for (const [id, run] of byId) {
            if (run.announced && run.status === "running" && !inFlight.has(id) && !recorded.has(id)) byId.delete(id);
          }
          const next = [...byId.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_BADGES);
          // Nothing moved: the SAME array, so React skips the render. Every
          // poll parses a fresh answer, and handing that back unconditionally
          // re-rendered the whole chat every five seconds for as long as a run
          // was live or a pull request pending — the run idling on a long
          // build, the PR waiting on CI — to draw exactly what was on screen.
          return sameRuns(prev, next) ? prev : next;
        });

        // Keep asking only while there is something to ask about — and once
        // more after a run this probe watched settle: the record is written
        // as settled BEFORE the commit and the review pass that follow it,
        // so the poll that saw the finish could not have seen either.
        // A run waiting on GitHub Actions has settled but is still changing,
        // so the chat card keeps polling for it too — see CodingAgentApp.
        // A team at work keeps the beat too.
        const teamLive = (fetchedTeams ?? []).some((t) => typeof t.status === "string" && !isSettledTeamStatus(t.status as TeamStatus));
        // Something STARTING moves on in seconds: the quick beat, for as long
        // as it is starting (and a moment after a coding tool went by).
        const starting = inFlight.size > 0
          || Date.now() < watchUntilRef.current
          || fetched.some((r) => runRecordStartStep({ status: r.status, sessionId: typeof r.sessionId === "string" ? r.sessionId : null, numTurns: r.numTurns }) !== null)
          || (fetchedTeams ?? []).some((t) => t.card?.startStep === "planner_starting" || t.card?.startStep === "worker_starting");
        if (starting) {
          sawLive = true;
          timer = setTimeout(() => { void read(); }, START_POLL_MS);
        } else if (teamLive || fetched.some((r) => r.status === "running" || r.status === "queued" || isPrPending(r.pr))) {
          // A QUEUED run is on the five-second beat too: its slot can open
          // at any moment, and nothing tells the chat when it does.
          sawLive = true;
          timer = setTimeout(() => { void read(); }, POLL_MS);
        } else if (sawLive) {
          sawLive = false;
          timer = setTimeout(() => { void read(); }, POLL_MS);
        } else {
          scheduleIdle();
        }
      } catch {
        // The device is the source of truth and it did not answer. Leave the
        // badges already on screen alone rather than rewriting history from a
        // failed request — but do not go silent for good either: one blip
        // used to stop all polling until the page was reloaded.
        if (alive) scheduleIdle();
      }
    };

    void read();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [active, probe]);

  return { runs, teams, nudge };
}
