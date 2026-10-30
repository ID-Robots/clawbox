/**
 * The update's busy gate (issue #1269): what agent work an update would cut
 * short, and the bounded waits that let it finish before the gateway stops.
 *
 * Pure — no gateway socket, no coding-agent store — so the update screens can
 * import the types and the flag, and the waits can be driven by a fake clock
 * in tests. `update-busy-server.ts` supplies the real reads.
 *
 * WHY. Every gateway stop the update makes used to come with no look at what
 * was running: a box whose core was already at the pin still lost two long
 * agent runs to the drain-then-SIGKILL of its stop. Two layers stand between
 * an update and that now:
 *
 *  1. THE BUSY WAIT — before the stop, the runner waits (bounded,
 *     `CLAWBOX_UPDATE_BUSY_WAIT_MS`, 15 min by default) for the work ClawBox
 *     can see to finish: sessions with a run in flight, sub-agent and ACP runs,
 *     and coding-agent runs. Admission stays open, so the owner keeps chatting.
 *  2. THE DRAIN — then OpenClaw's own active-work fence, the deferral that
 *     `openclaw gateway restart --safe` waits on, asked for as a STOP: the
 *     gateway closes admission to new work and reports when what it already
 *     admitted has settled, bounded like `--safe` (5 min). Only then is the
 *     gateway stopped, with nothing left for the stop to cancel.
 *
 * "Update anyway" (`ignoreBusy`) skips both: the stop is the plain one it
 * always was.
 */

/** The request-body flag on `update/run` that is the owner's "Update anyway". */
export const UPDATE_IGNORE_BUSY_FLAG = "ignoreBusy";

/** The busy wait's default bound: 15 minutes. */
export const UPDATE_BUSY_WAIT_DEFAULT_MS = 900_000;

/**
 * The drain's bound, OpenClaw's own: `gateway restart --safe` waits at most
 * five minutes for active work before it forces the restart.
 */
export const GATEWAY_DRAIN_MAX_MS = 300_000;

/** What an update would cut short, by kind. */
export interface AgentWorkCounts {
  /** Gateway sessions with a run of their own in flight (`hasActiveRun`). */
  agentRuns: number;
  /** Sub-agent and ACP sessions with a run in flight: the sub-agent registry as `sessions.list` projects it. */
  subagentRuns: number;
  /** Coding-agent runs (`runningCount()`). */
  codingRuns: number;
  total: number;
}

/** What the update screens are told while the runner holds the stop back. */
export interface UpdateBusyWait {
  /** `waiting`: the busy wait (admission open); `draining`: the gateway's own fence (admission closed). */
  phase: "waiting" | "draining";
  /** How many runs are still active. */
  active: number;
  /** The breakdown, while waiting; the gateway reports one total while draining. */
  counts?: AgentWorkCounts;
  startedAt: number;
  /** When the wait gives up and the update stops the gateway anyway. */
  until: number;
}

export const NO_AGENT_WORK: AgentWorkCounts = { agentRuns: 0, subagentRuns: 0, codingRuns: 0, total: 0 };

/**
 * `CLAWBOX_UPDATE_BUSY_WAIT_MS`: a whole number of milliseconds, 0 for "do not
 * wait". Anything else is the default — a typo must not turn the gate off.
 */
export function updateBusyWaitMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CLAWBOX_UPDATE_BUSY_WAIT_MS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return UPDATE_BUSY_WAIT_DEFAULT_MS;
  const ms = Number(raw);
  return Number.isSafeInteger(ms) ? ms : UPDATE_BUSY_WAIT_DEFAULT_MS;
}

/** `agent:<agentId>:subagent:<uuid>` and `agent:<agentId>:acp:<uuid>`, the core's spawned-run keys. */
const SPAWNED_SESSION_KEY = /^agent:[^:]+:(?:subagent|acp):/;

/**
 * The active runs in a `sessions.list` answer.
 *
 * `hasActiveRun` is the core's authoritative per-session fact. A spawned
 * session (sub-agent or ACP) counts as a sub-agent run; a parent row that says
 * `hasActiveSubagentRun` is a floor for those, in case the child's own row is
 * not in the page. Anything that is not a list of rows counts nothing.
 */
export function countActiveSessions(payload: unknown): Pick<AgentWorkCounts, "agentRuns" | "subagentRuns"> {
  const sessions = (payload as { sessions?: unknown } | null | undefined)?.sessions;
  if (!Array.isArray(sessions)) return { agentRuns: 0, subagentRuns: 0 };
  let agentRuns = 0;
  let spawnedRows = 0;
  let parentsWithSpawned = 0;
  for (const row of sessions) {
    if (!row || typeof row !== "object") continue;
    const { key, hasActiveRun, hasActiveSubagentRun } = row as Record<string, unknown>;
    const spawned = typeof key === "string" && SPAWNED_SESSION_KEY.test(key);
    if (hasActiveRun === true) {
      if (spawned) spawnedRows++;
      else agentRuns++;
    }
    if (!spawned && hasActiveSubagentRun === true) parentsWithSpawned++;
  }
  return { agentRuns, subagentRuns: Math.max(spawnedRows, parentsWithSpawned) };
}

export function withTotal(counts: Omit<AgentWorkCounts, "total">): AgentWorkCounts {
  return { ...counts, total: counts.agentRuns + counts.subagentRuns + counts.codingRuns };
}

/** "1 agent run" / "3 agent runs" — the runner's log and step detail, in English. */
export function describeAgentRuns(n: number): string {
  return `${n} agent run${n === 1 ? "" : "s"}`;
}

/** One line for the log: the total and what it is made of. */
export function describeAgentWork(counts: AgentWorkCounts): string {
  const parts = [
    counts.agentRuns ? `${counts.agentRuns} chat/agent` : "",
    counts.subagentRuns ? `${counts.subagentRuns} sub-agent` : "",
    counts.codingRuns ? `${counts.codingRuns} coding-agent` : "",
  ].filter(Boolean);
  return `${describeAgentRuns(counts.total)}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

interface Clock {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type BusyWaitOutcome =
  | { kind: "idle"; waitedMs: number }
  /** The owner chose "Update anyway" while it waited. */
  | { kind: "released"; counts: AgentWorkCounts; waitedMs: number }
  /** The bound ran out with work still active: the update goes ahead anyway. */
  | { kind: "expired"; counts: AgentWorkCounts; waitedMs: number };

export interface BusyWaitOptions extends Clock {
  maxMs: number;
  read: () => Promise<AgentWorkCounts>;
  /** True once the owner has chosen "Update anyway". */
  released?: () => boolean;
  /** Called on every round that still finds work. */
  onWaiting?: (counts: AgentWorkCounts, waitedMs: number) => void;
  pollMs?: number;
}

/**
 * Wait until no agent work is active, the owner releases the wait, or `maxMs`
 * has passed. Asked first without waiting, so an idle box costs one read.
 */
export async function waitForAgentWork(options: BusyWaitOptions): Promise<BusyWaitOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const pollMs = options.pollMs ?? 10_000;
  const startedAt = now();
  for (;;) {
    const counts = await options.read();
    const waitedMs = now() - startedAt;
    if (counts.total === 0) return { kind: "idle", waitedMs };
    if (options.released?.()) return { kind: "released", counts, waitedMs };
    if (waitedMs >= options.maxMs) return { kind: "expired", counts, waitedMs };
    options.onWaiting?.(counts, waitedMs);
    await sleepUnlessReleased(Math.min(pollMs, options.maxMs - waitedMs), sleep, options.released);
  }
}

/** Sleep in short slices so "Update anyway" is answered within a second or two. */
async function sleepUnlessReleased(ms: number, sleep: (ms: number) => Promise<void>, released?: () => boolean): Promise<void> {
  let left = Math.max(0, ms);
  while (left > 0) {
    if (released?.()) return;
    const slice = Math.min(left, 1_000);
    await sleep(slice);
    left -= slice;
  }
}

/** One gateway RPC; throws when the gateway does not answer or refuses. */
export type GatewayCall = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export type DrainOutcome =
  /** Everything admitted has settled; admission is closed until the lease is resumed or the gateway exits. */
  | { kind: "ready"; suspensionId: string; waitedMs: number }
  /** The owner chose "Update anyway" mid-drain. The lease is still held. */
  | { kind: "released"; suspensionId: string; active: number; waitedMs: number }
  /** The bound ran out with work still active. The lease is still held. */
  | { kind: "expired"; suspensionId: string; active: number; waitedMs: number }
  /** No drain: the gateway did not answer, refused, or is a core without drain mode. Nothing is held. */
  | { kind: "unavailable"; reason: string };

export interface DrainOptions extends Clock {
  call: GatewayCall;
  /** Stable for this one stop; the core renews a lease only for the same id. */
  requestId: string;
  maxMs: number;
  released?: () => boolean;
  onDraining?: (active: number, waitedMs: number) => void;
}

/** Renew a draining lease once less than this is left of its two minutes. */
const LEASE_RENEW_MARGIN_MS = 45_000;

/**
 * Transport failures in a row (a timeout, a dropped socket) a held drain rides
 * out before it decides the gateway has gone. One slow or lost answer is not a
 * gateway that exited, and ending the drain on it stops the gateway mid-drain.
 */
const DRAIN_TRANSPORT_FAILURES_TOLERATED = 3;

function drainState(answer: Record<string, unknown>): { status: string; suspensionId: string | null; active: number; retryAfterMs: number; expiresAtMs: number | null } {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    status: typeof answer.status === "string" ? answer.status : "",
    suspensionId: typeof answer.suspensionId === "string" && answer.suspensionId ? answer.suspensionId : null,
    active: Math.max(0, num(answer.activeCount) ?? 0),
    retryAfterMs: num(answer.retryAfterMs) ?? 5_000,
    expiresAtMs: num(answer.expiresAtMs),
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Drain the gateway for a stop, through the core's cooperative-suspension
 * fence in drain mode (`gateway.suspend.prepare` with `drain: true` and
 * `terminalPolicy: "terminate"`, the documented form for a release update):
 * admission closes, what was admitted keeps running, and the lease turns
 * `ready` once it has all settled. Polled with `gateway.suspend.status` at the
 * pace the core asks for, renewed with the same request before its two minutes
 * run out, and bounded by `maxMs`.
 *
 * Never throws. A gateway that does not answer, a core that answers `busy`
 * (refuse-only: no drain mode, nothing held) or any refusal is `unavailable`,
 * and the caller stops the gateway exactly as it did before.
 */
export async function drainGatewayForStop(options: DrainOptions): Promise<DrainOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const params = { requestId: options.requestId, terminalPolicy: "terminate", drain: true };
  const startedAt = now();
  let state;
  try {
    state = drainState(await options.call("gateway.suspend.prepare", params));
  } catch (err) {
    return { kind: "unavailable", reason: errorText(err) };
  }
  if (!state.suspensionId || (state.status !== "ready" && state.status !== "draining")) {
    return { kind: "unavailable", reason: `the gateway answered "${state.status || "nothing"}" to a drain request` };
  }
  let suspensionId = state.suspensionId;
  let transportFailures = 0;
  for (;;) {
    const waitedMs = now() - startedAt;
    if (state.status === "ready") return { kind: "ready", suspensionId, waitedMs };
    if (options.released?.()) return { kind: "released", suspensionId, active: state.active, waitedMs };
    if (waitedMs >= options.maxMs) return { kind: "expired", suspensionId, active: state.active, waitedMs };
    options.onDraining?.(state.active, waitedMs);
    await sleepUnlessReleased(Math.min(Math.max(state.retryAfterMs, 1_000), 10_000, options.maxMs - waitedMs), sleep, options.released);
    if (options.released?.()) continue;
    const renew = state.expiresAtMs !== null && state.expiresAtMs - now() < LEASE_RENEW_MARGIN_MS;
    try {
      const answer = await options.call(
        renew ? "gateway.suspend.prepare" : "gateway.suspend.status",
        renew ? params : { suspensionId },
      );
      const next = drainState(answer);
      if (next.status === "ready" || next.status === "draining") {
        state = { ...next, expiresAtMs: next.expiresAtMs ?? state.expiresAtMs };
        suspensionId = next.suspensionId ?? suspensionId;
      } else if (next.status === "running") {
        // The lease is gone (expired between polls): ask for it again.
        const again = drainState(await options.call("gateway.suspend.prepare", params));
        if (!again.suspensionId || (again.status !== "ready" && again.status !== "draining")) {
          return { kind: "unavailable", reason: `the drain lease lapsed and the gateway answered "${again.status || "nothing"}"` };
        }
        state = again;
        suspensionId = again.suspensionId;
      }
      transportFailures = 0;
    } catch (err) {
      // A retryable refusal keeps the drain going; so does a transport failure
      // or two. A gateway that keeps not answering has nothing left to drain
      // or to hold, and any other refusal ends the drain.
      if ((err as { code?: unknown }).code === "UNAVAILABLE") continue;
      if ((err as { name?: unknown }).name !== "GatewayRpcError" && ++transportFailures < DRAIN_TRANSPORT_FAILURES_TOLERATED) continue;
      return { kind: "unavailable", reason: errorText(err) };
    }
  }
}
