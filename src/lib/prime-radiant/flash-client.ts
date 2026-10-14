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
 * Which client answers, in order: an override a test installed
 * ({@link setFlashClientOverride}, kept in `processStore` because the routes
 * and the boot layer are separate module copies); the deterministic stub when
 * the box runs under `CLAWBOX_TEST_MODE=1` with `PRIME_RADIANT_FLASH_STUB=1`
 * (the browser smoke test cannot mock a server-side call); otherwise the
 * real proxy.
 *
 * SERVER ONLY.
 */

import { CLAWBOX_AI_FLASH_MODEL_ID } from "@/lib/clawbox-ai-models";
import { clawboxAiProxyUrl } from "@/lib/clawbox-ai-vision";
import {
  clawaiCredentialGeneration,
  noteClawaiCredentialRefused,
  proxyRefusedClawaiCredential,
  resolveClawaiToken,
} from "@/lib/harness/credentials";
import { processStore } from "@/lib/process-store";
import { createStubFlashClient } from "./flash-stub";

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
}

export interface FlashClient {
  readonly model: string;
  complete(request: FlashRequest): Promise<FlashResponse>;
}

export type FlashErrorKind =
  | "no_credential"
  | "auth"
  | "refused"
  | "rate_limited"
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
  ) {
    super(message);
    this.name = "FlashCallError";
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
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
    async complete(request) {
      const token = await resolveClawaiToken();
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
        await res.body?.cancel().catch(() => undefined);
        if (status === 429) {
          throw new FlashCallError("rate_limited", "ClawBox AI is busy (429).", status, retryAfterMs(res.headers.get("retry-after")));
        }
        if (status >= 500) throw new FlashCallError("server", `ClawBox AI answered ${status}.`, status, retryAfterMs(res.headers.get("retry-after")));
        throw new FlashCallError("refused", `ClawBox AI answered ${status}.`, status);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new FlashCallError("bad_response", "ClawBox AI answered something that is not JSON.");
      }
      const b = (body ?? {}) as { choices?: Array<{ message?: { content?: unknown } }>; usage?: unknown; model?: unknown };
      const text = b.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.trim() === "") {
        throw new FlashCallError("bad_response", "ClawBox AI answered with no text.");
      }
      return { text, usage: readUsage(b.usage), model };
    },
  };
}

// ── which client answers ──────────────────────────────────────────────────

const store = processStore("prime-radiant:flash-client", () => ({ override: null as FlashClient | null }));

/** Install a client every ingest uses instead of the real one (tests). `null` removes it. */
export function setFlashClientOverride(client: FlashClient | null): void {
  store.override = client;
}

export function stubEnabled(): boolean {
  return process.env.CLAWBOX_TEST_MODE === "1" && process.env.PRIME_RADIANT_FLASH_STUB === "1";
}

export function flashClient(): FlashClient {
  if (store.override) return store.override;
  if (stubEnabled()) return createStubFlashClient();
  return createClawboxAiFlashClient();
}

/** Whether a real call could be made right now (a stub or override always can). */
export async function flashAvailable(): Promise<boolean> {
  if (store.override || stubEnabled()) return true;
  return (await resolveClawaiToken()) !== null;
}

// ── retries ───────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** Attempts in total, the first included. Default 4. */
  attempts?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Called before each retry with the error that caused it. */
  onRetry?: (err: FlashCallError, attempt: number) => void;
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
 * empty or non-JSON answer. A refused credential, a refused plan or an abort
 * is not retried. Throws the last {@link FlashCallError}.
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
      if (!last.retryable || attempt === attempts) throw last;
      options.onRetry?.(last, attempt);
      await sleep(backoffMs(last, attempt, options.random), request.signal);
    }
  }
  throw last ?? new FlashCallError("network", "no attempt was made");
}

// ── cost estimate ─────────────────────────────────────────────────────────

/** The rates and the arithmetic live in one place, `cost-rates.ts`. */
export { estimateUsd } from "./cost-rates";
