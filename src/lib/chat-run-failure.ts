// ── What the gateway knows about a failed turn, kept until the turn ends ────
//
// A run that dies at the provider ends in a `chat` event, `state: "error"`,
// whose `errorMessage` is the gateway's user copy for its failover reason —
// and for a reason it has no copy for, the fallback sentence "The agent run
// failed before producing a reply." That is what a box showed the owner when
// Anthropic answered HTTP 400 "… does not support this model; version … or
// newer is required" (2026-09-17): the real reason was in the gateway's
// journal, as `[model-fallback/decision] … detail=HTTP 400: {…}`, and nowhere
// on screen.
//
// But the gateway does hand the client that detail — a few frames earlier, on
// the `agent` event stream, before the turn is declared dead:
//
//   agent  lifecycle  phase=finishing      errorObservation={provider, model, failoverReason}
//   agent  lifecycle  phase=fallback_step  fallbackStepFromFailureDetail="HTTP 404: {…provider JSON…}"
//   agent  lifecycle  phase=error          errorObservation={…}
//   chat   state=error                     errorMessage, errorDetail={provider, model, failoverReason}
//
// and when a configured FALLBACK model answers instead — the turn ends
// `final`, and nothing in that frame says another model wrote it:
//
//   agent  lifecycle  phase=fallback_step  fallbackStepFromModel, fallbackStepToModel, …FailureDetail
//   agent  lifecycle  phase=fallback       selectedModel, activeModel, reasonSummary, attempts[{error}]
//   chat   state=final                     message (no model, no provider)
//
// (captured verbatim on a box, core 2026.9.3). The `chat` event carries the
// reason and the model; only the lifecycle frames carry the provider's own
// words. This ledger keeps those frames by run id, for the few hundred
// milliseconds between them and the `chat` error, so the sentence the customer
// reads can name the provider's reason instead of the gateway's shrug.
//
// And the error is said TWICE (core 2026.9.4): a second `chat` error for the
// same run when dispatch completes, about seven seconds after the first,
//
//   chat   state=error   errorMessage="⚠️ Agent failed before reply: … `openclaw logs --follow` …"
//
// in the operator's wording and with no `errorDetail`. The ledger used to hand
// a run's notes over once, so that frame was worded from nothing: a failed
// turn got its reason and then the generic "send it again" under it — and in
// the mascot chat INSTEAD of it, a history re-read having taken the first
// sentence by then (2026-10-10). So a run an error frame ended is remembered:
// the repeat is answered with the same context and the first frame's sentence,
// and the chat is told it is a repeat, because the turn it would otherwise
// "end" may already be the owner's next one.
//
// And one run id is not always one run. The Claude account swap sends its
// retry under ONE key before and after the gateway restart that moves the box
// to the next account (lib/anthropic-gateway.ts); the restart empties the
// gateway's dedupe map, so the same key runs AGAIN, as a whole new run with
// its own frames. Read as the first run's repeat, that run's failure was
// swallowed: no sentence, no report to the account pool, and its half-written
// reply left up as a live bubble. What tells the two apart on the wire is what
// comes first — a run at work speaks on the `agent` stream before anything
// else (`run_status`, then its lifecycle), while the gateway's repeat is a
// bare `chat` frame with no `agent` frame between it and the first error
// (both captured on a live 2026.9.4 gateway).
//
// Pure, so both chat surfaces share it and it is tested on the wire shapes.
import type { ChatRunFailureContext } from "@/lib/chat-error-text";
import { runIdOf, type ChatMessage } from "@/lib/chat-history-cache";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The context the gateway attaches to its lifecycle and chat error frames. */
function fromObservation(value: unknown): ChatRunFailureContext {
  const observation = asRecord(value);
  if (!observation) return {};
  return {
    ...(asText(observation.provider) ? { provider: asText(observation.provider) } : {}),
    ...(asText(observation.model) ? { model: asText(observation.model) } : {}),
    ...(asText(observation.failoverReason) ? { reason: asText(observation.failoverReason) } : {}),
  };
}

/**
 * What an `agent` event payload says about a run's failure, or null when it
 * says nothing (a tool frame, an assistant delta, a heartbeat).
 */
export function runFailureFromAgentEvent(
  payload: unknown,
): { runId: string; context: ChatRunFailureContext } | null {
  const frame = asRecord(payload);
  const runId = frame ? asText(frame.runId) : undefined;
  if (!frame || !runId || frame.stream !== "lifecycle") return null;
  const data = asRecord(frame.data);
  if (!data) return null;
  const phase = asText(data.phase);
  if (phase === "fallback_step") {
    const context: ChatRunFailureContext = {
      ...(asText(data.fallbackStepFromFailureReason) ? { reason: asText(data.fallbackStepFromFailureReason) } : {}),
      ...(asText(data.fallbackStepFromModel) ? { model: asText(data.fallbackStepFromModel) } : {}),
      ...(asText(data.fallbackStepFromFailureDetail) ? { detail: asText(data.fallbackStepFromFailureDetail) } : {}),
      ...(asText(data.fallbackStepToModel) ? { servedModel: asText(data.fallbackStepToModel) } : {}),
    };
    return Object.keys(context).length ? { runId, context } : null;
  }
  if (phase === "error" || phase === "finishing") {
    const context = fromObservation(data.errorObservation);
    return Object.keys(context).length ? { runId, context } : null;
  }
  // The turn ENDED WELL, on another model: the gateway's summary of the
  // chain it walked. `selected*` is what the owner asked for, `active*` what
  // answered, and the first attempt's error is why (captured verbatim on a
  // box: a 401 on the picked model, then the configured fallback replied).
  if (phase === "fallback") {
    const attempts = Array.isArray(data.attempts) ? data.attempts : [];
    const first = asRecord(attempts[0]);
    const context: ChatRunFailureContext = {
      ...(asText(data.selectedProvider) ? { provider: asText(data.selectedProvider) } : {}),
      ...(asText(data.selectedModel) ? { model: asText(data.selectedModel) } : {}),
      ...(asText(data.reasonSummary) ? { reason: asText(data.reasonSummary) } : {}),
      ...(first && asText(first.error) ? { detail: asText(first.error) } : {}),
      ...(asText(data.activeProvider) ? { servedProvider: asText(data.activeProvider) } : {}),
      ...(asText(data.activeModel) ? { servedModel: asText(data.activeModel) } : {}),
    };
    return context.servedModel ? { runId, context } : null;
  }
  return null;
}

/** What a `chat` error payload says on its own: `errorDetail`. */
export function runFailureFromChatError(payload: unknown): ChatRunFailureContext {
  const frame = asRecord(payload);
  return frame ? fromObservation(frame.errorDetail) : {};
}

/** How many runs to keep: only the last few can still be named by a frame. */
const LEDGER_CAP = 8;

/**
 * One run: what its frames said, and — once an error frame has ended it — the
 * gateway sentence that frame carried.
 */
interface RunNote {
  context: ChatRunFailureContext;
  ended?: { errorMessage: unknown };
}

/** What a `chat` error frame settles to. */
export interface SettledRunError {
  /** The run the frame names, when it names one: what the failure note is tagged with. */
  runId?: string;
  /** Everything known about the run — the same on every error frame it sends. */
  context: ChatRunFailureContext;
  /**
   * The gateway sentence to word the failure from: the FIRST error frame's,
   * on a repeat too. The second frame wraps the same words in an instruction
   * to open a terminal, which the leak rules drop to the generic line.
   */
  errorMessage: unknown;
  /** An error frame already ended this run here: its sentence was shown and its turn is over. */
  repeat: boolean;
}

/**
 * The transcript with a failed run's sentence put back — or the transcript
 * itself when it still holds one: by its tag, or, for a note with no tag, by
 * its words (the mascot chat keeps a background tab's failure as text and
 * appends it when the owner returns).
 *
 * Put back in its PLACE, not at the end: after the failed run's own turn — the
 * owner's message and whatever of a reply followed it. The frame that asks for
 * this arrives seconds after the failure, and the sentence itself says "pick
 * another model … then send it again"; under the message the owner sent since,
 * "That message did not go through" would be false. A run whose turn is not in
 * the transcript (it began on another surface) keeps the end, where its first
 * note stood.
 */
export function withFailureNote<T extends ChatMessage>(transcript: T[], note: T & { failedRun: string }): T[] {
  const held = transcript.some((m) => m.role === "system"
    && (m.failedRun === note.failedRun || (m.failedRun === undefined && m.text === note.text)));
  if (held) return transcript;
  let at = transcript.length;
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role !== "user" || runIdOf(transcript[i].idempotencyKey) !== note.failedRun) continue;
    at = i + 1;
    while (at < transcript.length && transcript[at].role !== "user") at++;
    break;
  }
  return [...transcript.slice(0, at), note, ...transcript.slice(at)];
}

/**
 * Per-run notes, merged as the frames arrive and kept past the error that ends
 * the run, because the gateway sends that error twice. Bounded: a run whose
 * `chat` error never came (a socket that dropped between the frames) must not
 * leak its note for the life of the tab, and neither must one that did.
 */
export class RunFailureLedger {
  private readonly notes = new Map<string, RunNote>();

  /** Write a run's note as the most recently touched; the oldest go past the cap. */
  private keep(runId: string, note: RunNote): void {
    // Re-insert so the map's order is "most recently touched last".
    this.notes.delete(runId);
    this.notes.set(runId, note);
    while (this.notes.size > LEDGER_CAP) {
      const oldest = this.notes.keys().next().value;
      if (oldest === undefined) break;
      this.notes.delete(oldest);
    }
  }

  /**
   * A frame from a run AT WORK, under an id an error frame already ended: the
   * id is running again (see the header), so the ended run's note goes — its
   * ending and its context both, or the new run would be worded from the old
   * one's reason. A run's own closing lifecycle frame may trail its error; it
   * is not a run at work and forgets nothing.
   */
  private reopen(agentPayload: unknown): void {
    const frame = asRecord(agentPayload);
    const runId = frame ? asText(frame.runId) : undefined;
    if (!frame || !runId || !this.notes.get(runId)?.ended) return;
    const phase = asText(asRecord(frame.data)?.phase);
    if (frame.stream === "lifecycle" && (phase === "error" || phase === "end")) return;
    this.notes.delete(runId);
  }

  /** Fold an `agent` event in; frames that carry nothing are ignored. */
  observe(agentPayload: unknown): void {
    // Before the fold, and for EVERY agent frame: the frames a run opens with
    // (`run_status`) carry nothing to fold, and are the ones that say it began.
    this.reopen(agentPayload);
    const found = runFailureFromAgentEvent(agentPayload);
    if (!found) return;
    const previous = this.notes.get(found.runId);
    this.keep(found.runId, { ...previous, context: { ...previous?.context, ...found.context } });
  }

  /**
   * Everything known about the run a `chat` ERROR frame ends: the notes taken
   * from its lifecycle frames under the facts the frame carries itself. The
   * run is remembered, so the gateway's second error frame for it answers the
   * same context, the first frame's sentence, and `repeat`. A frame that names
   * no run is nobody's repeat, and neither is the error of a run that began
   * again under the id since (`reopen`).
   */
  settleError(chatPayload: unknown): SettledRunError {
    const frame = asRecord(chatPayload);
    const runId = frame ? asText(frame.runId) : undefined;
    const noted = runId ? this.notes.get(runId) : undefined;
    const context = { ...noted?.context, ...runFailureFromChatError(chatPayload) };
    const ended = noted?.ended ?? { errorMessage: frame?.errorMessage };
    if (runId) this.keep(runId, { context, ended });
    return { ...(runId ? { runId } : {}), context, errorMessage: ended.errorMessage, repeat: noted?.ended !== undefined };
  }

  /**
   * Everything known about the run a `chat` frame ends — an error, or a final
   * that another model wrote. An error is remembered (`settleError`); a
   * final's note is taken once, as it always was: nothing owes a second
   * "another model answered this" line.
   */
  settle(chatPayload: unknown): ChatRunFailureContext {
    const frame = asRecord(chatPayload);
    if (frame?.state === "error") return this.settleError(chatPayload).context;
    const runId = frame ? asText(frame.runId) : undefined;
    const noted = runId ? this.notes.get(runId) : undefined;
    if (runId) this.notes.delete(runId);
    return { ...noted?.context, ...runFailureFromChatError(chatPayload) };
  }
}
