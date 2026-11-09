/**
 * A run that outgrew its model's context window, and what the runner does
 * about it (TASK-2203).
 *
 * The field failure: a ClawBox AI run on a `[1m]` model id climbed to
 * 1,016,260 tokens without one compaction, and its next request was refused
 * with DeepSeek's own wording — "This model's maximum context length is
 * 1048576 tokens. However, you requested 1049351 tokens (1017351 in the
 * messages, 32000 in the completion)". Claude Code reads only "prompt is too
 * long" as that refusal, so its own reactive compaction never ran, and the run
 * died with the session full, 1,697 turns in.
 *
 * scripts/claude-ds now gives Claude Code an auto-compact window well below
 * the cap, so a session compacts long before it gets there. This is what is
 * left when one does reach it anyway — a whole turn of tool results landing
 * after the last check, or a harness that ignores the knob: the session is
 * intact on disk, so the run is carried on IN PLACE. Resumed, with the reply it
 * may ask for cut to what fits beside its context — the compaction request is
 * the whole context plus the summary instruction plus that reply, so with
 * Claude Code's usual 32k reply it is refused exactly like the request that
 * failed — Claude Code compacts before it sends anything and goes on from the
 * summary. Measured against a stand-in upstream on Claude Code 2.1.316: a
 * plain resume died again ("automatic compaction failed"), the same resume
 * with CLAUDE_CODE_MAX_OUTPUT_TOKENS cut compacted and finished.
 *
 * PURE: no I/O, so the decision is unit-tested on its own.
 */

/** What the provider said when it refused a request for its size. */
export interface ContextOverflow {
  /** The window the provider says the model has, when it said. */
  window: number | null;
  /** The context the refused request carried — its messages, without the reply — when said. */
  context: number | null;
  /** The reply the request asked room for, when said. */
  reply: number | null;
  /** The provider's own words, as the run reported them (cut). */
  text: string;
}

/** How many times one run is carried on past an outgrown window before it fails. */
export const MAX_CONTEXT_RECOVERIES = 2;

/**
 * Room kept beside the context for what the compaction request adds to it:
 * Claude Code's summary instruction (~1.6k tokens measured) and the
 * continuation the runner sends, with slack.
 */
export const COMPACT_REQUEST_ROOM = 4096;

/** The most a recovering spawn's replies may ask for — Claude Code's own compaction reply cap. */
export const RECOVERY_MAX_REPLY = 20_000;

/** Below this there is no room for a summary worth having, and no carrying on. */
export const RECOVERY_MIN_REPLY = 4096;

/** The reply a recovering spawn asks for when the refusal named no numbers. */
export const RECOVERY_DEFAULT_REPLY = 8192;

const MAX_TEXT = 400;

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s.replace(/[,_]/g, ""));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The refusal in a run's error or closing words, or null when the text is not
 * one. Reads DeepSeek's / OpenAI's wording (the ClawBox AI proxy passes it on),
 * Anthropic's "prompt is too long: N tokens > M maximum" and Claude Code's own
 * "Prompt is too long" — the last two only as a shape, since an Anthropic run
 * never reaches the recovery (see planContextRecovery's caller).
 */
export function parseContextOverflow(text: string | null | undefined): ContextOverflow | null {
  if (typeof text !== "string" || !text) return null;
  const said = text.trim().slice(0, MAX_TEXT);
  const deepseek = /maximum context length is ([\d,]+) tokens\.?\s*However,? you requested ([\d,]+) tokens(?:\s*\(([\d,]+) in the messages,\s*([\d,]+) in the completion\))?/i.exec(text);
  if (deepseek) {
    // "However, you requested N tokens" with no split says nothing about the
    // context alone (N includes the reply), so it is left unknown.
    return { window: num(deepseek[1]), context: num(deepseek[3]), reply: num(deepseek[4]), text: said };
  }
  const anthropic = /prompt is too long:?\s*([\d,]+) tokens\s*>\s*([\d,]+)(?: tokens)? maximum/i.exec(text);
  if (anthropic) return { window: num(anthropic[2]), context: num(anthropic[1]), reply: null, text: said };
  const windowOnly = /maximum context length is ([\d,]+) tokens/i.exec(text);
  if (windowOnly) return { window: num(windowOnly[1]), context: null, reply: null, text: said };
  if (/\bprompt is too long\b|\binput is too long for requested model\b|\bcontext_length_exceeded\b/i.test(text)) {
    return { window: null, context: null, reply: null, text: said };
  }
  return null;
}

/** Why a run that outgrew its window is not carried on. */
export type ContextRecoveryRefusal = "no_session" | "spent" | "no_room";

export type ContextRecoveryPlan =
  | { kind: "resume"; maxReplyTokens: number; attempt: number }
  | { kind: "fail"; reason: ContextRecoveryRefusal };

/**
 * Carry the run on, or not. `recoveries` is how many times this run has
 * already been carried on past its window; `hasSession` whether there is a
 * session to resume at all.
 *
 * The reply is what fits: the window, less the context the refused request
 * carried, less room for the compaction request's own additions — capped at
 * Claude Code's compaction reply, and refused below what a summary needs.
 * Without the numbers, a modest default.
 */
export function planContextRecovery(overflow: ContextOverflow, recoveries: number, hasSession: boolean): ContextRecoveryPlan {
  if (!hasSession) return { kind: "fail", reason: "no_session" };
  if (recoveries >= MAX_CONTEXT_RECOVERIES) return { kind: "fail", reason: "spent" };
  let reply = RECOVERY_DEFAULT_REPLY;
  if (overflow.window !== null && overflow.context !== null) {
    const room = overflow.window - overflow.context - COMPACT_REQUEST_ROOM;
    if (room < RECOVERY_MIN_REPLY) return { kind: "fail", reason: "no_room" };
    reply = Math.min(RECOVERY_MAX_REPLY, room);
  }
  return { kind: "resume", maxReplyTokens: reply, attempt: recoveries + 1 };
}

/** What the resumed session is told. It already holds the task. */
export function contextRecoveryContinuation(evidenceDir: string): string {
  return "Your previous request was refused because the conversation had outgrown the model's context window."
    + " ClawBox resumed the same session and it has been compacted into a summary; the folder, the branch and everything you have done are unchanged."
    + " Continue the task exactly where the summary leaves off — do not start over and do not repeat work that is already done."
    + " Keep tool output small from here on: read large files in ranges and cut long command output."
    + ` Your evidence folder is ${evidenceDir}.`;
}

function tokens(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * The run's error when it is NOT carried on: what happened, in numbers when the
 * provider gave them, why the box stopped there, and the provider's own words
 * — so the card says the real reason, not "Claude Code reported an error".
 */
export function contextOverflowError(overflow: ContextOverflow, recoveries: number, reason: ContextRecoveryRefusal): string {
  const size = overflow.window !== null && overflow.context !== null
    ? ` (${tokens(overflow.context)} tokens of context${overflow.reply !== null ? ` plus ${tokens(overflow.reply)} for the reply` : ""} against a ${tokens(overflow.window)}-token window)`
    : overflow.window !== null
      ? ` (a ${tokens(overflow.window)}-token window)`
      : "";
  const why = reason === "spent"
    ? `ClawBox compacted the session and carried it on ${recoveries === 1 ? "once" : `${recoveries} times`}, and it outgrew the window again.`
    : reason === "no_room"
      ? "It went so far past the window in one step that not even a summary of it fits, so ClawBox could not compact it."
      : "There was no session to compact and carry on.";
  return `The conversation outgrew the model's context window${size}. ${why}`
    + " Start the run again with a narrower task, or ask it to read large files in ranges."
    + ` The provider said: ${overflow.text}`;
}
