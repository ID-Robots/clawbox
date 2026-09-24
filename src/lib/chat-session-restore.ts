// Bringing an existing conversation back, with an end (TASK-1158).
//
// "Restore" is what the chat does every time it picks a conversation up again:
// after a gateway restart drops the socket, after a reload, and when the owner
// returns to a tab. It is two waits — the socket's handshake, then the
// conversation's history — and neither of them used to have an end.
//
// Seen on a box (2026-09-24): the gateway held one conversation's `chat.send`
// for 40 minutes and six `sessions.patch` calls for 35–40 minutes in its
// session lifecycle queue, behind a cron run that only let go at its own
// one-hour timeout; the same gateway had answered `chat.history` 45 times that
// week with the retryable `UNAVAILABLE: session history is rebuilding; retry
// shortly`. The chat, for its part, gave a reconnect no deadline once it had
// connected once, gave the connect frame no timeout at all, and logged a failed
// history read to the console — so a restore could spin behind "Restarting
// chat…" or sit on an empty conversation with nothing to press.
//
// Everything here is pure and clock-injectable so the rules are unit-tested
// without rendering the chat; the component only wires them in.

import { HarnessError } from "@/lib/harness/transport";
import { isGatewayStartingRefusal, type GatewayRefusal } from "@/lib/chat-gateway-starting";

/**
 * The longest one gateway RPC may go unanswered before the chat gives up on it.
 *
 * Unchanged from the literal it replaces: the gateway's main loop blocks for
 * tens of seconds while an agent starts (the worst stall observed was ~81 s),
 * and a `chat.send` ack must outlast that. Named so a test can shorten it.
 */
export const GATEWAY_REQUEST_TIMEOUT_MS = 120_000;

/**
 * One socket attempt, from `new WebSocket` to the gateway's `hello`.
 *
 * A gateway that is starting answers the connect frame at once — with a hello,
 * or with its retryable `startup-sidecars` refusal — so a handshake still open
 * after this long is a socket nobody is answering (a wedged or swapping
 * gateway, an upgrade the proxy accepted and the gateway never finished). It is
 * closed and the ordinary retry ladder takes over, rather than waiting forever
 * on the one attempt.
 */
export const RESTORE_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * The whole of one reconnect, however many attempts it takes.
 *
 * The same five minutes the FIRST connection has always had (a measured Jetson
 * cold boot is ~175 s before the gateway listens). It used to apply to that
 * first connection only, so a restore after a gateway bounce had no end at all.
 */
export const RECONNECT_DEADLINE_MS = 5 * 60_000;

/** One read of a conversation's history. */
export const HISTORY_ATTEMPT_TIMEOUT_MS = 30_000;

/** Every read of one restore together, retries and waits included. */
export const HISTORY_RESTORE_DEADLINE_MS = 90_000;

/** The waits between history reads; the last one repeats until the deadline. */
export const HISTORY_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 15_000];

/** Why a restore ended without the conversation. */
export type RestoreFailureKind =
  /** The gateway kept saying "not yet" (rebuilding, restarting) past the deadline. */
  | "busy"
  /** The gateway did not answer at all. */
  | "timeout"
  /** The gateway refused in a way that will not change by waiting. */
  | "failed";

/** A restore that has run out of attempts or time. `cause` is the last error. */
export class SessionRestoreError extends Error {
  constructor(
    readonly kind: RestoreFailureKind,
    readonly attempts: number,
    readonly cause?: unknown,
  ) {
    super(`conversation restore ${kind} after ${attempts} attempt${attempts === 1 ? "" : "s"}`);
    this.name = "SessionRestoreError";
  }
}

/** The fields a refusal may carry, on the error itself or on what it wraps. */
function refusalChain(err: unknown): GatewayRefusal[] {
  const chain: GatewayRefusal[] = [];
  let current: unknown = err;
  // A HarnessError wraps the gateway's own rejection as `cause`; three levels
  // is more than any adapter nests, and the bound keeps a cyclic cause finite.
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
    chain.push(current as GatewayRefusal);
    current = (current as { cause?: unknown }).cause;
  }
  if (typeof err === "string") chain.push({ message: err });
  return chain;
}

/**
 * Is this a "not yet" — a refusal that waiting will change?
 *
 * Judged on the gateway's protocol first: `UNAVAILABLE` with `retryable: true`
 * is its own word for it, and `retryable: false` is its word for the opposite
 * (a build mismatch also answers `UNAVAILABLE`, and retrying that is a loop).
 * The prose is the fallback, for a frame that carries no flag, and it is
 * anchored on the sentences the gateway actually sends — "session history is
 * rebuilding; retry shortly", "chat.history unavailable during gateway
 * restart" — never on a bare "unavailable".
 */
export function isRetryableRestoreRefusal(err: unknown): boolean {
  for (const refusal of refusalChain(err)) {
    if (isGatewayStartingRefusal(refusal)) return true;
    if (refusal.code === "UNAVAILABLE" && refusal.retryable === true) return true;
    if (refusal.retryable === false) return false;
    const message = typeof refusal.message === "string" ? refusal.message : "";
    if (/\bhistory is rebuilding\b|\bunavailable during gateway restart\b|\bretry shortly\b/i.test(message)) return true;
  }
  return false;
}

/** Did the gateway simply not answer? Our own attempt timer, or the RPC's. */
export function isRestoreTimeout(err: unknown): boolean {
  for (const refusal of refusalChain(err)) {
    if (refusal instanceof HarnessError && refusal.code === "timeout") return true;
    if (/\b(?:request )?timeout\b|\btimed out\b/i.test(typeof refusal.message === "string" ? refusal.message : "")) return true;
  }
  return false;
}

/** Was the restore called off (a tab switch, a new socket, the owner leaving)? */
export function isRestoreAborted(err: unknown): boolean {
  if (err instanceof HarnessError) return err.code === "aborted";
  return err instanceof Error && err.name === "AbortError";
}

/** The kind a single error, read on its own, ends a restore as. */
export function classifyRestoreFailure(err: unknown): RestoreFailureKind {
  if (err instanceof SessionRestoreError) return err.kind;
  if (isRetryableRestoreRefusal(err)) return "busy";
  if (isRestoreTimeout(err)) return "timeout";
  return "failed";
}

function abortedError(): HarnessError {
  return new HarnessError("aborted", "Restore called off.");
}

/** Wait `ms`, or reject the moment `signal` fires. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortedError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortedError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** `work`, but no longer than `ms` and no longer than `signal` allows. */
function bounded<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(abortedError()));
    const timer = setTimeout(
      () => finish(() => reject(new HarnessError("timeout", "Restore attempt timed out"))),
      Math.max(1, ms),
    );
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (err: unknown) => finish(() => reject(err)),
    );
  });
}

export interface RestoreOptions {
  signal?: AbortSignal;
  attemptTimeoutMs?: number;
  deadlineMs?: number;
  delaysMs?: readonly number[];
  /** Called before each wait; `attempt` is the one that just failed (1-based). */
  onRetry?: (info: { attempt: number; delayMs: number; kind: RestoreFailureKind }) => void;
  /** Injected for tests; `Date.now` otherwise. */
  now?: () => number;
  /** Injected for tests; a real timer otherwise. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Run `attempt` until it answers, the deadline passes, or it fails in a way
 * waiting will not fix.
 *
 * Retried: a "not yet" refusal (see `isRetryableRestoreRefusal`) and an attempt
 * that got no answer. Not retried: anything else — an unknown session, a denied
 * scope — which ends the restore at once as `failed`. Every attempt is cut off
 * at `attemptTimeoutMs` and never runs past the deadline, so the whole restore
 * ends within `deadlineMs` (plus one timer tick) whatever the gateway does.
 *
 * Rejects with a `SessionRestoreError` naming the kind, or with an `aborted`
 * HarnessError when `signal` fires — which the caller treats as "someone else
 * owns this conversation now", not as a failure to show.
 */
export async function restoreWithRetry<T>(attempt: () => Promise<T>, opts: RestoreOptions = {}): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const delays = opts.delaysMs && opts.delaysMs.length > 0 ? opts.delaysMs : HISTORY_RETRY_DELAYS_MS;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? HISTORY_ATTEMPT_TIMEOUT_MS;
  const deadlineMs = opts.deadlineMs ?? HISTORY_RESTORE_DEADLINE_MS;
  const started = now();
  let attempts = 0;
  for (;;) {
    if (opts.signal?.aborted) throw abortedError();
    const remaining = deadlineMs - (now() - started);
    attempts++;
    try {
      return await bounded(attempt(), Math.min(attemptTimeoutMs, remaining), opts.signal);
    } catch (err) {
      if (opts.signal?.aborted || isRestoreAborted(err)) throw abortedError();
      const kind = classifyRestoreFailure(err);
      if (kind === "failed") throw new SessionRestoreError("failed", attempts, err);
      const delayMs = delays[Math.min(attempts - 1, delays.length - 1)];
      // Another attempt only when it can still start AND get a real answer
      // before the deadline — a retry squeezed into the last few milliseconds
      // would only report the same failure a moment later.
      if (now() - started + delayMs >= deadlineMs) throw new SessionRestoreError(kind, attempts, err);
      opts.onRetry?.({ attempt: attempts, delayMs, kind });
      await sleep(delayMs, opts.signal);
    }
  }
}
