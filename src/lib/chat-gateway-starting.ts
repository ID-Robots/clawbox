// A connect the gateway refuses only because it is still booting, and the
// ladder both chat surfaces climb through it — and, past the connect, a call
// it refuses only because the AGENT behind it is still starting, with the
// bounded wait the chat's own on-load calls go through for that.
//
// Extracted from ChatPopup for the reason chat-reasoning.ts was ("so the gating
// is unit-testable without rendering the whole chat component") and for the
// repo's own "minimise JavaScript bundle size" rule: ChatApp — the full page at
// `/app/clawbox`, which is what a phone lands on — imported this predicate from
// ChatPopup and so dragged the mascot chat's entire import graph (chat cards,
// email batch, approvals, speech, tool events) into that route's chunk. The
// predicate is pure and has always had tests that need no component.

/**
 * The gateway's `details.reason` for a connect refused only because its startup
 * sidecars are still coming up (`GATEWAY_STARTUP_UNAVAILABLE_REASON` in the
 * core's `packages/gateway-protocol/src/startup-unavailable.ts`, v2026.9.3).
 */
const GATEWAY_STARTUP_UNAVAILABLE_REASON = "startup-sidecars";

/**
 * The full page's ladder, in the mascot chat's units: a restart is ten to
 * twenty seconds, so forty tries three seconds apart outlasts a slow one and
 * still ends.
 */
export const STARTING_RETRY_DELAY_MS = 3000;
export const STARTING_MAX_RETRIES = 40;

/** The fields of an `error` frame a client keeps, so a refusal can be judged on
 *  the gateway's own protocol rather than on its English. */
export interface GatewayRefusal {
  message?: string;
  code?: string;
  retryable?: boolean;
  details?: unknown;
}

/**
 * Build the rejection for an `ok: false` frame, carrying the structured fields
 * rather than dropping them for the message alone.
 */
export function gatewayFrameError(error: Record<string, unknown> | undefined): Error & GatewayRefusal {
  const err = new Error((error?.message as string) || "Request failed") as Error & GatewayRefusal;
  if (typeof error?.code === "string") err.code = error.code;
  if (typeof error?.retryable === "boolean") err.retryable = error.retryable;
  if (error && "details" in error) err.details = error.details;
  return err;
}

/**
 * Is this a connect the gateway refuses ONLY because it is not finished booting?
 *
 * The core answers that question in its own protocol, and this is its predicate
 * (`isRetryableGatewayStartupUnavailableError`, same file as the reason above):
 * `code === "UNAVAILABLE"` AND `retryable === true` AND
 * `details.reason === "startup-sidecars"`. All three are needed — the gateway
 * sends `UNAVAILABLE` for a Control-UI build mismatch (`retryable: false`) and
 * for an unsupported socket receiver too, and retrying either is a loop.
 *
 * The prose test is the FALLBACK, for a gateway too old to send a code (and
 * only then): it reads the sentence this build sends verbatim, "gateway
 * starting; retry shortly". It is anchored on that wording rather than on a
 * bare `starting`/`not ready`, because an unanchored match silently retries a
 * refusal that will never change — which is the failure the structured test
 * above exists to remove.
 */
export function isGatewayStartingRefusal(refusal: GatewayRefusal | string | undefined): boolean {
  const err: GatewayRefusal = typeof refusal === "string" ? { message: refusal } : refusal ?? {};
  const reason = (err.details as { reason?: unknown } | undefined)?.reason;
  if (typeof err.code === "string") {
    return err.code === "UNAVAILABLE"
      && err.retryable === true
      && reason === GATEWAY_STARTUP_UNAVAILABLE_REASON;
  }
  return /\bgateway (is )?starting\b|\bretry shortly\b|\bstartup (is )?pending\b/i.test(err.message ?? "");
}

/**
 * The code the core gives an agent whose database is still being inspected and
 * prepared after a start (`agent-database-inspection-pending`, reported under
 * `agentDatabases` on its health routes — docs `gateway/health`, v2026.10.7),
 * and the preparation half alongside it.
 */
const AGENT_STARTUP_PENDING_CODE = /^agent-database-(?:inspection|preparation)-pending$/;

/**
 * The sentence the core puts on a call it refuses for that reason, e.g.
 * "Agent main has not completed startup inspection and preparation … run
 * `openclaw doctor --fix`". Anchored on "has not completed", so an inspection
 * that FAILED — a refusal waiting will not change — is not read as one still
 * running.
 */
const AGENT_STARTUP_PENDING_TEXT = /\bhas not (?:yet )?completed (?:its )?startup inspection\b/i;

/** The fields one link of a rejection may carry, on itself or on its `details`. */
function refusalLinks(err: unknown): GatewayRefusal[] {
  if (typeof err === "string") return [{ message: err }];
  const links: GatewayRefusal[] = [];
  let current: unknown = err;
  // The harness adapter wraps the gateway's rejection as `cause`; four levels
  // is more than any caller nests, and the bound keeps a cyclic cause finite.
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    links.push(current as GatewayRefusal);
    current = (current as { cause?: unknown }).cause;
  }
  return links;
}

function isAgentStartupPending(refusal: GatewayRefusal): boolean {
  const details = refusal.details as { code?: unknown; reason?: unknown } | null | undefined;
  const codes = [refusal.code, details?.code, details?.reason];
  if (codes.some((code) => typeof code === "string" && AGENT_STARTUP_PENDING_CODE.test(code))) return true;
  return typeof refusal.message === "string" && AGENT_STARTUP_PENDING_TEXT.test(refusal.message);
}

/**
 * Was this call refused only because the gateway, or the agent behind it, has
 * not finished starting?
 *
 * Right after a restart the socket is back before the agent is: the gateway
 * answers its hello and serves healthy agents while each agent's database is
 * still inspected and prepared, and a call for one of those agents is refused
 * with the core's "has not completed startup inspection and preparation" (which
 * ends by suggesting `openclaw doctor --fix` — advice for a refusal that does
 * not clear, not for the few seconds every restart passes through). The
 * gateway's own startup refusal counts too: same state, one step earlier.
 *
 * Walks `cause`, because the harness adapter wraps the frame's rejection.
 * `retryable: false` is deliberately not a veto here: the code and the
 * sentence both say "still running", and the wait that acts on this answer is
 * bounded, so a refusal that never clears still ends — quietly, and once.
 */
export function isAgentStartingRefusal(err: unknown): boolean {
  return refusalLinks(err).some((link) => isAgentStartupPending(link) || isGatewayStartingRefusal(link));
}

/**
 * The waits between tries while the agent starts; the last one repeats. A
 * restart's agent is usually ready within seconds, so the first try back is
 * soon, and a slow one is not asked every second for two minutes.
 */
export const AGENT_STARTING_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000];

/**
 * How long a call waits for a starting agent before it says so. A measured
 * restart is ten to twenty seconds; two minutes outlasts a slow one on a busy
 * box and still ends.
 */
export const AGENT_STARTING_DEADLINE_MS = 120_000;

/** A call that was still refused as "starting" when its wait ran out. `cause` is the last refusal. */
export class AgentStartingTimeoutError extends Error {
  constructor(
    readonly attempts: number,
    readonly cause?: unknown,
  ) {
    super(`still starting after ${attempts} attempt${attempts === 1 ? "" : "s"}`);
    this.name = "AgentStartingTimeoutError";
  }
}

function abortError(): Error {
  const err = new Error("Called off.");
  err.name = "AbortError";
  return err;
}

/** Wait `ms`, or reject the moment `signal` fires. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface AgentStartingRetryOptions {
  /** Ends the wait (rejecting with an `AbortError`) — a newer call, a new socket, an unmount. */
  signal?: AbortSignal;
  delaysMs?: readonly number[];
  deadlineMs?: number;
  /** Called before each wait; `attempt` is the one just refused (1-based). */
  onWaiting?: (info: { attempt: number; delayMs: number }) => void;
  /** Injected for tests; `Date.now` otherwise. */
  now?: () => number;
  /** Injected for tests; a real timer otherwise. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Run `attempt` until it answers, retrying only while the agent is starting.
 *
 * Any other failure is the caller's, at once and unchanged — a wait cannot fix
 * it and the caller already knows what to say about it. A refusal still
 * "starting" when the next wait would cross `deadlineMs` ends as an
 * `AgentStartingTimeoutError` carrying it; `signal` ends the wait as an
 * `AbortError`, which is nobody's failure to show.
 */
export async function retryWhileAgentStarting<T>(
  attempt: () => Promise<T>,
  opts: AgentStartingRetryOptions = {},
): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const delays = opts.delaysMs && opts.delaysMs.length > 0 ? opts.delaysMs : AGENT_STARTING_RETRY_DELAYS_MS;
  const deadlineMs = opts.deadlineMs ?? AGENT_STARTING_DEADLINE_MS;
  const started = now();
  for (let attempts = 1; ; attempts++) {
    if (opts.signal?.aborted) throw abortError();
    try {
      return await attempt();
    } catch (err) {
      if (opts.signal?.aborted) throw abortError();
      if (!isAgentStartingRefusal(err)) throw err;
      const delayMs = delays[Math.min(attempts - 1, delays.length - 1)];
      if (now() - started + delayMs > deadlineMs) throw new AgentStartingTimeoutError(attempts, err);
      opts.onWaiting?.({ attempt: attempts, delayMs });
      await sleep(delayMs, opts.signal);
    }
  }
}
