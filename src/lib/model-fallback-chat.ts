/**
 * The chat's half of the model fallback — client-safe.
 *
 * A turn on a model the owner's account cannot run never fails on its own in
 * reasonable time: a 429 stating a limit of zero is retried by the core for
 * more than a minute (src/lib/provider-model-fallback.ts has the whole story),
 * and only the chat sees it happening — the core tells every chat client, before
 * each wait, that the attempt failed on a rate limit (`agent` lifecycle
 * `finishing`) and that it is about to retry (`run_status` `retrying`). So the
 * chat reports the run to /setup-api/ai-models/model-fallback the moment it
 * sees the first of those, once per run, and only for a provider whose models
 * fall back (src/lib/provider-newest-model.ts) — every other turn costs no
 * request at all. The server confirms the zero limit from the gateway's own log
 * before it touches anything, so an ordinary throttle reported here is simply
 * answered `handled: false` and its retry goes on.
 *
 * A `model_not_found` error is reported the same way from the run's error
 * frame: the core does not retry it, and the server moves the chat and sends
 * the turn again.
 *
 * The same shape as the Anthropic account swap's chat half
 * (src/lib/anthropic-chat-swap.ts): a local "is this one at all?", the report,
 * and the line the chat adds, in the owner's language.
 */

import type { ChatRunFailureContext, ChatFailureWords } from "@/lib/chat-error-text";
import { providerDisplayName } from "@/lib/chat-error-text";
import type { ChatNoticeActions } from "@/lib/chat-history-cache";
import { modelAvailabilityEn } from "@/lib/edition-translations/en-model-availability";
import { followsNewestModel } from "@/lib/provider-newest-model";
import {
  CHAT_MODEL_STATE_EVENT,
  dispatchOpenSettingsSection,
  onStandaloneAppPage,
  standaloneSettingsHref,
} from "@/lib/ui-events";
import { creditConsoleFor } from "@/lib/zero-quota";

/** The route's answer (src/lib/provider-model-fallback.ts `ModelFallbackOutcome`). */
export interface ModelFallbackAnswer {
  handled: boolean;
  pending?: boolean;
  kind?: "zero_quota" | "not_found";
  provider?: string;
  model?: string;
  modelLabel?: string;
  fallbackModel?: string | null;
  fallbackLabel?: string | null;
  switched?: boolean;
  resent?: boolean;
  news?: boolean;
  /** No model of the provider runs on this account right now: the box stopped instead of moving the chat. */
  accountExhausted?: boolean;
  /** Another provider the box can chat with, for the one-click switch. */
  alternative?: { model: string; label: string; provider: string | null } | null;
}

/** A run worth reporting, as read off its frames. */
export interface ModelFallbackSignal {
  runId: string;
  provider: string;
  model: string;
  reason: "rate_limit" | "model_not_found";
  /** Whatever words the frames carried for the failure. */
  evidence: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asText = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/** `xai/grok-4.6` → `xai`. */
function providerOfRef(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash).toLowerCase() : "";
}

/** How many runs to remember: only the last few can still be reported. */
const WATCH_CAP = 16;

/**
 * Per-run bookkeeping for one chat surface: which runs were reported, and
 * whether a `Stopped.` line is owed for a run the server stopped.
 *
 * Why the stop line is held. The server ends a zero-limit run with
 * `chat.abort`, and the chat renders an aborted run as "Stopped." — the line
 * for the owner pressing Stop, which they did not. While a report is out, that
 * line is held; the answer either explains the stop (handled) or, when the box
 * did not act, the held line is given back.
 */
export class ModelFallbackWatch {
  private readonly runs = new Map<string, { state: "pending" | "handled" | "declined"; stopHeld: boolean }>();

  private remember(runId: string, entry: { state: "pending" | "handled" | "declined"; stopHeld: boolean }): void {
    this.runs.delete(runId);
    this.runs.set(runId, entry);
    while (this.runs.size > WATCH_CAP) {
      const oldest = this.runs.keys().next().value;
      if (oldest === undefined) break;
      this.runs.delete(oldest);
    }
  }

  /**
   * An `agent` frame of a run about to retry a RATE LIMIT on a provider whose
   * models fall back — or null. `context` is what the run's earlier frames said
   * (`RunFailureLedger.peek`), which a `run_status` frame needs: it names the
   * reason but not the model.
   */
  fromAgentFrame(payload: unknown, context: ChatRunFailureContext | undefined): ModelFallbackSignal | null {
    const frame = asRecord(payload);
    const runId = frame ? asText(frame.runId) : "";
    const data = asRecord(frame?.data);
    if (!frame || !runId || !data || this.runs.has(runId)) return null;
    const phase = asText(data.phase);
    let provider = "";
    let model = "";
    let evidence = "";
    if (frame.stream === "lifecycle" && phase === "finishing") {
      const observation = asRecord(data.errorObservation);
      if (asText(observation?.failoverReason) !== "rate_limit") return null;
      model = asText(observation?.model);
      provider = asText(observation?.provider).toLowerCase() || providerOfRef(model);
      evidence = [asText(data.error), asText(observation?.providerErrorMessagePreview)].filter(Boolean).join("\n");
    } else if (frame.stream === "run_status" && phase === "retrying") {
      if (asText(data.reason) !== "rate_limit") return null;
      model = asText(context?.model);
      provider = asText(context?.provider).toLowerCase() || providerOfRef(model);
      evidence = asText(context?.detail);
    } else {
      return null;
    }
    if (!model || !followsNewestModel(provider)) return null;
    return { runId, provider, model, reason: "rate_limit", evidence };
  }

  /** A run's `chat` error frame that says the provider does not offer the model — or null. */
  fromChatError(runId: unknown, context: ChatRunFailureContext | undefined, errorMessage: unknown): ModelFallbackSignal | null {
    const id = asText(runId);
    if (!id || this.runs.has(id) || asText(context?.reason) !== "model_not_found") return null;
    const model = asText(context?.model);
    const provider = asText(context?.provider).toLowerCase() || providerOfRef(model);
    if (!model || !followsNewestModel(provider)) return null;
    return { runId: id, provider, model, reason: "model_not_found", evidence: [asText(errorMessage), asText(context?.detail)].filter(Boolean).join("\n") };
  }

  /** The report for `runId` is on its way. */
  begin(runId: string): void {
    this.remember(runId, { state: "pending", stopHeld: false });
  }

  /**
   * The run ended `aborted`. True when the chat must NOT say "Stopped." now —
   * a report for it is out, or the box already explained the stop.
   */
  holdStop(runId: unknown): boolean {
    const id = asText(runId);
    const entry = id ? this.runs.get(id) : undefined;
    if (!entry || entry.state === "declined") return false;
    if (entry.state === "pending") entry.stopHeld = true;
    return true;
  }

  /**
   * The answer came. True when the chat owes the held "Stopped." line after
   * all: the box did not act, and the run was stopped while it was asked.
   */
  settle(runId: string, answer: ModelFallbackAnswer | null): boolean {
    const entry = this.runs.get(runId);
    const handled = answer?.handled === true;
    this.remember(runId, { state: handled ? "handled" : "declined", stopHeld: false });
    return !handled && entry?.stopHeld === true;
  }
}

export interface ModelFallbackReportInput extends ModelFallbackSignal {
  sessionKey: string | null;
  /** The turn's text, when it can be sent again as it was (no attachments). */
  message: string | null;
}

/** Hand the run over. Null when the report could not be made. Never throws. */
export async function reportModelFallback(input: ModelFallbackReportInput): Promise<ModelFallbackAnswer | null> {
  try {
    const res = await fetch("/setup-api/ai-models/model-fallback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: input.provider,
        model: input.model,
        reason: input.reason,
        evidence: input.evidence.slice(0, 4_000),
        sessionKey: input.sessionKey,
        runId: input.runId,
        message: input.message,
      }),
    });
    if (!res?.ok) return null;
    const answer = await res.json() as ModelFallbackAnswer;
    return answer && typeof answer === "object" ? answer : null;
  } catch {
    return null;
  }
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * One of this feature's sentences in the owner's language, with the English
 * table under it — `t` answers the key itself for a key it does not know.
 */
export function modelAvailabilityText(t: Translate | undefined, key: string, params: Record<string, string> = {}): string {
  const hit = t?.(key, params);
  let out = hit && hit !== key ? hit : (modelAvailabilityEn[key] ?? "");
  for (const [name, value] of Object.entries(params)) out = out.replaceAll(`{${name}}`, value);
  return out;
}

/** What the chat adds for an answer: the line, drawn calm, and the buttons under it. */
export interface ModelFallbackNotice {
  text: string;
  variant: "notice";
  actions?: ChatNoticeActions;
}

/**
 * The note the chat adds: why the model cannot run on this account, what the
 * box did about it, and how to get going again. Calm, never red: the owner's
 * account has no quota for a model, which is a fact about the account and not
 * a fault of the box. Null when the box did not act.
 *
 * When NO model of the provider runs on the account (`accountExhausted`) it is
 * one sentence for the provider, not a model-by-model account, with Settings →
 * Providers and — when the box has one set up — a switch to another provider.
 */
export function modelFallbackNotice(answer: ModelFallbackAnswer | null, words: Pick<ChatFailureWords, "t">): ModelFallbackNotice | null {
  if (!answer?.handled) return null;
  const say = (key: string, params: Record<string, string>): string => modelAvailabilityText(words.t, key, params);
  const provider = providerDisplayName(answer.provider);
  const creditConsole = creditConsoleFor(answer.provider);
  const fallback = answer.fallbackLabel || answer.fallbackModel || "";
  const actions: ChatNoticeActions | undefined = fallback
    ? undefined
    : { openProviders: true, ...(answer.alternative?.model ? { switchTo: answer.alternative } : {}) };
  if (answer.accountExhausted && !fallback) {
    return { text: say("chat.modelUnavailableAccountNoQuota", { provider, console: creditConsole ?? provider }), variant: "notice", actions };
  }
  const model = answer.modelLabel || answer.model || "";
  const parts = [
    say(answer.kind === "not_found" ? "chat.modelUnavailableNotFound" : "chat.modelUnavailableZeroQuota", { model, provider }),
  ];
  if (!fallback) parts.push(say("chat.modelUnavailableNone", { provider }));
  else if (answer.pending) parts.push(say("chat.modelUnavailableSwitching", { fallback }));
  else if (!answer.switched) parts.push(say("chat.modelUnavailablePick", { fallback }));
  else parts.push(say(answer.resent ? "chat.modelUnavailableResent" : "chat.modelUnavailableSwitched", { fallback }));
  if (answer.kind !== "not_found" && creditConsole) {
    parts.push(say("chat.modelUnavailableAddCredit", { model, console: creditConsole }));
  }
  return { text: parts.filter(Boolean).join(" "), variant: "notice", ...(actions ? { actions } : {}) };
}

/** The note's words alone — for a surface that has nowhere to put the buttons. */
export function describeModelFallback(answer: ModelFallbackAnswer | null, words: Pick<ChatFailureWords, "t">): string | null {
  return modelFallbackNotice(answer, words)?.text ?? null;
}

/**
 * The notice's "Settings → Providers": the Settings window on its Providers
 * section — or, on the standalone `/app/<id>` page a phone lands on, where no
 * desktop listens for the open, that page's own Settings address.
 */
export function openProvidersSettings(): void {
  if (typeof window === "undefined") return;
  if (onStandaloneAppPage()) window.location.assign(standaloneSettingsHref("ai"));
  else dispatchOpenSettingsSection("ai");
}

/**
 * The notice's one-click switch, for a surface without the header picker's own
 * switch: the same request the picker sends — the owner's choice, so not
 * `automatic` — then the signal every picker on the page re-reads its state on.
 * A 502 carrying a warning is a switch that landed while the gateway settles.
 */
export async function switchChatToProvider(target: { model: string; provider: string | null }): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/setup-api/chat/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: target.model, ...(target.provider ? { provider: target.provider } : {}) }),
    });
    const data = await res.json().catch(() => ({})) as { error?: unknown; warning?: unknown };
    const landed = res.ok || (res.status === 502 && typeof data.warning === "string" && data.warning !== "");
    if (!landed) return { ok: false, error: typeof data.error === "string" && data.error ? data.error : `HTTP ${res.status}` };
    if (typeof window !== "undefined") window.dispatchEvent(new Event(CHAT_MODEL_STATE_EVENT));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
