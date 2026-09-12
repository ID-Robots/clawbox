/**
 * The coding run's status machine — the ONE list every consumer derives from.
 *
 * Server (coding-agent.ts), client (CodingAgentApp, the activity hook) and the
 * MCP server (mcp/tools/coding-agent.ts) each used to declare this union by
 * hand, and the persisted-status allow-list was a fourth copy: a status
 * missing from that copy made a restart silently DELETE the record (paused
 * runs and drafts vanished, found the hard way). Adding a status now means
 * adding it here, and the predicates below say what it means.
 *
 * Pure TypeScript on purpose: no Node imports, so the browser bundle and the
 * MCP process can both import it.
 */

/**
 * EVERY status a run record can carry. Gates what is read back from disk.
 * The type is DERIVED from this list, not written beside it: a status added
 * to one and not the other used to compile, and the mismatch was found at
 * the restart that dropped the record.
 */
export const RUN_STATUSES = ["running", "completed", "failed", "stopped", "paused", "draft"] as const;

export type CodingRunStatus = (typeof RUN_STATUSES)[number];

export function isCodingRunStatus(value: unknown): value is CodingRunStatus {
  return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

/**
 * The METERS a run can be refused against — the things this box spends on a
 * run's behalf and can run out of. One list, for the same reason the statuses
 * are one list: the runner writes it, the record persists it, the app words it
 * and the MCP server relays it.
 */
export const PAUSE_METERS = ["images", "audio", "speech", "tokens"] as const;

export type CodingPauseMeter = (typeof PAUSE_METERS)[number];

export function isCodingPauseMeter(value: unknown): value is CodingPauseMeter {
  return typeof value === "string" && (PAUSE_METERS as readonly string[]).includes(value);
}

/**
 * WHY a paused run is paused.
 *
 * "paused" is the one settled status that is not an ending, and it is reached
 * two ways that need different things said. A pause someone ASKED for needs
 * nothing explained — whoever pressed it knows. A pause that followed a
 * refusal is the opposite: nobody chose it, the session is intact, and the one
 * thing the owner must be told is which allowance ran out and when it comes
 * back, because until then Resume only buys the same refusal again.
 *
 * Rendered identically — a bare "Paused — resume to continue" — those two read
 * as the same event, and an API consumer cannot tell them apart at all.
 *
 * Null on a run that was never paused, and on a record written before this
 * field existed. No reader may read "no reason" as "the owner did it": only
 * the pause branch that sets it knows that, and it sets `{ kind: "owner" }`
 * explicitly rather than leaving the field null to mean it.
 */
export type CodingPauseReason =
  | { kind: "owner" }
  | {
      kind: "allowance";
      /** Which of this box's meters was spent. */
      meter: CodingPauseMeter;
      /** ISO 8601, when the allowance is next expected back. Null when upstream did not say. */
      resetsAt: string | null;
      /** The refusal as the far side worded it, kept as the account of why. */
      message: string;
    };

/**
 * The longest refusal sentence a record will carry.
 *
 * `message` is the one field here that is upstream TEXT rather than this
 * box's own vocabulary, so it is bounded on the way in: the runs file is read
 * back on every boot and polled by two UIs, and an upstream that answered a
 * megabyte of HTML must not become a megabyte of run record.
 */
export const MAX_PAUSE_MESSAGE_CHARS = 300;

/**
 * Read a pause reason off an untrusted record, or null.
 *
 * Strict on purpose, and the ONLY parser: a hand-edited runs file, or one
 * written by a newer build that added a meter, must degrade to "no reason
 * given" rather than to a reason no surface here can word. The same rule the
 * status list is held to — an unknown string is not a new kind of pause.
 */
export function parsePauseReason(value: unknown): CodingPauseReason | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "owner") return { kind: "owner" };
  if (raw.kind !== "allowance") return null;
  if (!isCodingPauseMeter(raw.meter)) return null;
  return {
    kind: "allowance",
    meter: raw.meter,
    // A reset time is a claim about the future; an unparseable one is no
    // claim at all, and the app says "resume when it is back" instead.
    resetsAt: typeof raw.resetsAt === "string" && !Number.isNaN(Date.parse(raw.resetsAt))
      ? raw.resetsAt
      : null,
    message: typeof raw.message === "string" ? raw.message.slice(0, MAX_PAUSE_MESSAGE_CHARS) : "",
  };
}

/**
 * What each meter is CALLED, in English, for the surfaces that have no
 * translator: the MCP description a delegated agent reads back. The app draws
 * from the locale catalogue instead — same meters, the owner's language.
 */
export const PAUSE_METER_NOUN: Record<CodingPauseMeter, string> = {
  images: "daily image allowance",
  audio: "daily audio allowance",
  speech: "speech allowance",
  tokens: "token allowance",
};

/**
 * A reset instant as the clock the owner reads: "HH:MM UTC", or null when
 * there is no instant to show.
 *
 * UTC and not the box's zone, deliberately: the allowance itself is counted
 * per UTC day, and an hour rendered in local time would be a different claim
 * about a fact this box does not get to reinterpret. Shared so the app and
 * the agent-facing text cannot round the same moment two ways.
 */
export function pauseResetClock(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return null;
  const d = new Date(at);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** A process exists for this run right now. */
export function isLive(status: CodingRunStatus): boolean {
  return status === "running";
}

/**
 * Held by the owner, not history: a live run, a paused one waiting to be
 * resumed, a draft waiting to be started. Never cleared, never trimmed to
 * make room, never picked as "the last finished run".
 */
export function isHeld(status: CodingRunStatus): boolean {
  return status === "running" || status === "paused" || status === "draft";
}

/** Over, one way or another — what the history list and the review pass look at. */
export function isSettled(status: CodingRunStatus): boolean {
  return !isHeld(status);
}
