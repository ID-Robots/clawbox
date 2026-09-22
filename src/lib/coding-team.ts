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
 * MAX_ALERTS the team stops (a reviewer that could not start is alerted but
 * not counted; one that waits for room is neither). A failed task fails the
 * team unless other tasks can still run; a task the reviewer rejects is
 * re-posted once.
 *
 * A team lives in this process; its board is on disk after every message.
 * A team the web server was restarted under is settled as failed on the
 * next read, with the reason, never left "working" forever.
 */

import { randomUUID } from "crypto";
import {
  CodingAgentError,
  getRun,
  isCodingAgentEnabled,
  MAX_TASK_CHARS,
  MAX_TEAM_WORKERS,
  noteTeamMessageSent,
  queueRunMessage,
  resolveWorkingDirectory,
  startRun,
  stopRun,
  teamSpawnSlot,
  waitForRun,
  type CodingRun,
  type CodingRunSource,
  type RunTeam,
} from "@/lib/coding-agent";
import { RUNNER_STEP } from "@/lib/coding-agent-progress";
import { RunMessageError, teammatePrefix } from "@/lib/coding-run-messages";
import {
  normalizeTeamMessage,
  ownerAgentMessage,
  rateLimitedError,
  RUN_ID_RE,
  TEAM_MESSAGE_TARGETS,
  TEAM_ROLES,
  teamMessageAllowance,
  TeamMessageError,
  type TeamMessageRefusal,
  type TeamMessageTarget,
  type TeamRole,
} from "@/lib/coding-team-messages";
import { addWorkerWorktree, changedFiles, ensureTeamBranch, isGeneratedArtifact, mergeWorkerBranch, removeWorktree } from "@/lib/coding-team-worktree";
import { parseVerdict, REVIEWER_BRIEF, reviewerTask } from "@/lib/coding-team-reviewer";
import { isLive, isSettled } from "@/lib/coding-agent-status";
import {
  allComplete,
  BoardAccessError,
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
import { TeamBus, type TeamMessage } from "@/lib/coding-team-bus";
import { parsePlan, PLANNER_BRIEF, replanTask } from "@/lib/coding-team-planner";

/** A team stops after this many alerts: something is going wrong repeatedly. */
export const MAX_ALERTS = 3;
/** How long the orchestrator waits on one run per poll; the runner caps a wait anyway. */
const WAIT_SLICE_MS = 60_000;
/** How long the loop waits for a slot (memory, the cap) before looking again. */
const SLOT_WAIT_MS = 15_000;
/** How often a run that is HELD (paused by the owner) is looked at again. */
const HELD_POLL_MS = 2_000;
/** How often a reviewer waiting for room (the team's slots, the memory guard) asks again. */
const REVIEWER_SLOT_POLL_MS = 3_000;
/** A planner or a worker that has not settled by then is stopped and the team failed. */
export const RUN_BUDGET_MS = 60 * 60_000;
/** Sibling results quoted into a worker's task are cut here each. */
const RESULT_QUOTE_CHARS = 400;
/** A teammate at work is named by its run and its task's first line, cut here. */
const TEAMMATE_QUOTE_CHARS = 160;

export const WORKER_BRIEF = [
  "You are ONE WORKER of a small coding team. The task you were given is one part of a larger goal; other workers do the other parts in their own sessions, before or after you.",
  "Do your task and only your task: do not redo, undo or 'improve' the parts that belong to others, and stay inside the files your task names unless the task cannot be done otherwise — say so in your report if you had to.",
  "Scratch files — a page or script you write only to verify your work, notes to yourself — go in your evidence folder, never in the project: a file outside your task's files counts as straying, even a temporary one.",
  "Your final message is read by the team's reviewer and quoted to the next worker: state what you changed (file names), how it can be checked, and anything you could not finish.",
  "If you are blocked — you need a teammate's output first, the files your task names do not exist or are wrong, or a decision only the owner can take — say so in one short team_message (to a sibling run, to the lead, or to the owner's assistant), never for progress reports, and never answer a message a teammate sent you just to acknowledge it.",
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
  /**
   * Team messages on their way to the assistant's chat, per sending run: the
   * one delivery that awaits, counted against the caps while it does so two
   * sends in flight cannot both take the last slot.
   */
  pendingMessages: Map<string, number>;
  /**
   * Alerts that do not count toward MAX_ALERTS: a reviewer that could not
   * start is a review missed, not the team's work going wrong. Two of them
   * and one real alert failed a team whose every deliverable was on disk
   * (bench, 2026-09-22).
   */
  uncountedAlerts: number;
  done: Promise<void>;
}

const live = new Map<string, LiveTeam>();

/** Planner runs a team will pay for before giving up on getting an array. */
const MAX_PLANNER_ATTEMPTS = 3;

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
  const team: LiveTeam = { board, bus, stopRequested: false, currentRunIds: new Set(), pendingMessages: new Map(), uncountedAlerts: 0, done: Promise.resolve() };
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

// ─── Team messages (coding-team-messages.ts) ─────────────────────────────────

/** How long the assistant's chat gets to take a message; the MCP client waits longer. */
export const OWNER_AGENT_TIMEOUT_MS = 10_000;

export interface TeamMessageInput {
  teamId: unknown;
  fromRunId: unknown;
  /** The role the sending run's environment claims; checked against the board. */
  role: unknown;
  to: unknown;
  toRunId?: unknown;
  text: unknown;
}

export interface TeamMessageSent {
  to: TeamMessageTarget;
  toRunId: string | null;
  /**
   * sibling: true when the receiving harness has it in this turn, false when
   * it is queued for that run's next turn. lead and owner_agent: true.
   */
  delivered: boolean;
  /** owner_agent: the chat session it was posted into. */
  sessionKey?: string;
  at: number;
  /** Messages the sending run may still send. */
  left: number;
}

/**
 * A run of a live team says something to a sibling, to the lead or to the
 * box's main agent — `POST /setup-api/coding-agent/team/message`, reached
 * from the run's own MCP server (`team_message`).
 *
 * The sender is checked against the BOARD, not believed: it must be on the
 * cast list in the role it claims, its record must say the same team and role,
 * and it must be running. A run speaks only as itself — the rule the bus holds
 * a worker's status update to — and the variables its MCP server was started
 * with are its name, not a pass.
 *
 * Every refusal of the SENDER's (the text, the claim, the target, the caps) is
 * logged on the board as an alert through the bus, like any message the bus
 * would not take, and throws a TeamMessageError with its code. A message the
 * BOX could not hand on (no chat session, the Hermes edition, a gateway that
 * refused it) is logged as an undelivered message instead — never an alert —
 * and throws its code too. A delivered message is a `message` entry on the
 * board, a line on the sender's own feed, and, for a sibling, a queued message
 * on the receiver's record prefixed with who sent it. Nothing is forwarded on
 * from there: a run that receives a message is told not to answer it just to
 * acknowledge it, and the lead never answers at all.
 */
export async function sendTeamMessage(input: TeamMessageInput): Promise<TeamMessageSent> {
  const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
  const fromRunId = typeof input.fromRunId === "string" ? input.fromRunId.trim() : "";
  const role = typeof input.role === "string" ? input.role.trim() : "";
  const to = typeof input.to === "string" ? input.to.trim() : "";
  const toRunId = typeof input.toRunId === "string" && input.toRunId.trim() ? input.toRunId.trim() : null;
  if (!TEAM_ID_RE.test(teamId) || !RUN_ID_RE.test(fromRunId)) throw new TeamMessageError("INVALID", "A team message names its team (teamId) and the run sending it (fromRunId).");
  if (!(TEAM_ROLES as readonly string[]).includes(role)) throw new TeamMessageError("INVALID", `role is one of ${TEAM_ROLES.join(", ")}.`);
  if (!(TEAM_MESSAGE_TARGETS as readonly string[]).includes(to)) throw new TeamMessageError("INVALID", `to is one of ${TEAM_MESSAGE_TARGETS.join(", ")}.`);
  const target = to as TeamMessageTarget;
  const sender = role as TeamRole;
  if (target === "sibling" && (!toRunId || !RUN_ID_RE.test(toRunId))) {
    throw new TeamMessageError("INVALID", "A message to a sibling names its run: toRunId, e.g. run-ab12cd34.");
  }

  const team = live.get(teamId);
  if (!team) {
    if (!loadBoard(teamId)) throw new TeamMessageError("NOT_FOUND", "There is no coding team with that id.");
    throw new TeamMessageError("SETTLED", `Team ${teamId} is no longer working; there is nobody left to tell.`);
  }
  const { board, bus } = team;
  if (isSettledStatus(board.status)) throw new TeamMessageError("SETTLED", `Team ${teamId} is no longer working; there is nobody left to tell.`);

  const actor: Actor = sender === "worker" ? worker(fromRunId) : sender === "planner" ? PLANNER : REVIEWER;
  const draft: TeamMessage = {
    type: "message",
    from_run_id: fromRunId,
    to: target,
    ...(target === "sibling" && toRunId ? { to_run_id: toRunId } : {}),
    text: typeof input.text === "string" ? input.text : "",
  };
  // The sender's refusals: on the board as an alert — the bus's own words for
  // a message it would not take — then the code to the caller.
  const refused = (code: TeamMessageRefusal, reason: string, nextAllowedAt: number | null = null): TeamMessageError => {
    try {
      bus.refuse(actor, draft, `${code}: ${reason}`);
    } catch {
      // refuse() always throws once the alert is logged; the caller gets the code.
    }
    return new TeamMessageError(code, reason, nextAllowedAt);
  };

  const ref = board.runs.find((r) => r.id === fromRunId);
  const run = getRun(fromRunId);
  if (!ref || ref.role !== sender || !run || run.team?.id !== teamId || run.team.role !== sender || !isLive(run.status)) {
    throw refused("FORBIDDEN", `${fromRunId} is not a running ${sender} of team ${teamId}; a run speaks only as itself.`);
  }
  let text: string;
  try {
    text = normalizeTeamMessage(input.text);
  } catch (err) {
    if (err instanceof TeamMessageError) throw refused(err.code, err.message);
    throw err;
  }
  draft.text = text;
  if (target === "sibling") {
    if (toRunId === fromRunId) throw refused("SELF", "A run does not send a message to itself.");
    if (!board.runs.some((r) => r.id === toRunId)) throw refused("NOT_IN_TEAM", `${toRunId} is not a run of team ${teamId}. ${reachable(board, fromRunId)}`);
    const receiver = getRun(toRunId!);
    if (!receiver || isSettled(receiver.status)) throw refused("SETTLED", `${toRunId} has finished; there is nothing left to tell it.`);
  }
  const now = Date.now();
  const pending = team.pendingMessages.get(fromRunId) ?? 0;
  const allowance = teamMessageAllowance([...(ref.sentAt ?? []), ...Array.from({ length: pending }, () => now)], now);
  if (!allowance.ok) {
    const limited = rateLimitedError(allowance);
    throw refused("RATE_LIMITED", limited.message, limited.nextAllowedAt);
  }

  // The delivery.
  let delivered = true;
  let sessionKey: string | undefined;
  let undelivered: { code: TeamMessageRefusal; reason: string } | null = null;
  team.pendingMessages.set(fromRunId, pending + 1);
  try {
    if (target === "sibling") {
      try {
        // Prefixed with the VERIFIED sender: the receiver's harness is told who
        // said it (runMessageTurn), and its page shows the same line.
        delivered = queueRunMessage(toRunId!, `${teammatePrefix(sender, fromRunId)} ${text}`).delivered;
      } catch (err) {
        if (err instanceof RunMessageError && err.code === "settled") throw refused("SETTLED", `${toRunId} has finished; there is nothing left to tell it.`);
        if (err instanceof RunMessageError && err.code === "queue_full") throw refused("QUEUE_FULL", `${toRunId} has not read the messages it already has; do not send it more until it has.`);
        if (err instanceof CodingAgentError && err.kind === "not_found") throw refused("NOT_IN_TEAM", `${toRunId} is not a run of team ${teamId}.`);
        throw err;
      }
    } else if (target === "owner_agent") {
      const posted = await postToOwnerAgent(teamId, sender, fromRunId, text);
      if (posted.ok) sessionKey = posted.sessionKey;
      else undelivered = posted;
    }
    // The lead: the board entry below IS the delivery.
  } finally {
    const left = (team.pendingMessages.get(fromRunId) ?? 1) - 1;
    if (left > 0) team.pendingMessages.set(fromRunId, left);
    else team.pendingMessages.delete(fromRunId);
  }

  // On the board — validated, capped, persisted, audit-logged — as the run's
  // message, delivered or not. The team's alert count is not touched. Logged
  // even if the team settled while the assistant's chat was being reached:
  // the message went, and the audit trail says so.
  try {
    bus.send(actor, { ...draft, ...(undelivered ? { undelivered: undelivered.code } : {}) });
  } catch (err) {
    if (err instanceof BoardAccessError) throw new TeamMessageError("FORBIDDEN", err.message);
    throw err;
  }
  if (undelivered) throw new TeamMessageError(undelivered.code, undelivered.reason);

  // …and on the sender's own feed, so its page shows what it said.
  try {
    noteTeamMessageSent(
      fromRunId,
      target === "sibling"
        ? RUNNER_STEP.teamMessageToRun(toRunId!, text)
        : target === "lead"
          ? RUNNER_STEP.teamMessageToLead(text)
          : RUNNER_STEP.teamMessageToAssistant(text),
    );
  } catch {
    // The feed is the page's copy; the board already holds the record.
  }
  return { to: target, toRunId: target === "sibling" ? toRunId : null, delivered, ...(sessionKey ? { sessionKey } : {}), at: now, left: allowance.left - 1 };
}

/**
 * The teammates a run could message right now, said in one sentence — the
 * answer a run that named the wrong one needs, since a worker only knows the
 * run ids its task text listed when it started.
 */
function reachable(board: TeamBoard, fromRunId: string): string {
  const others = board.runs.filter((r) => r.id !== fromRunId && isHeldRun(r.id));
  if (!others.length) return "No other run of the team is at work now; tell the lead instead.";
  return `Its runs at work now: ${others.map((r) => `${r.id} (${r.role}${r.taskId ? `, ${r.taskId}` : ""})`).join(", ")}.`;
}

function isHeldRun(runId: string): boolean {
  const run = getRun(runId);
  return run !== null && !isSettled(run.status);
}

/**
 * Post into the box's main agent's chat: the session the web chat is bound to,
 * on the OpenClaw gateway. Loaded lazily — the harness and the gateway link
 * are nothing the rest of the orchestrator needs.
 */
async function postToOwnerAgent(
  teamId: string,
  role: TeamRole,
  runId: string,
  text: string,
): Promise<{ ok: true; sessionKey: string } | { ok: false; code: TeamMessageRefusal; reason: string }> {
  const { getActiveHarness } = await import("@/lib/harness");
  if ((await getActiveHarness()) !== "openclaw") {
    return { ok: false, code: "UNSUPPORTED", reason: "This box's assistant runs on Hermes, which gives a coding run no way into its chat; tell the lead instead." };
  }
  const gateway = await import("@/lib/openclaw-gateway-ws");
  try {
    const { sessionKey } = await gateway.gatewayWsChatSendMain(ownerAgentMessage(teamId, role, runId, text), {
      idempotencyKey: randomUUID(),
      timeoutMs: OWNER_AGENT_TIMEOUT_MS,
    });
    return { ok: true, sessionKey };
  } catch (err) {
    if (err instanceof gateway.GatewayWsUnavailableError) {
      return { ok: false, code: "NO_SESSION", reason: "There is no assistant chat session to post into right now: the OpenClaw gateway is not answering. The message was not delivered." };
    }
    return { ok: false, code: "NOT_DELIVERED", reason: `The assistant's chat did not take the message: ${firstLine(err instanceof Error ? err.message : String(err), 200)}` };
  }
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
  let answer = planned.resultText ?? planned.summary;
  let plan = parsePlan(answer);
  // More than one correction, because one was not enough. On the box, a planner
  // told only to "shorten" a 2835-character description answered 3013 the second
  // time and the board died with no task ever posted — twice, on two devices.
  // Each ask now carries every fault and how far over the limit it is; the
  // budget is small because a planner that cannot answer an array in three
  // tries is not going to on the fourth, and every try is a paid run.
  for (let attempt = 2; !plan.ok && attempt <= MAX_PLANNER_ATTEMPTS; attempt++) {
    // Once more, and for the array alone: a planner that wrote its plan as
    // prose is asked to say it as the JSON the team reads. On the record as
    // an alert, so a team that needed another ask says so.
    bus.send(SYSTEM, { type: "alert", reason: `The planner's answer was not a plan (${plan.reason}); asking once more for the JSON array (attempt ${attempt} of ${MAX_PLANNER_ATTEMPTS}).` });
    const again = await startRun({
      task: replanTask(board.goal, answer, plan.reason),
      projectId: board.projectId,
      directory: board.directory,
      source,
      team: { id: board.id, role: "planner", taskId: null },
      readOnly: true,
      extraBrief: PLANNER_BRIEF,
    });
    board.runs.push({ id: again.id, role: "planner", taskId: null });
    saveBoard(board);
    const replanned = await settle(team, again.id);
    if (team.stopRequested) return;
    if (replanned?.status !== "completed") {
      // A planner run that did not finish is not a wording problem, so it is
      // not re-asked: the team fails with what actually happened to it.
      plan = { ok: false, reason: `The planner did not finish its answer: ${replanned?.error ?? replanned?.status ?? "no run"}.` };
      break;
    }
    answer = replanned.resultText ?? replanned.summary;
    plan = parsePlan(answer);
  }
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
  // Workers dispatched whose run is not persisted yet (a worktree being
  // added): a reservation the spawn slot counts beside the live runs, and
  // ONLY until the run is live — counted twice, two live workers would
  // shut out a valid third.
  const starting = new Set<string>();
  while (!team.stopRequested) {
    const counted = board.alerts - team.uncountedAlerts;
    if (counted >= MAX_ALERTS) {
      setTeamStatus(board, SYSTEM, "failed", `Stopped after ${counted} alerts.`);
      saveBoard(board);
      break;
    }
    const ready = readyTasks(board).filter((t) => !inFlight.has(t.task_id));
    let waitingForRoom = false;
    for (const task of ready) {
      if (inFlight.size >= slots) break;
      if (inFlight.size >= 1) {
        // A worker whose worktree is still being added has no persisted
        // run yet; without the reservation the memory guard would not even
        // be consulted for the second worker.
        const slot = await teamSpawnSlot({ id: board.id, role: "worker", taskId: task.task_id }, starting.size);
        if (!slot.ok) {
          waitingForRoom = slot.wait;
          // A refusal that is not "wait" — a stranger's run holds the box —
          // goes on the board, or the team ends with "never ran" and no why.
          if (!slot.wait) bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `No worker for ${task.task_id}: ${slot.reason}` });
          break;
        }
      }
      starting.add(task.task_id);
      const work = workTask(team, task, source, () => starting.delete(task.task_id))
        .catch((err) => {
          bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `Task ${task.task_id} could not be worked: ${err instanceof Error ? err.message : String(err)}` });
        })
        .finally(() => { starting.delete(task.task_id); inFlight.delete(task.task_id); });
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

/** `onStarted` is called once the worker's run is persisted — the reservation it held is released there. */
async function workTask(team: LiveTeam, task: TeamTask, source: CodingRunSource, onStarted?: () => void): Promise<void> {
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
  // The owner may have stopped the team while the worktree was being made:
  // a run started now would have no id on the team yet, so Stop could not
  // reach it. Nothing starts; the worktree goes back.
  if (team.stopRequested) {
    if (worktree) await removeWorktree(board.directory, worktree.path);
    return;
  }

  let run: CodingRun;
  try {
    run = await startRun({
      task: workerTask(board, task, worktree?.path ?? null),
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
  onStarted?.();
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
  if (ok && settled?.commitError) {
    // The runner could not commit the worker's work — in a worktree there
    // is then nothing on the branch to merge, and in the project itself
    // (a code project, no team branch) the next worker would build on
    // uncommitted files. Rejected with the reason, offered once more,
    // whichever way the worker ran.
    mergeRefusal = `NOT COMMITTED: ${firstLine(settled.commitError, 300)}`;
    result = `${result}\n\n${mergeRefusal}`;
    bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `Commit failed for ${task.task_id} (${run.id}): ${firstLine(settled.commitError, 200)}` });
  }
  if (worktree) {
    if (mergeRefusal) {
      // Nothing to merge; the worktree goes back below.
    } else if (ok) {
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
    bus.send(REVIEWER, { type: "review", task_id: task.task_id, verdict: "rejected", notes: `${mergeRefusal} The work could not be ${mergeRefusal.startsWith("NOT COMMITTED") ? "committed" : "merged"}; redo the task on the current files.` });
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

/**
 * The reviewer's run and its verdict; the rule's acceptance when the run cannot say.
 *
 * A reviewer refused for ROOM — the team's slots are full, the memory guard
 * says not yet — WAITS for it, asking again every few seconds up to the run
 * budget: room frees as a sibling settles. Accepting by rule there skipped
 * the review of a task that only finished at a busy moment, and its alert
 * helped fail a team whose work was all verified (bench, 2026-09-22). Only a
 * refusal that cannot clear on its own — a stranger's run on the box, the
 * switch off — is "no reviewer": accepted by rule, with an alert the
 * ceiling does not count.
 */
async function reviewTask(team: LiveTeam, task: TeamTask, source: CodingRunSource, work: { files: string[]; report: string }): Promise<{ verdict: "accepted" | "rejected"; notes: string }> {
  const { board, bus } = team;
  const role: RunTeam = { id: board.id, role: "reviewer", taskId: task.task_id };
  const start = async (): Promise<CodingRun | { reason: string; wait: boolean }> => {
    // The orchestrator's own look first, as for a worker; the spawn asks
    // again, and a refusal there that is still about room is the same wait.
    const room = await teamSpawnSlot(role);
    if (!room.ok) return room;
    try {
      return await startRun({
        task: reviewerTask({ taskId: task.task_id, description: task.task_description, files: work.files, report: work.report, goal: board.goal }),
        projectId: board.projectId,
        directory: board.directory,
        source,
        team: role,
        readOnly: true,
        extraBrief: REVIEWER_BRIEF,
      });
    } catch (err) {
      return { reason: err instanceof Error ? err.message : String(err), wait: err instanceof CodingAgentError && err.wait };
    }
  };
  const noReviewer = (reason: string): { verdict: "accepted"; notes: string } => {
    team.uncountedAlerts += 1;
    bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `No reviewer for ${task.task_id}: ${reason}` });
    return { verdict: "accepted", notes: "Accepted by rule: the reviewer could not start." };
  };

  const waitingSince = Date.now();
  let run: CodingRun;
  for (;;) {
    // Never posted: the caller drops the verdict of a stopped team.
    if (team.stopRequested) return { verdict: "accepted", notes: "The team was stopped before the review." };
    const started = await start();
    if ("id" in started) { run = started; break; }
    if (!started.wait) return noReviewer(started.reason);
    if (Date.now() - waitingSince >= RUN_BUDGET_MS) {
      return noReviewer(`no room for ${Math.round(RUN_BUDGET_MS / 60_000)} minutes (${started.reason})`);
    }
    await sleep(REVIEWER_SLOT_POLL_MS);
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
  const parsed = parseVerdict(settled.resultText ?? settled.summary);
  if (!parsed.ok) {
    bus.send(SYSTEM, { type: "alert", task_id: task.task_id, reason: `The reviewer of ${task.task_id} gave no verdict: ${parsed.reason}` });
    return { verdict: "accepted", notes: `Accepted by rule: ${parsed.reason}` };
  }
  return parsed.verdict;
}

/** A pause that never keeps the process alive on its own: the loop's timer beside a race it may lose. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Wait for a run to settle, in slices, honouring a stop and the budget. */
async function settle(team: LiveTeam, runId: string): Promise<CodingRun | null> {
  team.currentRunIds.add(runId);
  const started = Date.now();
  try {
    for (;;) {
      const run = await waitForRun(runId, WAIT_SLICE_MS);
      if (!run) return null;
      // SETTLED, not merely "no process": a PAUSED worker is held by the
      // owner and can still be resumed. Taking it as an outcome recorded
      // "The run ended paused." as the task's result, failed the task and
      // the team, and removed the worktree — while the run's own page went
      // on offering Resume into a folder that was no longer there. The
      // budget below is what ends a pause nobody comes back to.
      if (isSettled(run.status)) return run;
      if (team.stopRequested) {
        try { stopRun(runId); } catch { /* raced with its own settle */ }
        return getRun(runId);
      }
      if (Date.now() - started > RUN_BUDGET_MS) {
        team.bus.send(SYSTEM, { type: "alert", reason: `Run ${runId} outlived the team's budget and was stopped.` });
        try { stopRun(runId); } catch { /* raced */ }
        return getRun(runId);
      }
      // waitForRun answers AT ONCE for a run that is not running, so a held
      // one (paused, a draft) would spin this loop; look again in a moment.
      if (!isLive(run.status)) await sleep(HELD_POLL_MS);
    }
  } finally {
    team.currentRunIds.delete(runId);
  }
}

// ─── Words ───────────────────────────────────────────────────────────────────

/**
 * One worker's task text: the goal, its own task, what teammates did, where to work.
 * `folder` is the worker's own worktree, when it has one.
 */
export function workerTask(board: TeamBoard, task: TeamTask, folder: string | null = null): string {
  const done = board.tasks
    .filter((t) => t.task_id !== task.task_id && t.status === "complete" && t.result)
    .map((t) => `- ${t.task_id}: ${firstLine(t.result ?? "", RESULT_QUOTE_CHARS)}`);
  // The task line comes FIRST: a run's commit subject and its row in the
  // app are the task text's first line, and "Team goal: …" four times over
  // told the owner nothing about which worker did what.
  const parts = [`Your task (${task.task_id} of ${board.tasks.length}): ${task.task_description}`];
  // The hint is relative to the project, and a worker in a worktree took it
  // as relative to the project folder: it read `<project>/styles.css`, was
  // refused (the run is contained to its worktree), and the refusal was an
  // alert (bench, 2026-09-22). Its own folder is named, and every path is
  // said to be relative to it — right after the task line, ahead of a goal
  // that may be long enough to push it past the cut below.
  if (folder && folder !== board.directory) {
    parts.push(`Your folder: ${folder} — your own working copy of the project. Every path in this task, the files below included, is relative to it; read and write there, never in ${board.directory} itself.`);
  }
  parts.push(`Team goal: ${board.goal}`);
  if (task.files_hint.length) parts.push(`Files this task is expected to touch: ${task.files_hint.join(", ")}`);
  if (done.length) parts.push(`Already done by teammates:\n${done.join("\n")}`);
  if (task.attempts > 0 && task.review?.verdict === "rejected") parts.push(`A previous attempt was rejected: ${task.review.notes}`);
  // Who else is at work, by the run id `team_message` needs: the one way a
  // worker learns which run to tell when it is blocked on a sibling's part.
  // LAST, because the text is cut at MAX_TASK_CHARS from the end: a list a
  // NOT_IN_TEAM refusal can also give must never push out a retry's reason.
  const working = board.tasks
    .filter((t) => t.task_id !== task.task_id && t.status === "in_progress" && t.assigned_to)
    .map((t) => `- ${t.assigned_to} on ${t.task_id}: ${firstLine(t.task_description, TEAMMATE_QUOTE_CHARS)}`);
  if (working.length) parts.push(`Teammates at work now (reach one with team_message, to="sibling"):\n${working.join("\n")}`);
  let text = parts.join("\n\n");
  if (text.length > MAX_TASK_CHARS) text = `${text.slice(0, MAX_TASK_CHARS - 1)}…`;
  return text;
}

/** Files a worker touched that its task's hint does not cover (a hint names files or folders). */
export function outsideHint(touched: string[], hint: string[]): string[] {
  if (hint.length === 0) return [];
  const norm = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");
  const hints = hint.map(norm);
  // A build or an interpreter writes its own files beside the source it was
  // pointed at — a worker asked to edit calc.py cannot help CPython leaving
  // __pycache__/calc.cpython-310.pyc there. Counting that as straying failed
  // three correct tasks and killed a run on the alert ceiling (team-6rgz8cyx,
  // team-5oxkp7a9, 2026-09-06). It is noise, not a trespass.
  return touched
    .map(norm)
    .filter((f) => !isGeneratedArtifact(f))
    .filter((f) => !hints.some((h) => f === h || f.startsWith(`${h}/`)));
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
