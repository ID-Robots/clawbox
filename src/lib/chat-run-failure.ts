// ── What the gateway knows about a failed turn, kept until the turn ends ────
//
// A run that dies at the provider ends in ONE `chat` event, `state: "error"`,
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
// Pure, so both chat surfaces share it and it is tested on the wire shapes.
import type { ChatRunFailureContext } from "@/lib/chat-error-text";

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

/** How many runs' notes to keep: a run is one turn, and a turn ends in one error. */
const LEDGER_CAP = 8;

/**
 * Per-run notes, merged as the frames arrive, taken once when the turn ends.
 * Bounded: a run whose `chat` error never came (a socket that dropped between
 * the frames) must not leak its note for the life of the tab.
 */
export class RunFailureLedger {
  private readonly notes = new Map<string, ChatRunFailureContext>();

  /** Fold an `agent` event in; frames that carry nothing are ignored. */
  observe(agentPayload: unknown): void {
    const found = runFailureFromAgentEvent(agentPayload);
    if (!found) return;
    const previous = this.notes.get(found.runId);
    // Re-insert so the map's order is "most recently touched last".
    this.notes.delete(found.runId);
    this.notes.set(found.runId, { ...previous, ...found.context });
    while (this.notes.size > LEDGER_CAP) {
      const oldest = this.notes.keys().next().value;
      if (oldest === undefined) break;
      this.notes.delete(oldest);
    }
  }

  /**
   * Everything known about the run a `chat` frame ends — an error, or a final
   * that another model wrote: the notes taken from its lifecycle frames under
   * the facts the frame carries itself. The note is consumed.
   */
  settle(chatPayload: unknown): ChatRunFailureContext {
    const frame = asRecord(chatPayload);
    const runId = frame ? asText(frame.runId) : undefined;
    const noted = runId ? this.notes.get(runId) : undefined;
    if (runId) this.notes.delete(runId);
    return { ...noted, ...runFailureFromChatError(chatPayload) };
  }
}
