/**
 * A coding team's runs talking to each other while they work — the rules.
 *
 * Until this existed a team run (coding-team.ts: the planner, the workers, the
 * reviewer) had exactly one channel: its final message, quoted to the next
 * worker. A worker blocked on a sibling's output, or handed a files_hint that
 * names a file which is not there, could only guess or fail. `team_message`
 * (the MCP tool, mcp/tools/coding-agent.ts) gives it three short, logged
 * channels:
 *
 *   - `sibling`     another run of the same team, through the steering path the
 *                   owner's own messages take (`queueRunMessage`), prefixed
 *                   `[from <role> <runId>]` so the receiver knows who said it;
 *   - `lead`        the team's orchestrator — a `message` entry on the board,
 *                   which is the whole answer: the lead does not reply;
 *   - `owner_agent` the box's OpenClaw main agent, posted into the chat session
 *                   the web chat is bound to, prefixed with the team and run.
 *
 * Everything here is PURE — no Node imports, no "@/" alias — because the MCP
 * process imports it for the tool's schema, the same way it imports
 * coding-run-messages.ts, and the caps must be one number on both sides.
 * The delivery itself is coding-team.ts's.
 */

import { normalizeRunMessage, RunMessageError } from "./coding-run-messages";

export const TEAM_MESSAGE_TARGETS = ["sibling", "lead", "owner_agent"] as const;
export type TeamMessageTarget = (typeof TEAM_MESSAGE_TARGETS)[number];

export const TEAM_ROLES = ["planner", "worker", "reviewer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** The longest one message may be: a note to a teammate, not a report. */
export const MAX_TEAM_MESSAGE_CHARS = 1_500;
/** How many messages one run may send in its whole life. */
export const MAX_TEAM_MESSAGES_PER_RUN = 12;
/** …and how many inside any window of TEAM_MESSAGE_WINDOW_MS. */
export const MAX_TEAM_MESSAGES_PER_WINDOW = 4;
export const TEAM_MESSAGE_WINDOW_MS = 5 * 60_000;

/**
 * A run id and a team id, the shapes the runner and the board mint — here as
 * well as in coding-team-board.ts because the MCP process cannot import that
 * module (it reads the disk) and has to check what its environment says.
 */
export const RUN_ID_RE = /^run-[a-z0-9]{8}$/;
export const TEAM_ID_SHAPE = /^team-[a-z0-9]{8}$/;
export const TASK_ID_SHAPE = /^t[1-9][0-9]{0,2}$/;

/**
 * Why a message was refused, beside the English sentence.
 *
 * Three families, and the difference matters to the team: the SENDER's refusals
 * (the text, who it claims to be, whom it names, its caps) are logged on the
 * board as alerts, the way the bus logs every message it would not take; the
 * BOX's (no chat session to post into, an edition with no such path, a gateway
 * that did not take it) are recorded as an undelivered message, never as an
 * alert — three of them would otherwise stop a team over the box's own set-up;
 * and the RACE's (`NOTED_REFUSALS`: the receiver finished before the message
 * reached it) are a note, counted as undelivered, never an alert either.
 */
export type TeamMessageRefusal =
  | "INVALID"
  | "EMPTY"
  | "TOO_LONG"
  | "NOT_PLAIN_TEXT"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "SELF"
  | "NOT_IN_TEAM"
  | "SETTLED"
  | "QUEUE_FULL"
  | "RATE_LIMITED"
  | "NO_SESSION"
  | "UNSUPPORTED"
  | "NOT_DELIVERED";

/** The refusals that are the box's state rather than the sender's doing. */
export const UNDELIVERED_REFUSALS: readonly TeamMessageRefusal[] = ["NO_SESSION", "UNSUPPORTED", "NOT_DELIVERED"];

/**
 * The refusals that are a race, not a fault: the sibling it was meant for had
 * already finished. A worker answering a question a minute after the asker
 * completed is how a parallel team runs, not something the sender did wrong —
 * as alerts, two such answers and one real alert failed a team whose every
 * deliverable verified (bench, 2026-09-26). On the board as a NOTE, in the
 * figures as undelivered and on the sender's caps, as an undelivered message
 * is; the sender is still told it was not delivered.
 */
export const NOTED_REFUSALS: readonly TeamMessageRefusal[] = ["SETTLED"];

export class TeamMessageError extends Error {
  constructor(
    readonly code: TeamMessageRefusal,
    message: string,
    /** RATE_LIMITED only: when the next message may go (ms since the epoch), or null when this run has no more. */
    readonly nextAllowedAt: number | null = null,
  ) {
    super(message);
    this.name = "TeamMessageError";
  }
}

/**
 * The text a run may send: the steering path's own rules (plain text, CRLF
 * folded, trimmed — `normalizeRunMessage`), under this channel's tighter cap.
 */
export function normalizeTeamMessage(raw: unknown): string {
  let text: string;
  try {
    text = normalizeRunMessage(raw);
  } catch (err) {
    if (err instanceof RunMessageError) {
      if (err.code === "too_long") throw tooLong();
      if (err.code === "not_plain_text") throw new TeamMessageError("NOT_PLAIN_TEXT", "A team message must be plain text.");
      throw new TeamMessageError("EMPTY", "A team message needs some text.");
    }
    throw err;
  }
  if (text.length > MAX_TEAM_MESSAGE_CHARS) throw tooLong();
  return text;
}

function tooLong(): TeamMessageError {
  return new TeamMessageError("TOO_LONG", `A team message is at most ${MAX_TEAM_MESSAGE_CHARS} characters; say it shorter.`);
}

export type TeamMessageAllowance =
  | { ok: true; /** Messages this run may still send in its life, this one included. */ left: number }
  | { ok: false; scope: "run" | "window"; /** When the next may go; null when this run has none left. */ nextAllowedAt: number | null };

/**
 * May a run that has sent at `sent` send one more at `now`?
 *
 * The run cap first: a run that has spent its twelve has no "next allowed
 * time", and saying one would invite a model to wait for it. Then the window:
 * the fourth-newest message inside it is the one that has to age out.
 */
export function teamMessageAllowance(sent: readonly number[], now: number): TeamMessageAllowance {
  if (sent.length >= MAX_TEAM_MESSAGES_PER_RUN) return { ok: false, scope: "run", nextAllowedAt: null };
  const recent = sent.filter((t) => t > now - TEAM_MESSAGE_WINDOW_MS).sort((a, b) => a - b);
  if (recent.length >= MAX_TEAM_MESSAGES_PER_WINDOW) {
    return { ok: false, scope: "window", nextAllowedAt: recent[recent.length - MAX_TEAM_MESSAGES_PER_WINDOW] + TEAM_MESSAGE_WINDOW_MS };
  }
  return { ok: true, left: MAX_TEAM_MESSAGES_PER_RUN - sent.length };
}

/** The refusal a spent allowance answers with, worded with the time it may try again. */
export function rateLimitedError(allowance: Extract<TeamMessageAllowance, { ok: false }>): TeamMessageError {
  if (allowance.scope === "run" || allowance.nextAllowedAt === null) {
    return new TeamMessageError("RATE_LIMITED", `This run has sent its ${MAX_TEAM_MESSAGES_PER_RUN} team messages; it may send no more.`, null);
  }
  return new TeamMessageError(
    "RATE_LIMITED",
    `This run has sent ${MAX_TEAM_MESSAGES_PER_WINDOW} team messages in the last ${TEAM_MESSAGE_WINDOW_MS / 60_000} minutes; the next may go at ${new Date(allowance.nextAllowedAt).toISOString()}.`,
    allowance.nextAllowedAt,
  );
}

/**
 * What the box's main agent reads in its chat: which team, which run, then the
 * words — so the assistant can find the run and steer it back with
 * `coding_run_message`, and the owner reading the chat knows who is talking.
 */
export function ownerAgentMessage(teamId: string, role: TeamRole, runId: string, text: string): string {
  return `[Coding team ${teamId} · ${role} ${runId}] ${text}`;
}
