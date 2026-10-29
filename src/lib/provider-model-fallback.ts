// ── A model this account cannot run: move the chat to the next newest one ───
//
// THE FAILURE (xAI, 2026-10). The chat was on `grok-4.6`. xAI answered every
// call with a 429 stating a limit of zero — `Requests per Minute
// (actual/limit): 0/0` — because this account's spend tier carries no quota for
// that model, while Grok 4.7 on the same account answered in under two
// seconds. The core classified it as a temporary throttle and walked its
// transient-retry budget, `transient same-model retry 1/9 … 9/9` with 8–30 s
// waits, before telling the owner "The AI service needs a short break". More
// than a minute to learn nothing, and the next turn did it again.
//
// WHERE THE RETRY LIVES, AND WHY THIS IS NOT THERE. The retry is OpenClaw
// core's (`maybeRetryTransient`, pinned 2026.10.7). Its classification for xAI
// is the bundled xai plugin's `classifyFailoverReason`, which maps "too many
// requests" to `rate_limit` and knows no zero limit. No config key or plugin
// hook can re-classify another provider's error — core asks the PROVIDER'S
// plugin only — and patching node_modules is not on the table. What the core
// DOES give us, natively:
//
//   * it tells every chat client, before it waits, that this attempt failed
//     (`agent` lifecycle `finishing` with `errorObservation`) and that it is
//     about to retry (`run_status` `retrying`, reason `rate_limit`);
//   * it writes the provider's own refusal, 0/0 and all, into its file log
//     (`embedded run agent end … rawErrorPreview`), which `logs.tail` serves
//     to an operator connection;
//   * `chat.abort` ends a run mid-wait at once (`sleepWithAbort`), and
//     `chat.send` starts the turn again.
//
// So the chat reports the retry (src/lib/model-fallback-chat.ts), and this file
// confirms the zero limit from the gateway's own log — the chat never sees the
// provider's body, only the core's "short break" copy — then acts: marks the
// model unavailable for this account (src/lib/provider-model-availability.ts),
// moves the chat to the next newest model through the same switch the header
// picker uses, stops the retry loop, and sends the turn once more on the new
// model. A 429 that does not state a zero limit is NOT confirmed, is answered
// `handled: false`, and keeps the core's normal retry — a throttle passes.
//
// A 404 / `model_not_found` needs no confirmation: the gateway's failover
// reason already says it, and the core does not retry it. The turn has already
// ended, so there is nothing to stop; it is moved and sent again the same way.
//
// THE SHAPE IS THE ANTHROPIC ACCOUNT SWAP'S (src/lib/anthropic-gateway.ts): a
// chat surface reports, the server acts, the turn is sent again into its
// session once, under a stable idempotency key.

import { createHash } from "crypto";
import { fallbackModelId, followsNewestModel } from "@/lib/provider-newest-model";
import { statesZeroRateLimit } from "@/lib/zero-quota";
import type { CachedCatalogModel, UnavailableReason } from "@/lib/provider-model-availability";

/** What a chat surface reports. Every field is untrusted request input. */
export interface ModelFallbackReport {
  provider?: unknown;
  model?: unknown;
  /** The gateway's failover reason: `rate_limit` or `model_not_found`. */
  reason?: unknown;
  /** Whatever words the chat saw for the failure: the gateway's and the provider's. */
  evidence?: unknown;
  sessionKey?: unknown;
  runId?: unknown;
  /** The turn's text, when it can be sent again as it was (no attachments). */
  message?: unknown;
}

export interface ModelFallbackOutcome {
  handled: boolean;
  kind?: UnavailableReason;
  provider?: string;
  model?: string;
  modelLabel?: string;
  /** The model the chat was moved to; null when the account has no other. */
  fallbackModel?: string | null;
  fallbackLabel?: string | null;
  /** The chat's model was switched to `fallbackModel`. */
  switched?: boolean;
  /** The turn was sent again on `fallbackModel`. */
  resent?: boolean;
  /** First time this box learned it about this model — no live mark existed. */
  news?: boolean;
  /** The route stopped waiting: the switch and the resend carry on behind it. */
  pending?: boolean;
}

export interface ModelFallbackDeps {
  /** The gateway's `logs.tail` answer (`{ lines: string[] }`). */
  logsTail(params: { limit: number; maxBytes: number }): Promise<unknown>;
  // A property, not a method signature: harness-contract's scan reads
  // `gatewayCall(` as a gateway RPC call site, and the two calls below name
  // their methods as literals so the pinned core's surface checks them.
  gatewayCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Switch the chat's model the way the header picker does; true when it landed. */
  switchModel(ref: string): Promise<boolean>;
  readPrimary(): Promise<string | null>;
  readModels(provider: string): Promise<CachedCatalogModel[]>;
  readUnavailable(provider: string): Promise<Set<string>>;
  markUnavailable(provider: string, modelId: string, reason: UnavailableReason): Promise<boolean>;
  forgetPick(ref: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Told what was decided — confirmed, marked, next model chosen — before the slow part (switch, resend) runs. */
  onDecided?(outcome: ModelFallbackOutcome): void;
}

/** How far back a gateway log line may be and still be about this turn. */
const EVIDENCE_WINDOW_MS = 10 * 60_000;
/** The log write can trail the frame the chat reported on: ask a few times. */
const EVIDENCE_POLLS_MS = [0, 700, 1_500] as const;
const LOG_TAIL = { limit: 1_000, maxBytes: 600_000 } as const;

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** `xai/grok-4.6` and `grok-4.6` both read as the bare id, through a strict alphabet. */
function bareModelId(provider: string, model: string): string | null {
  const bare = model.toLowerCase().startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
  return MODEL_ID_RE.test(bare) ? bare : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** When a gateway log line was written, from either of the two places tslog puts it. */
function lineTime(line: string): number | null {
  try {
    const parsed = JSON.parse(line) as { time?: unknown; _meta?: { date?: unknown } };
    const raw = typeof parsed.time === "string" ? parsed.time : typeof parsed._meta?.date === "string" ? parsed._meta.date : null;
    const at = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/**
 * Does the gateway's file log hold a recent refusal of `provider/model` that
 * states a zero limit? Read off the core's own failed-attempt line, `embedded
 * run agent end`, which carries the provider and model and the provider's own
 * words (`rawErrorPreview`) — the only place the 0/0 survives on this core.
 *
 * Matched on the raw JSON text of the line rather than on tslog's positional
 * keys, which are an implementation detail of the logger; the model id needs a
 * boundary on both sides so `grok-4.6` never matches `grok-4.65`. A line whose
 * time cannot be read is not evidence: a refusal from last week must not move
 * the chat today.
 */
export function zeroQuotaInGatewayLog(
  lines: readonly unknown[],
  provider: string,
  modelId: string,
  now: number,
): boolean {
  const modelRe = new RegExp(`(^|[^\\w.-])${escapeRegExp(modelId)}($|[^\\w.-])`, "i");
  const providerRe = new RegExp(`(^|[^\\w-])${escapeRegExp(provider)}($|[^\\w-])`, "i");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (typeof line !== "string") continue;
    if (!/embedded[ _]run[ _]agent[ _]end/i.test(line)) continue;
    if (!modelRe.test(line) || !providerRe.test(line)) continue;
    const at = lineTime(line);
    if (at === null || now - at > EVIDENCE_WINDOW_MS || at - now > 60_000) continue;
    if (statesZeroRateLimit(line)) return true;
  }
  return false;
}

async function confirmZeroQuota(
  deps: ModelFallbackDeps,
  provider: string,
  modelId: string,
  evidence: string,
): Promise<boolean> {
  // The provider's words sometimes do reach the chat — a short refusal is
  // passed through as the core's user copy — and then nothing needs reading.
  if (statesZeroRateLimit(evidence)) return true;
  for (const wait of EVIDENCE_POLLS_MS) {
    if (wait > 0) await deps.sleep(wait);
    try {
      const tail = await deps.logsTail(LOG_TAIL) as { lines?: unknown };
      const lines = Array.isArray(tail?.lines) ? tail.lines : [];
      if (zeroQuotaInGatewayLog(lines, provider, modelId, deps.now())) return true;
    } catch (err) {
      // No log to read (gateway restarting, file logging off): unconfirmed,
      // and an unconfirmed 429 keeps the core's own retry.
      console.warn("[model-fallback] could not read the gateway log:", err instanceof Error ? err.message : err);
      return false;
    }
  }
  return false;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Reports for the same run collapse onto one action: two chat windows see the same frames. */
const inFlight = new Map<string, Promise<ModelFallbackOutcome>>();

export function handleModelFallback(report: ModelFallbackReport, deps: ModelFallbackDeps): Promise<ModelFallbackOutcome> {
  const provider = text(report.provider, 40).toLowerCase();
  const reason = text(report.reason, 40).toLowerCase();
  const modelId = provider ? bareModelId(provider, text(report.model, 200)) : null;
  if (!followsNewestModel(provider) || !modelId || (reason !== "rate_limit" && reason !== "model_not_found")) {
    return Promise.resolve({ handled: false });
  }
  const key = `${provider}/${modelId}:${text(report.runId, 200) || text(report.sessionKey, 300)}`;
  const running = inFlight.get(key);
  if (running) return running;
  const work = act(report, deps, provider, modelId, reason as "rate_limit" | "model_not_found")
    .finally(() => {
      // Kept a minute past the answer: the second window's report usually
      // arrives just after the first one's work finished.
      setTimeout(() => inFlight.delete(key), 60_000).unref?.();
    });
  inFlight.set(key, work);
  return work;
}

async function act(
  report: ModelFallbackReport,
  deps: ModelFallbackDeps,
  provider: string,
  modelId: string,
  reason: "rate_limit" | "model_not_found",
): Promise<ModelFallbackOutcome> {
  const kind: UnavailableReason = reason === "model_not_found" ? "not_found" : "zero_quota";
  if (kind === "zero_quota" && !(await confirmZeroQuota(deps, provider, modelId, text(report.evidence, 4_000)))) {
    return { handled: false };
  }
  const failedRef = `${provider}/${modelId}`;
  const news = await deps.markUnavailable(provider, modelId, kind);
  const [models, unavailable] = await Promise.all([deps.readModels(provider), deps.readUnavailable(provider)]);
  const fallback = fallbackModelId(provider, models, modelId, unavailable);
  const labelOf = (id: string) => models.find((m) => m.id === id)?.label ?? id;
  const outcome: ModelFallbackOutcome = {
    handled: true,
    kind,
    provider,
    model: modelId,
    modelLabel: labelOf(modelId),
    fallbackModel: fallback,
    fallbackLabel: fallback ? labelOf(fallback) : null,
    switched: false,
    resent: false,
    news,
  };
  console.warn(
    `[model-fallback] ${failedRef}: ${kind === "zero_quota" ? "the account's rate limit is 0" : "the provider does not serve it"}`
    + (fallback ? `, moving the chat to ${provider}/${fallback}` : ", and no other model of this provider is available"),
  );
  deps.onDecided?.({ ...outcome });

  const sessionKey = text(report.sessionKey, 300);
  const runId = text(report.runId, 200);
  // Stop the core's retry loop first, whatever happens next: waiting out nine
  // retries of a limit of zero is the failure this file exists for. A run that
  // has already ended (a 404 is not retried) has nothing to stop.
  if (kind === "zero_quota" && sessionKey) {
    await deps.gatewayCall("chat.abort", { sessionKey, ...(runId ? { runId } : {}) }).catch((err: unknown) => {
      console.warn("[model-fallback] could not stop the retrying run:", err instanceof Error ? err.message : err);
    });
  }
  if (!fallback) return outcome;

  // Move the chat only when it was ON the failed model. A primary elsewhere
  // means the turn ran on a session's own pick, and repointing the whole box
  // over one session is not this file's call — the sentence says which model
  // to pick instead.
  const primary = await deps.readPrimary().catch(() => null);
  if (primary?.toLowerCase() !== failedRef.toLowerCase()) return outcome;
  const fallbackRef = `${provider}/${fallback}`;
  outcome.switched = await deps.switchModel(fallbackRef).catch(() => false);
  if (!outcome.switched) return outcome;
  await deps.forgetPick(failedRef).catch(() => undefined);

  const message = text(report.message, 32_000);
  if (sessionKey && message) {
    try {
      // Stable for the turn it repeats, so a second report of the same failure
      // is the same delivery to the gateway rather than a second copy.
      await deps.gatewayCall("chat.send", {
        sessionKey,
        message,
        deliver: false,
        idempotencyKey: `clawbox-model-fallback-${fingerprint(`${sessionKey}:${runId}:${fallbackRef}:${message}`)}`,
      });
      outcome.resent = true;
    } catch (err) {
      console.warn("[model-fallback] could not send the turn again:", err instanceof Error ? err.message : err);
    }
  }
  return outcome;
}

/** Test seam: forget the reports in flight. */
export function _resetModelFallbackForTests(): void {
  inFlight.clear();
}
