/**
 * "The coding harness itself is not ready" — telling that apart from "the run
 * could not do the task", and remembering it long enough to stop the next run
 * walking into the same wall.
 *
 * WHAT THE OWNER SAW. A run died in a few seconds and its card carried, whole,
 * the line the CLI printed:
 *
 *     [claude-code:unrecognized_model] {"model":"deepseek-v4-pro[1m]","query_source":"sdk"}
 *
 * Nothing in that is actionable by the person it was shown to. It is not about
 * their task, their folder or their files; it says the model this box's harness
 * asks for is not one the box's plan is entitled to right now — a fact about
 * the DEVICE. Worse, nothing acted on it: the next run started, asked for the
 * same model, and died the same way, and so did the one after that.
 *
 * So two things live here.
 *
 * WHAT COUNTS AS A HARNESS FAULT. The shapes that mean the harness could not
 * get a model to answer at all: an unrecognised or refused model, a rejected
 * credential, a missing CLI. Deliberately NOT a refusal of the work — a turn
 * ceiling, a cost ceiling, a timeout and a task the run could not finish are
 * all answers about the task, and dressing them up as a device fault would
 * send the owner to Settings for a problem that is in their prompt.
 *
 * THE RELATIONSHIP WITH THE RETRY. This does not replace `isTransientFailure`
 * and does not narrow it: `unrecognized_model` is in that set on evidence (one
 * run died to it minutes after another finished a whole build on the same
 * model string), so the automatic retry still happens, exactly once, first. A
 * harness fault is only declared on the FINAL failure — the retry is what
 * tells a flap apart from a fault, and only then is anything recorded.
 *
 * WHY IT IS REMEMBERED, AND WHY NOT FOR EVER. Recorded, the next run can be
 * refused before it spawns, which is the difference between one clear message
 * and a column of identical dead runs. Given a TTL, because the same evidence
 * says this is usually an entitlement flap that comes right: a permanent
 * lockout would need an owner to find a switch to clear a fault the box may
 * have recovered from by itself. It is also dropped the moment a run actually
 * completes, which is the only proof that matters.
 */

/**
 * Failures that mean THIS BOX's harness could not get a model to answer.
 *
 * Matched on the error text because that is what the device has: the CLI
 * reports these as a result event or on stderr, and the record keeps the
 * sentence. Narrow on purpose — every entry here is a device-side fact the
 * owner can act on, and nothing here could be a verdict on the task.
 */
const HARNESS_FAULT_RE =
  /unrecognized_model|model not allowed|model_not_found|unknown model|invalid[_ ]api[_ ]key|invalid[_ ]request[_ ]error.*model|401 unauthorized|403 forbidden|authentication_error|is not installed on this clawbox|clawbox ai is not connected/i;

/** Does this failure mean the harness itself is not ready? */
export function isHarnessFault(error: string | null | undefined): boolean {
  return typeof error === "string" && HARNESS_FAULT_RE.test(error);
}

/**
 * How much of the CLI's own line is kept beside the owner's sentence.
 *
 * Kept at all because it is the only evidence of WHICH model was refused, and
 * that is the first thing anyone looking at this needs; kept short because the
 * rest of it is a JSON envelope with nothing in it for a reader.
 */
export const HARNESS_FAULT_DETAIL_CHARS = 200;

/** The owner-facing sentence. English here, and a locale key on the card. */
export const HARNESS_NOT_READY_SENTENCE =
  "The coding harness on this ClawBox is not ready: it could not get a model to answer."
  + " This is a problem with the device, not with the task."
  + " Check that ClawBox AI is connected and that your plan covers the model the harness asks for"
  + " (Settings → AI Models), then start the run again.";

/**
 * The record's `error` for a run that died because the harness is not ready:
 * the sentence a person can act on, then the line the CLI actually printed.
 *
 * The raw line goes SECOND and is trimmed to one line. Put first — which is
 * where it was — it is what the card leads with, and a bracketed error code
 * full of JSON is the least useful thing the owner could be handed.
 */
export function harnessFaultMessage(raw: string | null | undefined): string {
  const detail = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!detail) return HARNESS_NOT_READY_SENTENCE;
  return `${HARNESS_NOT_READY_SENTENCE}\n\nWhat the harness reported: ${detail.slice(0, HARNESS_FAULT_DETAIL_CHARS)}`;
}

/** The config-store key the fault is remembered under. */
export const HARNESS_FAULT_CONFIG_KEY = "coding_agent_harness_fault";

/**
 * How long a recorded fault keeps refusing runs.
 *
 * Long enough that a person who starts three runs in a row is stopped after
 * the first, short enough that a box which recovered on its own is not left
 * refusing work with no way back but a setting nobody knows about. A run that
 * COMPLETES clears it sooner, and that is the reliable path — this is only the
 * floor under it.
 */
export const HARNESS_FAULT_TTL_MS = 15 * 60_000;

/**
 * A remembered fault is a TIME and nothing else.
 *
 * There was a `error` field here holding the failure as the harness reported
 * it, and nothing read it: the readiness sentence deliberately does not quote
 * a bracketed error code full of JSON (that is the thing this whole change
 * took OFF the owner's screen), and the run's own record already carries the
 * full message for anyone who needs it. A field stored for a reader that does
 * not exist is a promise the code does not keep.
 */
export interface HarnessFault {
  /** When the fault was recorded (ms since the epoch). */
  at: number;
}

/**
 * Read a fault off the config store, or null — including when it has expired.
 *
 * Strict, and the only reader: a hand-edited config, or a value from a build
 * that stored something else under this key, must read as "no fault" rather
 * than as a fault the surfaces cannot describe. An `at` in the future is not
 * trusted either, since a clock that jumped would otherwise pin the box shut
 * for as long as the jump lasted.
 */
export function parseHarnessFault(value: unknown, now: number = Date.now()): HarnessFault | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return null;
  if (raw.at > now || now - raw.at > HARNESS_FAULT_TTL_MS) return null;
  return { at: raw.at };
}

/** What the readiness probe says about a remembered fault. One sentence, like its siblings. */
export function harnessFaultProblem(fault: HarnessFault, now: number = Date.now()): string {
  const minutes = Math.max(1, Math.round((HARNESS_FAULT_TTL_MS - (now - fault.at)) / 60_000));
  return `${HARNESS_NOT_READY_SENTENCE} A run has just failed this way, so new runs are refused for about ${minutes} more minute${minutes === 1 ? "" : "s"} rather than failing the same way.`;
}
