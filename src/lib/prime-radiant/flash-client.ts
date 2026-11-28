/**
 * The model call behind Prime Radiant's writer: ClawBox AI's Flash model
 * through the box's own proxy and credential, behind an interface a test (or
 * the end-to-end harness) replaces.
 *
 * The credential is resolved per call (`resolveClawaiToken`, the same reader
 * every other ClawBox AI path uses), never logged, never captured at import.
 * A 401/403 the proxy itself names as a refused credential is remembered
 * through the shared memo, exactly as the embedding and picture paths do.
 *
 * The calls are counted against the box's ClawBox AI plan allowance, the
 * same rolling weekly pool (and 5-hour burst ceiling) a chat turn draws on —
 * the proxy does the counting, `allowance-meter.ts` shows Prime Radiant's
 * share. A 429 that names a spent allowance (weekly or burst) is an
 * `allowance` refusal, not a busy proxy: no retry gets past it before it frees
 * up, so it is asked once, and every pass stops its step on it with that
 * reason ({@link allowanceStopOf}), leaving the rest queued for the next run.
 *
 * Which client answers, in order: an override a test installed
 * ({@link setFlashClientOverride}, kept in `processStore` because the routes
 * and the boot layer are separate module copies); the deterministic stub when
 * the box runs under `CLAWBOX_TEST_MODE=1` with `PRIME_RADIANT_FLASH_STUB=1`
 * (the browser smoke test cannot mock a server-side call); otherwise the
 * engine `feature-engine.ts` names (TASK-2501 PR-C): ClawBox AI's proxy on a
 * box signed in to it, else the box's own engine
 * ({@link createLocalFlashClient}: Local AI or the owner's External engine) —
 * which is also the one engine the local-only AI lock allows.
 *
 * A THIRD CHOICE, THE OWNER'S OWN ANTHROPIC ACCOUNT (TASK-2874): when the
 * owner picks `anthropic` in Prime Radiant's settings ({@link createAnthropicFlashClient}),
 * every call goes to Anthropic's Messages API with an API key of the coding
 * agent's account pool (src/lib/anthropic-accounts.ts: the same accounts, the
 * same owner secret store; the key is read per call, never logged, never in
 * argv, a response body or data/config.json). The pool's own fallback applies:
 * an account at its usage limit, or whose key Anthropic refuses, is marked in
 * the pool and the next API-key account answers. When none can, the call fails
 * with the reason (`allowance` for accounts at their limit, `auth` for refused
 * keys, `no_credential` for none saved) — never a silent move to ClawBox AI or
 * the box's own engine. Subscription sign-ins (`oauth`, the `claude` login) are
 * not used: they are for Claude Code and the gateway, not a direct API call.
 * The local-only AI lock still wins: with it on, the choice is not honoured and
 * the pass uses the engine the lock allows, as for ClawBox AI. The calls are
 * recorded under the Claude model id and are counted against no ClawBox AI
 * allowance.
 *
 * THE BOX'S OWN ENGINE HAS A WINDOW. A client that answers from it carries a
 * {@link FlashBudget} — the window, the longest answer, one request at a
 * time — and every pass sizes its calls to it (the writer's batches:
 * writer.ts `writerLimits`); the client itself cuts each answer's ceiling to
 * what is left of the window after the prompt and refuses, as `too_long`, a
 * prompt that leaves no room to answer. Its calls are counted against no
 * ClawBox AI allowance: they are recorded under the engine's own model ref
 * (`llamacpp/…`, `ollama/…`, `clawext/…`), which the allowance meter leaves out.
 *
 * SERVER ONLY.
 */

import {
  CLAWAI_ALLOWANCE_KINDS,
  formatFreesUpAt,
  readClawaiAllowanceRefusal,
  type ClawaiAllowanceKind,
  type ClawaiAllowanceRefusal,
} from "@/lib/clawai-allowance";
import { CLAWBOX_AI_FLASH_MODEL_ID } from "@/lib/clawbox-ai-models";
import { clawboxAiProxyUrl } from "@/lib/clawbox-ai-models";
import { CLOUD_AI_LOCKED_MESSAGE, isCloudAiLocked } from "@/lib/ai-cloud-lock";
import {
  clawaiCredentialGeneration,
  noteClawaiCredentialRefused,
  proxyRefusedClawaiCredential,
  resolveClawaiToken,
} from "@/lib/harness/credentials";
import { resolveFeatureEngine } from "@/lib/feature-engine";
import { postLocalChat, type LocalEngine } from "@/lib/local-engine";
import { processStore } from "@/lib/process-store";
import { estimateTokens } from "@/lib/token-estimate";
import { createStubFlashClient } from "./flash-stub";
import { redactText } from "./redact";
import { readSettings } from "./settings";

export interface FlashUsage {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens the provider served from its cache (cheaper). */
  cacheHitTokens: number;
}

export interface FlashRequest {
  system: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface FlashResponse {
  text: string;
  usage: FlashUsage;
  model: string;
  /** Why the model stopped, as the provider says it (`stop`, `length` …); absent when it did not say. */
  finishReason?: string | null;
}

/** What one request to a model with a bounded window may carry: the box's own engine. */
export interface FlashBudget {
  /** The window, prompt and answer together, in tokens. */
  contextTokens: number;
  /** The longest answer the engine is asked for, in tokens. */
  maxOutputTokens: number;
  /** Requests in flight at once. */
  parallel: number;
}

export interface FlashClient {
  readonly model: string;
  /** Where the calls are answered; absent is ClawBox AI (and a test's client). */
  readonly engine?: "clawbox-ai" | "local" | "anthropic";
  /** Present on a client whose model has a bounded window: every pass sizes its calls to it. */
  readonly budget?: FlashBudget;
  complete(request: FlashRequest): Promise<FlashResponse>;
}

export type FlashErrorKind =
  | "no_credential"
  /** No engine can write: the local-only AI lock is on and the box has no model of its own. */
  | "no_engine"
  /** The request does not fit the model's window, or the model did not finish it in time: asked again smaller, never as it was. */
  | "too_long"
  | "auth"
  | "refused"
  | "rate_limited"
  | "allowance"
  | "server"
  | "network"
  | "bad_response"
  | "aborted";

const RETRYABLE: ReadonlySet<FlashErrorKind> = new Set(["rate_limited", "server", "network", "bad_response"]);

export class FlashCallError extends Error {
  constructor(
    readonly kind: FlashErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
    /** The spent allowance an `allowance` refusal names, with its "frees up at"; null for every other kind. */
    readonly allowance: (ClawaiAllowanceRefusal & { provider?: "anthropic" }) | null = null,
  ) {
    super(message);
    this.name = "FlashCallError";
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

/** What a spent allowance is called where a job or a pass says why it stopped. */
const ALLOWANCE_MESSAGES: Record<ClawaiAllowanceKind, string> = {
  weekly: "ClawBox AI's weekly allowance is used up.",
  burst: "ClawBox AI's 5-hour burst limit is reached.",
  embeddings: "ClawBox AI's weekly memory-indexing allowance is used up.",
};

/** The reason a step records when a spent ClawBox AI allowance stopped it: neither done nor failed. */
export const ALLOWANCE_SPENT = "allowance_spent";

/** The spent allowance a step stopped on: which window, and when it frees up (ISO 8601, or null when the proxy did not say). */
export interface AllowanceStop {
  kind: ClawaiAllowanceKind;
  resetAt: string | null;
  /** Set when the accounts at their limit are the owner's own Anthropic accounts, not the box's ClawBox AI plan. */
  provider?: "anthropic";
}

/**
 * The spent allowance `err` names — a Flash call's `allowance` refusal, or
 * the embedder's (`EmbeddingUnavailableError.allowance`, read by shape so the
 * embedder is not loaded to ask) — or null for any other failure.
 */
export function allowanceStopOf(err: unknown): AllowanceStop | null {
  if (err instanceof FlashCallError && err.kind !== "allowance") return null;
  const a = err && typeof err === "object" ? (err as { allowance?: unknown }).allowance : null;
  if (!a || typeof a !== "object") return null;
  const { kind, resetAt, provider } = a as { kind?: unknown; resetAt?: unknown; provider?: unknown };
  if (!(CLAWAI_ALLOWANCE_KINDS as readonly unknown[]).includes(kind)) return null;
  return { kind: kind as ClawaiAllowanceKind, resetAt: typeof resetAt === "string" ? resetAt : null, ...(provider === "anthropic" ? { provider } : {}) };
}

/**
 * "ClawBox AI allowance spent, frees up at <when>" — the box's clock, in the
 * words a pass's notes and a job's error are written in; without the instant
 * when the refusal carried none.
 */
export function allowanceSpentText(stop: AllowanceStop, options: { now?: number; timeZone?: string | null } = {}): string {
  const at = formatFreesUpAt(stop.resetAt, { locale: "en", now: options.now, timeZone: options.timeZone });
  if (stop.provider === "anthropic") return at ? `Every Anthropic account is at its limit, back at ${at}` : "Every Anthropic account is at its limit";
  return at ? `ClawBox AI allowance spent, frees up at ${at}` : "ClawBox AI allowance spent";
}

/** One Flash call's ceiling: a 50-file batch measured ~133 s at the median. */
export const FLASH_CALL_TIMEOUT_MS = 6 * 60_000;

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120_000);
  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.max(0, Math.min(at - Date.now(), 120_000));
  return null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

/** The OpenAI-shaped `usage` block, as DeepSeek reports it. */
export function readUsage(raw: unknown): FlashUsage {
  const u = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    cacheHitTokens: num(u.prompt_cache_hit_tokens),
  };
}

export interface ClawboxAiFlashOptions {
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
}

export function createClawboxAiFlashClient(options: ClawboxAiFlashOptions = {}): FlashClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model ?? CLAWBOX_AI_FLASH_MODEL_ID;
  const timeoutMs = options.timeoutMs ?? FLASH_CALL_TIMEOUT_MS;
  return {
    model,
    engine: "clawbox-ai",
    async complete(request) {
      // Before the credential: a pass chosen before the local-only AI lock went
      // on sends nothing to the cloud once it is on (TASK-2501) — the answer is
      // the lock, not "not signed in": the box usually still is.
      if (await isCloudAiLocked()) throw new FlashCallError("no_engine", CLOUD_AI_LOCKED_MESSAGE);
      const token = await resolveClawaiToken();
      // Asked again after the read, the last await before the request: the
      // lock can go on while the credential was read — whether the read then
      // answered null (that is the lock, not a sign-out) or a token.
      if (await isCloudAiLocked()) throw new FlashCallError("no_engine", CLOUD_AI_LOCKED_MESSAGE);
      if (!token) throw new FlashCallError("no_credential", "This box is not signed in to ClawBox AI.");
      const generation = clawaiCredentialGeneration();
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (request.signal) signals.push(request.signal);
      let res: Response;
      try {
        res = await fetchImpl(`${clawboxAiProxyUrl()}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: request.maxTokens,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
          }),
          signal: AbortSignal.any(signals),
        });
      } catch (err) {
        if (request.signal?.aborted) throw new FlashCallError("aborted", "The ingest was stopped.");
        throw new FlashCallError("network", `ClawBox AI could not be reached: ${err instanceof Error ? err.name : "error"}`);
      }
      if (!res.ok) {
        const status = res.status;
        if (status === 401 || status === 403) {
          // The response itself, not a clone: nothing else reads this body, and
          // a teed clone's cancel waits for BOTH branches to be cancelled.
          const refused = await proxyRefusedClawaiCredential(res).catch(() => false);
          await Promise.resolve()
            .then(() => res.body?.cancel())
            .catch(() => undefined);
          if (refused) {
            await noteClawaiCredentialRefused(status, generation).catch(() => undefined);
            throw new FlashCallError("auth", "ClawBox AI refused this box's sign-in.", status);
          }
          throw new FlashCallError("refused", "ClawBox AI refused the request (plan or access).", status);
        }
        if (status === 429) {
          // Read (bounded), never cancelled unread: the body is where the proxy names a spent allowance.
          const refusal = await readClawaiAllowanceRefusal(res);
          if (refusal) throw new FlashCallError("allowance", ALLOWANCE_MESSAGES[refusal.kind], status, null, refusal);
          throw new FlashCallError("rate_limited", "ClawBox AI is busy (429).", status, retryAfterMs(res.headers.get("retry-after")));
        }
        await res.body?.cancel().catch(() => undefined);
        if (status >= 500) throw new FlashCallError("server", `ClawBox AI answered ${status}.`, status, retryAfterMs(res.headers.get("retry-after")));
        throw new FlashCallError("refused", `ClawBox AI answered ${status}.`, status);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new FlashCallError("bad_response", "ClawBox AI answered something that is not JSON.");
      }
      const b = (body ?? {}) as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>; usage?: unknown; model?: unknown };
      const text = b.choices?.[0]?.message?.content;
      const finish = b.choices?.[0]?.finish_reason;
      const finishReason = typeof finish === "string" ? finish : null;
      if (typeof text !== "string" || text.trim() === "") {
        throw new FlashCallError(
          "bad_response",
          finishReason === "length" ? "ClawBox AI reached the output cap before it answered." : "ClawBox AI answered with no text.",
        );
      }
      return { text, usage: readUsage(b.usage), model, finishReason };
    },
  };
}

// ── the box's own engine ──────────────────────────────────────────────────

/**
 * One call to the box's own engine: the wake of a stopped runtime (up to three
 * minutes) plus a small model's answer, which on a Jetson runs at tens of
 * tokens a second. Past it the request is `too_long`: asked again smaller,
 * never resent as it was.
 */
export const LOCAL_FLASH_CALL_TIMEOUT_MS = 15 * 60_000;
/** The chat template's own tokens around the system and user turns, plus a margin for the estimate. */
export const LOCAL_FRAME_TOKENS = 320;
/** A prompt that leaves less than this to answer in (or less than a shorter answer asked for) is `too_long` before it is sent. */
export const LOCAL_MIN_ANSWER_TOKENS = 256;

/** A refusal body that names the window: llama.cpp's `exceed_context_size_error`, Ollama's and vLLM's wording. */
const CONTEXT_REFUSAL_RE = /context|too long|exceed|maximum.*tokens|n_ctx/i;
const MAX_ERROR_BODY_CHARS = 4_096;

/** The first few KB of a refusal's body, read no further: an engine's error page is no reason to download it whole. */
async function errorBodyOf(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < MAX_ERROR_BODY_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // What arrived is what there is.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, MAX_ERROR_BODY_CHARS);
}

/** Does this request (prompt, frame and its longest answer) fit `budget`'s window, by the estimate the local client refuses with? */
export function fitsWindow(budget: FlashBudget, request: Pick<FlashRequest, "system" | "user" | "maxTokens">): boolean {
  const prompt = estimateTokens(request.system) + estimateTokens(request.user) + LOCAL_FRAME_TOKENS;
  return prompt + Math.min(request.maxTokens, budget.maxOutputTokens) <= budget.contextTokens;
}

/**
 * How many of the next items one call may carry: on a client with a bounded
 * window (the box's own engine), the most — up to `max` — whose request
 * `build(n)` fits it; at least one, whose own refusal (`too_long`) then says
 * so. `max` itself on a client with no budget (ClawBox AI's batches as they
 * always were).
 */
export function itemsThatFit(
  budget: FlashBudget | undefined,
  max: number,
  build: (n: number) => Pick<FlashRequest, "system" | "user" | "maxTokens">,
): number {
  const most = Math.max(1, Math.floor(max));
  if (!budget) return most;
  for (let n = most; n > 1; n--) if (fitsWindow(budget, build(n))) return n;
  return 1;
}

/**
 * A {@link FlashClient} on the box's own engine (`local-engine.ts`): the same
 * contract, the same error kinds, a {@link FlashBudget}. The answer's ceiling
 * is cut to what the window leaves after the prompt; a prompt that leaves too
 * little is refused before it is sent. Responses are recorded under the
 * engine's model ref, never a ClawBox AI model id.
 */
export function createLocalFlashClient(engine: LocalEngine, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): FlashClient {
  const timeoutMs = options.timeoutMs ?? LOCAL_FLASH_CALL_TIMEOUT_MS;
  const name = engine.kind === "clawext" ? "The External engine" : "The model on this box";
  return {
    model: engine.modelRef,
    engine: "local",
    budget: { contextTokens: engine.contextTokens, maxOutputTokens: engine.maxOutputTokens, parallel: engine.parallel },
    async complete(request) {
      const promptTokens = estimateTokens(request.system) + estimateTokens(request.user) + LOCAL_FRAME_TOKENS;
      const room = engine.contextTokens - promptTokens;
      const maxTokens = Math.min(request.maxTokens, engine.maxOutputTokens, room);
      // Too long: the window leaves less than a useful answer (or less than the short one asked for).
      if (maxTokens < 1 || room < Math.min(request.maxTokens, LOCAL_MIN_ANSWER_TOKENS)) {
        throw new FlashCallError("too_long", `${name} has a window of ${engine.contextTokens} tokens; this request needs about ${promptTokens} before its answer.`);
      }
      const timeout = AbortSignal.timeout(timeoutMs);
      const signals = [timeout];
      if (request.signal) signals.push(request.signal);
      let res: Response;
      try {
        res = await postLocalChat(
          engine,
          {
            temperature: 0,
            max_tokens: maxTokens,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
          },
          { signal: AbortSignal.any(signals), fetchImpl: options.fetchImpl },
        );
      } catch (err) {
        if (request.signal?.aborted) throw new FlashCallError("aborted", "The ingest was stopped.");
        if (timeout.aborted) throw new FlashCallError("too_long", `${name} did not answer within ${Math.round(timeoutMs / 60_000)} minutes.`);
        throw new FlashCallError("network", `${name} could not be reached: ${err instanceof Error ? err.name : "error"}`);
      }
      if (!res.ok) {
        const status = res.status;
        const body = await errorBodyOf(res);
        if (status === 401 || status === 403) {
          throw new FlashCallError("auth", engine.kind === "clawext" ? "The External engine refused this box's key. Check it in Settings → Local AI." : "The model on this box refused ClawBox's own key.", status);
        }
        if ((status === 400 || status === 413) && CONTEXT_REFUSAL_RE.test(body)) {
          throw new FlashCallError("too_long", `${name} refused the request as too long for its window.`, status);
        }
        if (status === 429) throw new FlashCallError("rate_limited", `${name} is busy (429).`, status, retryAfterMs(res.headers.get("retry-after")));
        if (status >= 500) throw new FlashCallError("server", `${name} answered ${status}.`, status, retryAfterMs(res.headers.get("retry-after")));
        throw new FlashCallError("refused", `${name} refused the request (${status}).`, status);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        // The same clock runs while the answer arrives: one cut there is the time, not the answer.
        if (request.signal?.aborted) throw new FlashCallError("aborted", "The ingest was stopped.");
        if (timeout.aborted) throw new FlashCallError("too_long", `${name} did not answer within ${Math.round(timeoutMs / 60_000)} minutes.`);
        throw new FlashCallError("bad_response", `${name} answered something that is not JSON.`);
      }
      const b = (body ?? {}) as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>; usage?: unknown };
      const text = b.choices?.[0]?.message?.content;
      const finish = b.choices?.[0]?.finish_reason;
      const finishReason = typeof finish === "string" ? finish : null;
      if (typeof text !== "string" || text.trim() === "") {
        throw new FlashCallError("bad_response", finishReason === "length" ? `${name} reached the output cap before it answered.` : `${name} answered with no text.`);
      }
      return { text, usage: readUsage(b.usage), model: engine.modelRef, finishReason };
    },
  };
}

// ── the owner's own Anthropic account ────────────────────────────────────

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Anthropic's own words, in a 400, when an organisation's or workspace's spend limit is reached — the pool's
 * classifier knows the CLI's wordings, not this one — and when it lifts ("You will regain access on 2026-12-01 at 00:00 UTC.").
 */
const API_SPEND_LIMIT_RE = /reached your specified API usage limits/i;
const REGAIN_ACCESS_RE = /regain access on (\d{4}-\d{2}-\d{2})(?: at (\d{2}:\d{2}))?/i;

/** What a step says when the owner chose Anthropic and no API key is saved on the box. */
export const NO_ANTHROPIC_KEY_MESSAGE =
  "Prime Radiant is set to write with your own Anthropic account, but no API key is saved on this box. Add one among the coding agent's Anthropic accounts, or choose Automatic in Prime Radiant's settings.";

export interface AnthropicFlashOptions {
  /** The Claude model id, as the owner picked it (and as the costs table records it). */
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * A {@link FlashClient} on the owner's own Anthropic API-key accounts: see the
 * module docblock. Each call asks the pool (`prepareAccount`) for the next
 * usable API-key account in the owner's order and sends it with `x-api-key`;
 * a usage limit or a refused key moves the pool on and the call to the next
 * account, and when none is left the error says why.
 */
export function createAnthropicFlashClient(options: AnthropicFlashOptions): FlashClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model;
  const timeoutMs = options.timeoutMs ?? FLASH_CALL_TIMEOUT_MS;
  return {
    model,
    engine: "anthropic",
    async complete(request) {
      // Before any account is touched, as for ClawBox AI: a pass chosen before the lock went on sends nothing to the cloud once it is.
      if (await isCloudAiLocked()) throw new FlashCallError("no_engine", CLOUD_AI_LOCKED_MESSAGE);
      // Lazily: the pool pulls the owner secret store, and a box that never chose Anthropic never loads it.
      const pool = await import("@/lib/anthropic-accounts");
      const { classifyAnthropicFailure, effectiveStatus, limitUntil, modelLimitedUntil, MAX_LIMIT_MS } = await import("@/lib/anthropic-limit");
      const { verifyAnthropicKey } = await import("@/lib/coding-anthropic");
      // Only API keys answer here: a sign-in is Claude Code's and the gateway's, not a direct API call's.
      const notKeys = (await pool.readAccounts()).filter((a) => a.kind !== "api_key").map((a) => a.id);
      const tried = new Set<string>(notKeys);
      let withTemperature = true;
      let refusal: FlashCallError | null = null;
      // The accounts THIS call found at a limit, and when it lifts: the pool's own write may have failed, and the call still knows.
      const limitedHere = new Map<string, number>();
      // A refused key the owner may have replaced meanwhile: asked for again, once per account, with the fresher copy preferred.
      const reread = new Set<string>();
      let prefer: { id: string; refused: string | null } | null = null;
      for (;;) {
        const { prepared } = await pool.prepareAccount({ exclude: tried, model, prefer });
        prefer = null;
        if (!prepared || prepared.credential.kind !== "api_key") break;
        const { account, credential } = prepared;
        tried.add(account.id);
        // The last await before the request: the lock can go on while the pool was read.
        if (await isCloudAiLocked()) throw new FlashCallError("no_engine", CLOUD_AI_LOCKED_MESSAGE);
        const signals = [AbortSignal.timeout(timeoutMs)];
        if (request.signal) signals.push(request.signal);
        let res: Response;
        try {
          res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": credential.secret, "anthropic-version": ANTHROPIC_VERSION },
            body: JSON.stringify({
              model,
              max_tokens: request.maxTokens,
              ...(withTemperature ? { temperature: 0 } : {}),
              system: request.system,
              messages: [{ role: "user", content: request.user }],
            }),
            signal: AbortSignal.any(signals),
          });
        } catch (err) {
          if (request.signal?.aborted) throw new FlashCallError("aborted", "The ingest was stopped.");
          throw new FlashCallError("network", `Anthropic could not be reached: ${err instanceof Error ? err.name : "error"}`);
        }
        if (res.ok) {
          let body: unknown;
          try {
            body = await res.json();
          } catch {
            throw new FlashCallError("bad_response", "Anthropic answered something that is not JSON.");
          }
          const b = (body ?? {}) as { content?: Array<{ type?: unknown; text?: unknown }>; stop_reason?: unknown; usage?: Record<string, unknown> };
          const text = (Array.isArray(b.content) ? b.content : []).map((c) => (c?.type === "text" && typeof c.text === "string" ? c.text : "")).join("");
          const stop = typeof b.stop_reason === "string" ? b.stop_reason : null;
          const finishReason = stop === "max_tokens" ? "length" : stop === "end_turn" || stop === "stop_sequence" ? "stop" : stop;
          if (text.trim() === "") {
            throw new FlashCallError("bad_response", finishReason === "length" ? "Anthropic reached the output cap before it answered." : "Anthropic answered with no text.");
          }
          // Prompt tokens are the uncached input plus what was written to and read from the cache; the read share is the cheaper one.
          const u = b.usage ?? {};
          const cacheHit = num(u.cache_read_input_tokens);
          const usage = { promptTokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + cacheHit, completionTokens: num(u.output_tokens), cacheHitTokens: cacheHit };
          return { text, usage, model, finishReason };
        }
        const status = res.status;
        const bodyText = await errorBodyOf(res);
        let apiMessage = "";
        try {
          const m = (JSON.parse(bodyText) as { error?: { message?: unknown } }).error?.message;
          if (typeof m === "string") apiMessage = redactText(m).text.slice(0, 200);
        } catch {
          // A body that is not Anthropic's JSON says nothing about the account.
        }
        const failure = classifyAnthropicFailure(`${status} ${bodyText}`, Date.now(), { transientRate: true, reason: status === 402 ? "billing" : null });
        let limit = failure?.type === "limit" && failure.limit.kind !== "rate" ? failure.limit : null;
        if (!limit && status === 400 && API_SPEND_LIMIT_RE.test(apiMessage)) {
          const when = REGAIN_ACCESS_RE.exec(apiMessage);
          const back = when ? Date.parse(`${when[1]}T${when[2] ?? "00:00"}:00Z`) : NaN;
          // A time the pool would not believe (past, or further out than it parks an account for) is no time: the default window.
          limit = { kind: "spend", resetsAt: back > Date.now() && back - Date.now() <= MAX_LIMIT_MS ? back : null };
        }
        if (limit) {
          // A usage limit or an empty balance: the account rests in the pool until it lifts, and the next account answers.
          const until = limitUntil(limit, Date.now());
          limitedHere.set(account.id, until);
          await pool.markLimited(account.id, until, limit.kind, { source: "box" }).catch(() => undefined);
          continue;
        }
        if (failure?.type === "auth") {
          // Asked the way the coding agent asks: a key Anthropic's own list also refuses is marked; a stale copy is not.
          const verdict = await pool.probeAccountCredential(account.id, verifyAnthropicKey, { source: "box" }, credential.secret).catch(() => "unknown" as const);
          refusal = new FlashCallError("auth", "Anthropic refused the API key saved on this box.", status);
          // The owner replaced the key while this call was in flight: the pool hands the fresher copy back; the refused one stays excluded.
          if (verdict === "ok" && !reread.has(account.id)) {
            reread.add(account.id);
            tried.delete(account.id);
            prefer = { id: account.id, refused: credential.secret };
          }
          continue;
        }
        // Not about the account: this call's own outcome.
        if (status === 400 && withTemperature && /temperature/i.test(apiMessage)) {
          // A model that takes no temperature: asked again without it, on the same account.
          withTemperature = false;
          tried.delete(account.id);
          continue;
        }
        if ((status === 400 || status === 413) && CONTEXT_REFUSAL_RE.test(`${apiMessage} ${bodyText}`)) {
          throw new FlashCallError("too_long", "Anthropic refused the request as too long for the model's window.", status);
        }
        if (status === 429) throw new FlashCallError("rate_limited", "Anthropic is busy (429).", status, retryAfterMs(res.headers.get("retry-after")));
        if (status >= 500) throw new FlashCallError("server", `Anthropic answered ${status}.`, status, retryAfterMs(res.headers.get("retry-after")));
        throw new FlashCallError("refused", `Anthropic refused the request (${status}${apiMessage ? `: ${apiMessage}` : ""}).`, status);
      }
      // No account is left to answer: say which way it ended.
      const keys = (await pool.readAccounts()).filter((a) => a.kind === "api_key");
      if (keys.length === 0) throw new FlashCallError("no_credential", NO_ANTHROPIC_KEY_MESSAGE);
      const now = Date.now();
      // At a limit now: the pool says so, or this call found it, or this MODEL's week is spent on it (the account stays `ok` for the others).
      const liftsAt = (a: (typeof keys)[number]): number | null =>
        limitedHere.get(a.id) ?? (effectiveStatus(a, now) === "limited" ? (a.limitedUntil ?? Infinity) : modelLimitedUntil(a, model, now));
      const limited = keys.filter((a) => liftsAt(a) !== null);
      if (limited.length > 0 && limited.length + keys.filter((a) => liftsAt(a) === null && (a.status === "revoked" || a.status === "expired")).length === keys.length) {
        const back = Math.min(...limited.map((a) => liftsAt(a) as number));
        const resetAt = Number.isFinite(back) ? new Date(back).toISOString() : null;
        const weekly = limited.some((a) => a.limitKind !== "session" && a.limitKind !== "rate");
        throw new FlashCallError("allowance", "Every Anthropic account saved on this box is at its limit.", 429, null, {
          kind: weekly ? "weekly" : "burst",
          resetAt,
          message: null,
          provider: "anthropic",
        });
      }
      if (refusal) throw refusal;
      // Nothing was refused: the accounts left were marked dead before this call, or could not be asked (the secret store did not answer).
      if (keys.some((a) => a.status === "revoked" || a.status === "expired")) {
        throw new FlashCallError("auth", "Anthropic does not accept any API key saved on this box. Replace it among the coding agent's Anthropic accounts.");
      }
      throw new FlashCallError("no_credential", "No Anthropic API key saved on this box could be read just now: the box's secret store did not answer.");
    },
  };
}

/** A client that answers every call with why nothing can write: no engine on a locked box. */
function unavailableFlashClient(): FlashClient {
  return {
    model: "none",
    async complete() {
      throw new FlashCallError("no_engine", NO_ENGINE_MESSAGE);
    },
  };
}

/** What a step says when the lock is on and the box has no model of its own. */
export const NO_ENGINE_MESSAGE = "Local-only AI is on, and no model is set up on this box to write the pages. Set up Local AI first.";

// ── which client answers ──────────────────────────────────────────────────

const store = processStore("prime-radiant:flash-client", () => ({ override: null as FlashClient | null }));

/**
 * The Claude model Prime Radiant is set to write with, or null: the box never
 * chose Anthropic (settings `model.provider` is `auto`, as it is until the
 * owner changes it), or the local-only AI lock is on (the lock wins).
 */
async function chosenAnthropicModel(): Promise<string | null> {
  const { provider, anthropicModel } = readSettings().model;
  return provider === "anthropic" && !(await isCloudAiLocked()) ? anthropicModel : null;
}

/** Whether a saved API key could answer right now: one that Anthropic refused for good does not count; one at its limit does (the call says so). */
async function anthropicKeyUsable(): Promise<boolean> {
  try {
    const { readAccounts } = await import("@/lib/anthropic-accounts");
    return (await readAccounts()).some((a) => a.kind === "api_key" && a.status !== "revoked" && a.status !== "expired");
  } catch {
    return false;
  }
}

/** Install a client every ingest uses instead of the real one (tests). `null` removes it. */
export function setFlashClientOverride(client: FlashClient | null): void {
  store.override = client;
}

export function stubEnabled(): boolean {
  return process.env.CLAWBOX_TEST_MODE === "1" && process.env.PRIME_RADIANT_FLASH_STUB === "1";
}

/**
 * The client a pass or an ingest uses, chosen once when it starts: see the
 * module docblock. A box with neither engine gets ClawBox AI's client, whose
 * first call answers `no_credential` as it always has; a locked box with no
 * model of its own gets one that answers `no_engine`.
 */
export async function flashClient(): Promise<FlashClient> {
  if (store.override) return store.override;
  if (stubEnabled()) return createStubFlashClient();
  const claude = await chosenAnthropicModel();
  if (claude) return createAnthropicFlashClient({ model: claude });
  const engine = await resolveFeatureEngine();
  if (engine.kind === "local") return createLocalFlashClient(engine.engine);
  if (engine.kind === "none" && engine.reason === "cloud_ai_locked") return unavailableFlashClient();
  return createClawboxAiFlashClient();
}

/**
 * Why a real call cannot be made right now, or null when one can (a stub or
 * override always can): the lock with no model on the box first, then neither
 * engine. A credential, not an allowance: a spent one is the proxy's answer to
 * the call itself — one request, then the step stops on `allowance` — never a
 * remembered refusal that would keep turning a since-upgraded plan away.
 */
export async function flashUnavailableReason(): Promise<"cloud_ai_locked" | "no_credential" | "no_anthropic_key" | null> {
  if (store.override || stubEnabled()) return null;
  if (await chosenAnthropicModel()) return (await anthropicKeyUsable()) ? null : "no_anthropic_key";
  const engine = await resolveFeatureEngine();
  return engine.kind === "none" ? engine.reason : null;
}

/** Whether a real call could be made right now: {@link flashUnavailableReason} is null. */
export async function flashAvailable(): Promise<boolean> {
  return (await flashUnavailableReason()) === null;
}

/** Which engine would write right now, for the views that say so: null when none can. */
export async function flashEngine(): Promise<"clawbox-ai" | "local" | "anthropic" | null> {
  if (store.override) return store.override.engine ?? "clawbox-ai";
  if (stubEnabled()) return "clawbox-ai";
  if (await chosenAnthropicModel()) return "anthropic";
  const engine = await resolveFeatureEngine();
  return engine.kind === "none" ? null : engine.kind;
}

// ── retries ───────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** Attempts in total, the first included. Default 4. */
  attempts?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Called before each retry with the error that caused it. */
  onRetry?: (err: FlashCallError, attempt: number) => void;
  /**
   * Whether a retryable error is worth the SAME request again (default: all
   * are). The contradiction judge says no to `bad_response`: an empty or
   * capped answer is asked again in smaller calls, not resent as it was.
   */
  retryOn?: (err: FlashCallError) => boolean;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new FlashCallError("aborted", "The ingest was stopped."));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new FlashCallError("aborted", "The ingest was stopped."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The first retry's base wait; each later one doubles it, up to {@link MAX_BACKOFF_MS}. */
export const BASE_BACKOFF_MS = 2_000;
export const MAX_BACKOFF_MS = 60_000;
/** The spread added to a server's Retry-After, so a hundred calls refused together do not all come back together. */
export const RETRY_AFTER_JITTER_MS = 2_000;

/**
 * The wait before retry `attempt` (1-based). The server's Retry-After plus a
 * little jitter; otherwise exponential backoff (2 s, 4 s, 8 s, … capped at a
 * minute) with "equal jitter" — half the step fixed, half random — so many
 * calls refused by the same 429 spread out instead of retrying in lockstep.
 */
export function backoffMs(err: FlashCallError, attempt: number, random: () => number = Math.random): number {
  if (err.retryAfterMs !== null) return err.retryAfterMs + Math.floor(random() * RETRY_AFTER_JITTER_MS);
  const step = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, Math.min(attempt - 1, 30)));
  return Math.floor(step / 2 + random() * (step / 2));
}

export interface CallOutcome {
  response: FlashResponse;
  /** How many attempts it took (1 = no retry). */
  attempts: number;
}

/**
 * One request with jittered exponential retries on 429, 5xx, a dropped connection and an
 * empty or non-JSON answer. A refused credential, a refused plan, a spent
 * allowance or an abort is not retried. Throws the last {@link FlashCallError}.
 */
export async function completeWithRetry(client: FlashClient, request: FlashRequest, options: RetryOptions = {}): Promise<CallOutcome> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const sleep = options.sleep ?? abortableSleep;
  let last: FlashCallError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return { response: await client.complete(request), attempts: attempt };
    } catch (err) {
      last = err instanceof FlashCallError ? err : new FlashCallError("network", err instanceof Error ? err.message : String(err));
      if (!last.retryable || attempt === attempts || (options.retryOn && !options.retryOn(last))) throw last;
      options.onRetry?.(last, attempt);
      await sleep(backoffMs(last, attempt, options.random), request.signal);
    }
  }
  throw last ?? new FlashCallError("network", "no attempt was made");
}

// ── cost estimate ─────────────────────────────────────────────────────────

/** The rates and the arithmetic live in one place, `cost-rates.ts`. */
export { estimateUsd } from "./cost-rates";
