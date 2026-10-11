/**
 * THE SWAP — one Anthropic account for every Claude consumer on the box, and
 * everything moved together when it changes (TASK-1260).
 *
 * WHY. TASK-902 gave the box more than one Anthropic account, but only the
 * coding runner used them: the run that hit "You've hit your weekly limit"
 * moved on, while every other run on that account, the gateway's chat and its
 * scheduled tasks kept spending the account that had just run out — and the
 * next account sat idle until each of them failed on its own. Now the pool
 * records ONE active account (`activeId`, src/lib/anthropic-accounts.ts) and
 * every consumer re-reads it; this module is what happens when it moves.
 *
 * HOW. The pool settles the active account on every read and write and hands
 * each move to `onActiveChange`. Here a move becomes a SWAP EVENT, filed as the
 * pool's `lastSwap` before anything is done, then fanned out — one move at a
 * time, in order — to the registered consumers:
 *
 *   - `coding` (src/lib/coding-agent.ts): every live run, review pass and team
 *     worker on an account that can no longer answer is ended and resumed in
 *     its own session on the active account; runs waiting for a reset resume.
 *     Queued runs need nothing: each spawn asks the pool for the active account.
 *   - `gateway` (src/lib/anthropic-gateway.ts): the OpenClaw gateway's Claude
 *     subscription profile — every agent's, so every session, cron and
 *     heartbeat — is rewritten with the active account and the gateway is
 *     restarted on it.
 *
 * and then the turns that FAILED on the limit are retried once (`retries`): a
 * chat turn or a cron run a consumer reported with `reportAnthropicFailure`.
 * With no account left, nothing is retried and nothing resumes; the pool's
 * reset wake settles the active account again at the earliest reset, which is
 * a move like any other — and the held retries and the waiting runs go then.
 *
 * WHAT EACH CONSUMER DID is written back onto the event, so the owner's card
 * shows the last swap and its outcome in fixed words (`code`), never a
 * process's own text.
 *
 * ONE PER PROCESS. The queue, the consumers and the held retries live in the
 * process store (src/lib/process-store.ts): the boot hook's copy of this module
 * registers the consumers, a route's copy reports a failure, and both have to
 * be looking at the same queue.
 */

import crypto from "crypto";
import { DATA_DIR } from "@/lib/config-store";
import { processStore } from "@/lib/process-store";
import {
  SWAP_CONSUMERS,
  activeAccountSnapshot,
  markLimited,
  onActiveChange,
  probeAccountCredential,
  readPoolState,
  recordSwapEvent,
  updateSwapConsumer,
  type ActiveChange,
  type AnthropicAccount,
  type CredentialProbe,
  type PoolState,
  type SwapConsumerName,
  type SwapConsumerOutcome,
  type SwapEvent,
  type SwapSource,
} from "@/lib/anthropic-accounts";
import { classifyAnthropicFailure, limitUntil, type AnthropicLimitKind } from "@/lib/anthropic-limit";
import { announceAnthropicLimit } from "@/lib/coding-agent-notify";
import { verifyAnthropicKey } from "@/lib/coding-anthropic";

/** What a consumer is handed for one move. */
export interface SwapContext {
  change: ActiveChange;
  event: SwapEvent;
  /**
   * The move did not come from the pool but from a consumer's own failure on a
   * credential the pool does not hold (the gateway's own sign-in): only the
   * consumer that failed should act.
   */
  takeover: boolean;
}

export interface SwapConsumer {
  name: Exclude<SwapConsumerName, "retries">;
  apply(ctx: SwapContext): Promise<SwapConsumerOutcome>;
}

/** A turn that failed on the limit, to run again once — after the swap, on the new account. */
export interface RetryRequest {
  /** Stable for the failure it repeats: a second report of the same failure is not a second retry. */
  key: string;
  /** Which consumer has to have moved before the retry can work. */
  after: Exclude<SwapConsumerName, "retries">;
  /** Answers whether the retry was accepted. Never throws on purpose; a throw is "not accepted". */
  run: () => Promise<boolean>;
}

interface SwapRuntime {
  subscribed: boolean;
  consumers: Map<string, SwapConsumer>;
  /** The fan-out chain: every move after the previous one. */
  queue: Promise<void>;
  /** Moves emitted but not fanned out yet — so a caller can wait for a move it just caused. */
  inFlight: number;
  /** Retries held until a consumer has moved (or, with every account limited, until a reset). */
  pending: Map<string, RetryRequest & { queuedAt: number }>;
  /** Retries already spent, by key, so a failure is retried once. */
  retried: Map<string, number>;
  /**
   * A bare rate limit seen on an account (or the gateway's own sign-in,
   * `own`): when, and the turn it cut off. A second one inside the window is
   * the account's cap, not a throttle.
   */
  throttles: Map<string, { at: number; retry: RetryRequest | null }>;
  /** The throttled turns' delayed retries, so a reset can take them back. */
  timers: Set<ReturnType<typeof setTimeout>>;
}

function runtime(): SwapRuntime {
  return processStore<SwapRuntime>(`anthropic-swap:${DATA_DIR}`, () => ({
    subscribed: false,
    consumers: new Map(),
    queue: Promise.resolve(),
    inFlight: 0,
    pending: new Map(),
    retried: new Map(),
    throttles: new Map(),
    timers: new Set(),
  }));
}

/** How long one consumer may take — a gateway restart on a Jetson included. */
const CONSUMER_TIMEOUT_MS = 4 * 60_000;
/** A held retry older than this is a turn nobody is waiting for any more. */
const RETRY_HOLD_MS = 8 * 24 * 60 * 60_000;
/** How long "already retried" is remembered. */
const RETRIED_MEMORY_MS = 24 * 60 * 60_000;
/** How long a throttled turn waits before it is sent again, on the same account. */
const THROTTLE_RETRY_MS = 60_000;
/** A second bare rate limit on the same account within this is its cap, not a throttle. */
const THROTTLE_WINDOW_MS = 10 * 60_000;

// ── wiring ──────────────────────────────────────────────────────────────────

/** Listen to the pool. Idempotent, per process; every entry point calls it. */
export function startAnthropicSwap(): void {
  const state = runtime();
  if (state.subscribed) return;
  state.subscribed = true;
  onActiveChange((change) => enqueue(change, false));
}

/** Add (or replace) a consumer. Answers the way to take it off again. */
export function registerSwapConsumer(consumer: SwapConsumer): () => void {
  startAnthropicSwap();
  const { consumers } = runtime();
  consumers.set(consumer.name, consumer);
  return () => {
    if (consumers.get(consumer.name) === consumer) consumers.delete(consumer.name);
  };
}

/** Resolves once every move emitted so far has been fanned out. */
export async function whenSwapsSettled(): Promise<void> {
  // The pool emits on a microtask after its write: let one pass first.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) {
    const state = runtime();
    await state.queue;
    if (state.inFlight === 0) return;
  }
}

/**
 * Queue a fan-out. `record: false` is not a swap at all — the active account
 * did not move, a consumer only needs the credential it already follows put in
 * again (a renewed token) — so it files no event and sends no notice.
 */
function enqueue(change: ActiveChange, takeover: boolean, only?: ReadonlySet<string>, record = true): Promise<void> {
  const state = runtime();
  state.inFlight += 1;
  const next = state.queue.then(() => fanOut(change, takeover, only, record)).catch((err: unknown) => {
    console.error("[anthropic-swap] a swap could not be carried out:", err instanceof Error ? err.message : err);
  }).finally(() => {
    state.inFlight -= 1;
  });
  state.queue = next;
  return next;
}

// ── the fan-out ─────────────────────────────────────────────────────────────

function outcome(status: SwapConsumerOutcome["status"], code: string | null = null, count: number | null = null): SwapConsumerOutcome {
  return { status, code, count };
}

async function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function eventOf(change: ActiveChange, consumers: readonly string[]): SwapEvent {
  const pending: SwapEvent["consumers"] = {};
  for (const name of consumers) pending[name as Exclude<SwapConsumerName, "retries">] = outcome("pending");
  return {
    id: crypto.randomBytes(6).toString("hex"),
    at: change.at,
    fromId: change.fromId,
    fromLabel: change.fromLabel,
    toId: change.toId,
    toLabel: change.toLabel,
    cause: change.cause,
    source: change.source,
    limitKind: change.limitKind,
    limitedUntil: change.limitedUntil,
    nextResetAt: change.toId === null ? change.health.nextResetAt : null,
    consumers: pending,
  };
}

/**
 * The two notices a swap is worth, and only for a FAILURE (a limit, a refused
 * credential): "moved to the next account" and "no account left". A move the
 * owner made, a reset, a renewal — the box working as intended — say nothing.
 */
function announce(change: ActiveChange): void {
  if (change.cause !== "limit" && change.cause !== "auth") return;
  if (change.toId !== null) {
    void announceAnthropicLimit({
      kind: "switched",
      reason: change.cause,
      fromLabel: change.fromLabel ?? "Anthropic account",
      toLabel: change.toLabel ?? "Anthropic account",
      resetAt: change.cause === "limit" ? change.limitedUntil : null,
      runId: change.runId,
    }).catch(() => {});
    return;
  }
  void announceAnthropicLimit({ kind: "all_limited", resetAt: change.health.nextResetAt, runId: change.runId }).catch(() => {});
}

async function fanOut(change: ActiveChange, takeover: boolean, only?: ReadonlySet<string>, record = true): Promise<void> {
  const state = runtime();
  // A fixed order, whatever order they registered in: the runs first (they are
  // mid-turn and cost the owner most while they wait), then the gateway, whose
  // restart is the slow part.
  const consumers = [...state.consumers.values()]
    .filter((c) => !only || only.has(c.name))
    .sort((a, b) => SWAP_CONSUMERS.indexOf(a.name) - SWAP_CONSUMERS.indexOf(b.name));
  const event = eventOf(change, consumers.map((c) => c.name));
  if (record) {
    if (!takeover) announce(change);
    await recordSwapEvent(event).catch((err: unknown) => {
      console.error("[anthropic-swap] could not record the swap:", err instanceof Error ? err.message : err);
    });
    console.error(`[anthropic-swap] ${change.cause}: ${change.fromId ?? "none"} -> ${change.toId ?? "none (no account can answer)"} (${change.source})`);
  }

  const done = new Map<string, SwapConsumerOutcome>();
  for (const consumer of consumers) {
    // A newer move has already been decided: this one's target is history, and
    // acting on it would restart the gateway onto an account that is not the
    // active one any more. The newer move is queued behind this one.
    const current = activeAccountSnapshot()?.id ?? null;
    let result: SwapConsumerOutcome;
    if (!takeover && current !== change.toId) {
      result = outcome("skipped", "superseded");
    } else {
      try {
        result = await withTimeout(consumer.apply({ change, event, takeover }), CONSUMER_TIMEOUT_MS, outcome("failed", "timeout"));
      } catch (err) {
        console.error(`[anthropic-swap] the ${consumer.name} consumer failed:`, err instanceof Error ? err.message : err);
        result = outcome("failed", "error");
      }
    }
    done.set(consumer.name, result);
    if (record) await updateSwapConsumer(event.id, consumer.name, result).catch(() => {});
  }
  await drainRetries(record ? event.id : null, change.toId, done);
}

/**
 * Run the held retries whose consumer has moved: once each, after the swap.
 * With no account to move to they stay held — the reset wake is a move too.
 */
async function drainRetries(eventId: string | null, toId: string | null, done: ReadonlyMap<string, SwapConsumerOutcome>): Promise<void> {
  const state = runtime();
  const now = Date.now();
  for (const [key, task] of state.pending) {
    if (now - task.queuedAt > RETRY_HOLD_MS) state.pending.delete(key);
  }
  for (const [key, at] of state.retried) {
    if (now - at > RETRIED_MEMORY_MS) state.retried.delete(key);
  }
  if (state.pending.size === 0) return;
  const record = (result: SwapConsumerOutcome) => (eventId ? updateSwapConsumer(eventId, "retries", result).catch(() => {}) : Promise.resolve());
  if (toId === null) {
    await record(outcome("pending", "waiting_for_reset", state.pending.size));
    return;
  }
  let ran = 0;
  let accepted = 0;
  let unreachable = 0;
  for (const [key, task] of [...state.pending]) {
    const moved = done.get(task.after);
    if (!moved || moved.status !== "ok") {
      // The consumer it depends on could not follow the active account (an API
      // key the gateway cannot take, no OpenClaw on this edition): running it
      // again would fail the same way. Dropped, and counted as such.
      if (moved && moved.status !== "pending") {
        state.pending.delete(key);
        unreachable += 1;
      }
      continue;
    }
    state.pending.delete(key);
    state.retried.set(key, now);
    ran += 1;
    const ok = await task.run().catch(() => false);
    if (ok) accepted += 1;
  }
  if (ran === 0 && unreachable === 0) return;
  await record(ran === 0
    ? outcome("skipped", "consumer_not_moved", unreachable)
    : outcome(accepted > 0 ? "ok" : "failed", accepted === ran ? "retried" : "retry_failed", accepted));
}

// ── a consumer reporting its own failure ────────────────────────────────────

export interface FailureReport {
  /** The failure's own words — the head is read, never a transcript. */
  text: string | null;
  /** The gateway's failover reason for it, when it gave one. */
  reason?: string | null;
  source: Extract<SwapSource, "chat" | "cron">;
  /** The pool account the failing consumer was on, or null when it was on a credential the pool does not hold. */
  accountId: string | null;
  retry?: RetryRequest;
}

export interface FailureOutcome {
  /** Was it an Anthropic limit or a refused credential at all? */
  handled: boolean;
  /** `throttled`: a bare rate limit, sent again on the same account in a minute — not (yet) a limit. */
  kind: "limit" | "auth" | "throttled" | null;
  limitKind: AnthropicLimitKind | null;
  /**
   * The active account — answered only when the consumer that reported the
   * failure is ON it once handling is done (`answeredActive`). Null when it
   * could not follow, as well as when no account can answer.
   */
  activeId: string | null;
  activeLabel: string | null;
  allLimited: boolean;
  nextResetAt: number | null;
  /** `sent` — retried already; `held` — waits for a reset; `later` — sent again in a minute (a throttle); `none` — nothing to retry, or retried before. */
  retry: "sent" | "held" | "later" | "none";
}

/**
 * The account an answer may NAME: the active one, and only when the consumer
 * that reported the failure is on it. The chat turns a label into "ClawBox
 * moved everything that uses Claude to …, send it again" — and on 2026-10-10
 * said so 13 times over a pool whose only account was the Terminal's own
 * `claude` sign-in, which the gateway cannot carry (`not_transferable`):
 * nothing written, nothing restarted, the gateway on no pool account at all.
 *
 * The gateway's mirror is the box's own record of where it put the gateway,
 * and a `pending` one is a restart still owed, not a gateway on that account.
 * A consumer that leaves no such record is answered as before.
 */
function answeredActive(consumer: Exclude<SwapConsumerName, "retries">, pool: PoolState): AnthropicAccount | null {
  const mirror = pool.gateway;
  if (consumer === "gateway" && !(mirror && mirror.accountId === pool.activeId && !mirror.pending)) return null;
  return pool.accounts.find((a) => a.id === pool.activeId) ?? null;
}

/**
 * A consumer that is not the coding runner saw a turn fail — the chat, a cron
 * run. If it is an Anthropic limit or a refused credential: record it on the
 * account it was on, let the pool move the active account (which fans the swap
 * out), make sure the reporting consumer is on the active account even when
 * the pool had nothing to move, and retry the failed turn once.
 *
 * Resolves after the swap and the retry — a chat waiting on this can say what
 * happened. Never throws.
 */
export async function reportAnthropicFailure(report: FailureReport): Promise<FailureOutcome> {
  startAnthropicSwap();
  const now = Date.now();
  // The gateway does not back off and retry a 429 the way Claude Code does:
  // a bare one may be a throttle that is over in seconds (`transientRate`).
  const classified = classifyAnthropicFailure(report.text, now, { reason: report.reason, transientRate: true });
  const empty: FailureOutcome = { handled: false, kind: null, limitKind: null, activeId: null, activeLabel: null, allLimited: false, nextResetAt: null, retry: "none" };
  if (!classified) return empty;
  // Who saw it fail: the consumer a retry names, else the gateway — the chat
  // and the crons are its turns.
  const consumer = report.retry?.after ?? "gateway";
  const state = runtime();
  for (const [who, seen] of state.throttles) {
    if (now - seen.at > THROTTLE_WINDOW_MS) state.throttles.delete(who);
  }

  // A THROTTLE: the account stays, nothing moves, and the turn is sent again
  // once, on the same account, a minute from now. The same account throttled
  // again inside the window — the retry itself refused, typically — is its
  // cap after all, and goes the limit's way below, with the first turn.
  let failure: Exclude<typeof classified, { type: "throttled" }>;
  let retryRequest = report.retry ?? null;
  if (classified.type === "throttled") {
    const who = report.accountId ?? "own";
    const seen = state.throttles.get(who);
    if (!seen) {
      state.throttles.set(who, { at: now, retry: report.retry ?? null });
      let retry: FailureOutcome["retry"] = "none";
      if (report.retry) {
        const key = `${report.retry.key}:throttle`;
        if (!state.retried.has(key)) {
          state.retried.set(key, now);
          const run = report.retry.run;
          const timer = setTimeout(() => {
            state.timers.delete(timer);
            void run().catch(() => false);
          }, THROTTLE_RETRY_MS);
          timer.unref?.();
          state.timers.add(timer);
          retry = "later";
        }
      }
      const pool = await readPoolState().catch(() => null);
      const active = pool ? answeredActive(consumer, pool) : null;
      console.error(`[anthropic-swap] ${report.source}: a bare rate limit on ${report.accountId ?? "the gateway's own sign-in"} — sent again in a minute, not taken out`);
      return {
        handled: true, kind: "throttled", limitKind: null,
        activeId: active?.id ?? null, activeLabel: active?.label ?? null,
        allLimited: pool?.health.allLimited ?? false, nextResetAt: null, retry,
      };
    }
    state.throttles.delete(who);
    retryRequest = report.retry ?? seen.retry;
    failure = { type: "limit", limit: { kind: "rate", resetsAt: null } };
  } else {
    failure = classified;
  }

  let retry: FailureOutcome["retry"] = "none";
  if (retryRequest && !state.retried.has(retryRequest.key) && !state.pending.has(retryRequest.key)) {
    state.pending.set(retryRequest.key, { ...retryRequest, queuedAt: now });
    retry = "held";
  }

  try {
    const before = await readPoolState();
    const known = report.accountId !== null && before.accounts.some((a) => a.id === report.accountId);
    let probe: CredentialProbe | null = null;
    if (known && report.accountId) {
      if (failure.type === "limit") {
        await markLimited(report.accountId, limitUntil(failure.limit, now), failure.limit.kind, { source: report.source });
      } else {
        // Confirmed first: a token the pool can still renew was only stale
        // where it was used, and the account stays in.
        probe = await probeAccountCredential(report.accountId, verifyAnthropicKey, { source: report.source });
      }
    }
    await whenSwapsSettled();

    // The pool may have had nothing to move — the account was already known
    // to be out (another consumer got there first), or the failing credential
    // was not one of the pool's — while the consumer that failed is still on
    // it. Move THAT consumer onto the active account. When the pool DID move,
    // its swap has already taken every consumer along (and run the retries):
    // a second, narrower swap would only overwrite the one the owner should see.
    const after = await readPoolState();
    const poolMoved = (after.lastSwap?.id ?? null) !== (before.lastSwap?.id ?? null);
    const onActive = consumer === "gateway" ? after.gateway?.accountId === after.activeId && after.gateway !== null : true;
    if (poolMoved) {
      // Done: the fan-out ran the held retry, or dropped it, or holds it for the reset.
    } else if (after.activeId && !onActive && state.consumers.has(consumer)) {
      const active = after.accounts.find((a) => a.id === after.activeId) ?? null;
      await enqueue({
        fromId: known ? report.accountId : null,
        fromLabel: known ? before.accounts.find((a) => a.id === report.accountId)?.label ?? null : null,
        toId: after.activeId,
        toLabel: active?.label ?? null,
        cause: failure.type,
        source: report.source,
        runId: null,
        limitKind: failure.type === "limit" ? failure.limit.kind : null,
        limitedUntil: failure.type === "limit" ? limitUntil(failure.limit, now) : null,
        health: after.health,
        at: Date.now(),
      }, true, new Set([consumer]));
    } else if (probe === "ok" && consumer === "gateway" && after.activeId && state.consumers.has("gateway")) {
      // Renewed, not refused: the pool now holds a fresh token, the gateway
      // still holds the one Anthropic just turned away. Put the renewal in
      // (and restart onto it) BEFORE the retry, or it fails the same way — and
      // it is not a swap, so nothing is filed or announced.
      const active = after.accounts.find((a) => a.id === after.activeId) ?? null;
      await enqueue({
        fromId: after.activeId, fromLabel: active?.label ?? null, toId: after.activeId, toLabel: active?.label ?? null,
        cause: "auth", source: report.source, runId: null, limitKind: null, limitedUntil: null, health: after.health, at: Date.now(),
      }, true, new Set(["gateway"]), false);
    } else if (after.activeId && onActive && state.pending.size > 0) {
      // Nothing to move and the consumer is already on the active account (a
      // swap another report caused has landed): the held retries can go, and
      // are counted on that swap.
      await drainRetries(after.lastSwap?.id ?? null, after.activeId, new Map([[consumer, outcome("ok")]]));
    }

    const final = await readPoolState();
    const active = answeredActive(consumer, final);
    if (retryRequest && retry === "held" && state.retried.has(retryRequest.key)) retry = "sent";
    else if (retryRequest && retry === "held" && !state.pending.has(retryRequest.key)) retry = "none";
    return {
      handled: true,
      kind: failure.type,
      limitKind: failure.type === "limit" ? failure.limit.kind : null,
      activeId: active?.id ?? null,
      activeLabel: active?.label ?? null,
      allLimited: final.health.allLimited,
      nextResetAt: final.health.allLimited ? final.health.nextResetAt : null,
      retry,
    };
  } catch (err) {
    console.error("[anthropic-swap] a reported failure could not be acted on:", err instanceof Error ? err.message : err);
    return { ...empty, handled: true, kind: failure.type, limitKind: failure.type === "limit" ? failure.limit.kind : null, retry };
  }
}

/** Test seam: forget the consumers, the queue and the held retries. */
export function _resetAnthropicSwapForTests(): void {
  const state = runtime();
  state.subscribed = false;
  state.consumers.clear();
  state.queue = Promise.resolve();
  state.inFlight = 0;
  state.pending.clear();
  state.retried.clear();
  state.throttles.clear();
  for (const timer of state.timers) clearTimeout(timer);
  state.timers.clear();
}
