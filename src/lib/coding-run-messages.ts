/**
 * Telling a coding run something while it is still working.
 *
 * A delegated run is unattended by construction — the brief says so, and the
 * harness has no way to ask a question — but "unattended" was being read as
 * "unreachable": once a run was spawned the only gestures left were Stop and
 * Pause. An owner who spotted the run heading the wrong way at minute three
 * could stop it and start over, or wait twenty minutes for the wrong answer.
 *
 * So a run carries a QUEUE of messages, and there are two ways one reaches the
 * harness:
 *
 *  - STREAMING (`--input-format stream-json`): the CLI keeps reading stdin for
 *    the life of the process, so a message is written as the next user turn and
 *    the run picks it up when its current turn ends. This is the real thing.
 *  - AT A BOUNDARY: an attempt at the deliverable, or the owner's own Resume,
 *    already hands the session a continuation on stdin. Anything still queued
 *    rides along with it. This is the fallback for a box whose Claude Code
 *    does not take streaming input, and it is also what catches a message that
 *    arrived after the harness had already been told to finish.
 *
 * Everything here is pure: the queue's shape, its bounds, what a message may
 * contain, and how it is worded to the harness. The delivery itself — who
 * holds the pipe, when a turn ends — is coding-agent.ts's.
 */

/** One thing somebody told a run, and whether the harness has had it yet. */
export interface RunMessage {
  /** When it was queued (ms since the epoch). */
  at: number;
  /** What to say. Plain text, already validated and capped. */
  text: string;
  /** When the harness was given it, or null while it is still waiting. */
  deliveredAt: number | null;
}

/**
 * How many UNDELIVERED messages a run may hold.
 *
 * A bound on the queue rather than on the record: a run that has taken twenty
 * messages and acted on them is not a run somebody is spamming, and refusing
 * the twenty-first would be punishing the owner for a conversation that is
 * working.
 */
export const MAX_QUEUED_RUN_MESSAGES = 20;

/** The longest one message may be. A note, not an essay: 4,000 characters. */
export const MAX_RUN_MESSAGE_CHARS = 4_000;

/**
 * How many messages the RECORD keeps in total, delivered ones included.
 *
 * The record is persisted and answered on every poll of the runs route, so the
 * history cannot grow without a bound. Only delivered messages are ever
 * dropped, oldest first — a queued one is a promise this box has not kept yet.
 */
export const MAX_RUN_MESSAGES_KEPT = 40;

/**
 * Why a message was refused, beside the English sentence.
 *
 * A stable code per refusal, the shape every other ClawBox route's refusals
 * have: the four the text or the queue can break, and `settled` for the one
 * about the RUN — there is nothing left to tell it — which the caller has to
 * be able to tell apart from "that was not a message", because the answer is
 * to start or resume a run rather than to rewrite what was typed.
 */
export type RunMessageRefusal = "empty" | "too_long" | "not_plain_text" | "queue_full" | "settled";

export class RunMessageError extends Error {
  constructor(readonly code: RunMessageRefusal, message: string) {
    super(message);
    this.name = "RunMessageError";
  }
}

/**
 * Each refusal's translation key.
 *
 * Here rather than in the component for the reason `ALLOW_RULE_REFUSAL_KEYS`
 * is: the route answers the code and the card words it, and the two must not
 * be able to drift. `too_long` fills `{max}` and `queue_full` `{n}` from the
 * constants above.
 */
export const RUN_MESSAGE_REFUSAL_KEYS: Record<RunMessageRefusal, string> = {
  empty: "codingAgent.message.errorEmpty",
  too_long: "codingAgent.message.errorTooLong",
  not_plain_text: "codingAgent.message.errorNotPlainText",
  queue_full: "codingAgent.message.errorQueueFull",
  settled: "codingAgent.message.errorSettled",
};

/** Is this one of the codes this build knows how to word? */
export function isRunMessageRefusal(value: unknown): value is RunMessageRefusal {
  return typeof value === "string" && value in RUN_MESSAGE_REFUSAL_KEYS;
}

/**
 * Anything that is not printable text, a newline or a tab.
 *
 * PLAIN TEXT ONLY is a rule about what reaches the harness's stdin, and it is
 * enforced on the bytes rather than on a promise: this string is written into
 * a JSON line on a pipe the CLI parses, and it is echoed back on the run's own
 * page and into a terminal that tails the transcript. A NUL or an escape
 * sequence has no meaning as a message and every meaning as an injection into
 * one of those readers.
 */
const CONTROL_CHARS = /[\p{Cc}]/u;

/**
 * The text a caller may send, or a refusal saying which rule it broke.
 *
 * CRLF is normalised rather than refused — a message typed in a browser
 * textarea on Windows is not a hostile one — and the surrounding whitespace
 * goes, because "  " is an empty message with extra steps. Tabs and newlines
 * survive the control-character rule; nothing else does.
 */
export function normalizeRunMessage(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new RunMessageError("empty", "A message is required.");
  }
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (!text) {
    throw new RunMessageError("empty", "A message is required.");
  }
  if (text.length > MAX_RUN_MESSAGE_CHARS) {
    throw new RunMessageError(
      "too_long",
      `That message is too long: at most ${MAX_RUN_MESSAGE_CHARS} characters.`,
    );
  }
  if (CONTROL_CHARS.test(text.replace(/[\n\t]/g, ""))) {
    throw new RunMessageError("not_plain_text", "A message must be plain text.");
  }
  return text;
}

/** The messages still waiting for the harness, oldest first. */
export function queuedMessages(messages: readonly RunMessage[]): RunMessage[] {
  return messages.filter((m) => m.deliveredAt === null);
}

/**
 * Add one, having checked the queue is not already full.
 *
 * Returns a NEW list: the caller decides when it reaches the record, and a
 * refusal must not have half-written one.
 */
export function appendRunMessage(messages: readonly RunMessage[], text: string, now: number): RunMessage[] {
  if (queuedMessages(messages).length >= MAX_QUEUED_RUN_MESSAGES) {
    throw new RunMessageError(
      "queue_full",
      `This run already has ${MAX_QUEUED_RUN_MESSAGES} messages waiting for it. Wait for it to read them.`,
    );
  }
  return trimRunMessages([...messages, { at: now, text, deliveredAt: null }]);
}

/**
 * Hold the list at MAX_RUN_MESSAGES_KEPT by dropping the oldest DELIVERED
 * entries. A queued message is never dropped to make room — it has not been
 * said yet, and the queue's own bound is what stops it growing.
 */
export function trimRunMessages(messages: readonly RunMessage[]): RunMessage[] {
  if (messages.length <= MAX_RUN_MESSAGES_KEPT) return [...messages];
  const kept = [...messages];
  let over = kept.length - MAX_RUN_MESSAGES_KEPT;
  for (let i = 0; i < kept.length && over > 0; ) {
    if (kept[i].deliveredAt !== null) {
      kept.splice(i, 1);
      over -= 1;
    } else {
      i += 1;
    }
  }
  return kept;
}

/**
 * A record's messages off disk.
 *
 * Re-validated rather than trusted, the way every other list on the record is:
 * this file can have been hand-edited or restored, and its text is written to
 * the harness's stdin and rendered on the run's page.
 */
export function parseRunMessages(raw: unknown): RunMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: RunMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const m = entry as Partial<RunMessage>;
    if (typeof m.at !== "number" || !Number.isFinite(m.at)) continue;
    let text: string;
    try {
      text = normalizeRunMessage(m.text);
    } catch {
      continue;
    }
    out.push({
      at: m.at,
      text,
      deliveredAt: typeof m.deliveredAt === "number" && Number.isFinite(m.deliveredAt) ? m.deliveredAt : null,
    });
  }
  return trimRunMessages(out);
}

/**
 * ONE user turn, in the shape Claude Code reads from stdin under
 * `--input-format stream-json`: newline-delimited JSON, one message per line.
 *
 * The framing is added here and nowhere else, so the initial task and a
 * steering message travel identically — a run whose first turn arrived in one
 * shape and whose second arrived in another would be a harness bug this box
 * could not see.
 */
export function streamJsonUserTurn(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

/**
 * How a steering message is worded to the harness.
 *
 * Framed as the owner's, and framed as INFORMATION about the task rather than
 * as a new task: a run that read "do this instead" as a fresh brief would
 * start over and throw away the work the message was sent to redirect.
 */
export function runMessageTurn(text: string): string {
  return `[ClawBox: a message from the person who started this run. It is about the task you are already on — take it into account and carry on; do not start over.]\n\n${text}`;
}

/**
 * The same messages folded into a continuation that is going out anyway — an
 * attempt at the deliverable, or the owner's own Resume.
 *
 * Returns "" when there is nothing queued, so a caller can append it
 * unconditionally.
 */
export function runMessagesNote(messages: readonly RunMessage[]): string {
  const waiting = queuedMessages(messages);
  if (!waiting.length) return "";
  const body = waiting.length === 1
    ? waiting[0].text
    : waiting.map((m, i) => `${i + 1}. ${m.text}`).join("\n");
  const one = waiting.length === 1;
  return `[ClawBox: ${one ? "a message" : `${waiting.length} messages`} from the person who started this run, sent while it was working. Take ${one ? "it" : "them"} into account.]\n\n${body}`;
}

/**
 * What the run's own feed says when a message reaches the harness.
 *
 * The text itself is in the line, because the point of the feed is that a
 * reader can see what the run was told — and it goes through pushProgress,
 * which scrubs the owner's secrets out of it and caps the line, like every
 * other step.
 */
export function runMessageProgressLine(text: string): string {
  return `Message to the run: ${text}`;
}

// ── Whether this box's harness takes a message mid-run ───────────────────────

/**
 * Claude Code turning `--input-format stream-json` away.
 *
 * Only ever consulted when the harness never spoke at all — once it has
 * emitted its init event the flag was accepted, and any later failure is the
 * run's own. Commander words an unknown flag and a rejected choice differently,
 * so both shapes are here.
 */
export const STREAM_INPUT_REFUSED =
  /(?:unknown|unrecognized|invalid)\s+(?:option|argument|choice)[^\n]*--input-format|--input-format[^\n]*(?:is invalid|not supported|unknown|unrecognized)/i;

/** How long a refusal is remembered before the box tries streaming again. */
export const STREAM_INPUT_REFUSED_FOR_MS = 30 * 60_000;

let streamInputRefusedAt: number | null = null;

/**
 * This box's Claude Code turned streaming input away — learned from the real
 * thing rather than probed for.
 *
 * The precedent is `noteScopeRefused` (coding-run-unit.ts) and the reason is
 * the same one: a probe that spawns the harness costs a process on a path
 * several route handlers reach, and what it would prove — that the CLI accepts
 * the flag — is exactly what the next real spawn proves for free. Remembered
 * for half an hour rather than for ever, so an install that upgrades the CLI
 * is not held to the old answer until the web server restarts.
 */
export function noteStreamInputRefused(now = Date.now()): void {
  streamInputRefusedAt = now;
}

/** A streamed spawn worked, so whatever was remembered is history. */
export function noteStreamInputWorked(): void {
  streamInputRefusedAt = null;
}

/** Should the next spawn keep stdin open and read messages into it? */
export function streamInputAvailable(now = Date.now()): boolean {
  if (streamInputRefusedAt === null) return true;
  if (now - streamInputRefusedAt >= STREAM_INPUT_REFUSED_FOR_MS) {
    streamInputRefusedAt = null;
    return true;
  }
  return false;
}

/** Test hook: forget what this process learned about the harness. */
export function _resetStreamInputForTests(): void {
  streamInputRefusedAt = null;
}
