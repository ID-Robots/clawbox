/**
 * Does the OpenClaw gateway SERVE CHAT SESSIONS, not merely answer `/healthz`?
 *
 * TASK-2153. An update that also moved the core (2026.8.1 → 2026.10.9) ended
 * green — "Verifying gateway health" passed over a gateway that listened and
 * answered `/healthz` `{"ok":true,"status":"live"}` — and the chat was dead for
 * 22 minutes. Every session call (`chat.history`, `sessions.patch`,
 * `models.list`, `agent`) answered `UNAVAILABLE` "SQLite session reclamation
 * commit checkpoint expired" once a reclamation worker over a large agent
 * database had run 33.9 s and been rejected. The gateway never recovered by
 * itself; one restart fixed it at once
 * (docs/issues/openclaw-session-reclamation-checkpoint.md).
 *
 * So the verify asks the question the chat asks — one `chat.history` on the
 * main session over the gateway's own RPC — and acts only on the answer that
 * failure gives:
 *
 * - it answers: the gateway serves sessions, and that is the whole cost;
 * - it names the reclamation checkpoint — the store failure: restart the
 *   gateway ONCE, the way the update restarts it, and ask again until it
 *   answers or the recovery window ends — then fail the step with words the
 *   owner can act on, never a green "Completed" over a dead chat;
 * - any OTHER `UNAVAILABLE` is not that failure but the core's "not yet": its
 *   `chat.history` answers UNAVAILABLE, `retryable`, while its session rows are
 *   initializing, its history is rebuilding (as after a core upgrade) or busy
 *   (`respondChatHistoryUnavailable` in 2026.10.9). It is asked again; only one
 *   that lasts a whole window from its first answer earns the restart, and a
 *   restarted gateway that is still "not yet", or still starting, without ever
 *   naming the store failure is a warning, not a failed update;
 * - anything else — no token this server can use, a gateway still starting
 *   for the whole window, a different refusal — is not that failure, and the
 *   step goes on exactly as it did before this check existed. A check that
 *   cannot ask must not become a failed update.
 *
 * POLICY ONLY: the probe, the restart and the clock are the caller's, so every
 * outcome is tested without a gateway (gateway-session-check.test.ts).
 */

import { monotonicNow } from "@/lib/monotonic-clock";
import { gatewayWsMainChatHistory } from "@/lib/openclaw-gateway-ws";

/** One ask of the gateway, classified. */
export type SessionProbe =
  /** It answered: the session store opened. */
  | { kind: "ok" }
  /** It named the store failure (the reclamation checkpoint) — the failure this check is for. */
  | { kind: "store-failure"; detail: string }
  /** UNAVAILABLE without those words: the core's retryable "not yet" (initializing, rebuilding, busy). */
  | { kind: "unavailable"; detail: string }
  /** It answered with some other refusal: not that failure, not this check's to judge. */
  | { kind: "refused"; detail: string }
  /**
   * It could not be asked: not listening, still starting, no answer in time.
   * `final` when asking again cannot help (no gateway token this server can use).
   */
  | { kind: "unreachable"; detail: string; final: boolean };

/** The core's own words for the store failure, whatever code they arrive with. */
const SESSION_STORE_FAILURE_RE = /session reclamation|reclamation commit|commit checkpoint/i;

/**
 * What an error from {@link gatewayWsMainChatHistory} says about the gateway.
 *
 * By name, not `instanceof`: suites that import the updater mock
 * `@/lib/openclaw-gateway-ws` without its classes, and `instanceof undefined`
 * throws (the same reason `restartGatewayForRecovery` matches by name).
 */
export function classifySessionProbeError(err: unknown): SessionProbe {
  const failure = err as { name?: unknown; code?: unknown; message?: unknown } | null;
  const message = typeof failure?.message === "string" && failure.message ? failure.message : String(err);
  if (failure?.name === "GatewayRpcError") {
    const code = typeof failure.code === "string" && failure.code ? failure.code : "ERROR";
    const detail = `${code}: ${message}`;
    if (SESSION_STORE_FAILURE_RE.test(message)) return { kind: "store-failure", detail };
    if (code === "UNAVAILABLE") return { kind: "unavailable", detail };
    return { kind: "refused", detail };
  }
  if (SESSION_STORE_FAILURE_RE.test(message)) return { kind: "store-failure", detail: message };
  return {
    kind: "unreachable",
    detail: message,
    final: failure?.name === "GatewayWsUnavailableError" && message === "no gateway token",
  };
}

/** One `chat.history` on the main session, as the chat opens it. Never throws. */
export async function probeMainChatSession(timeoutMs: number): Promise<SessionProbe> {
  try {
    await gatewayWsMainChatHistory({ timeoutMs });
    return { kind: "ok" };
  } catch (err) {
    return classifySessionProbeError(err);
  }
}

/** The answer the field box gave, word for word — what {@link withSimulatedSessionFault} plays back. */
export const SIMULATED_SESSION_FAULT: SessionProbe = {
  kind: "store-failure",
  detail: "UNAVAILABLE: SQLite session reclamation commit checkpoint expired",
};

/**
 * A hardware-test seam, and nothing else: `once` answers the first ask with
 * {@link SIMULATED_SESSION_FAULT} and lets the real gateway answer the rest,
 * `always` answers every ask with it — so the restart, and the failed step, can
 * be shown on a board against a real gateway and a real restart. The updater
 * reads it from `CLAWBOX_TEST_SESSION_FAULT`, which nothing on a box sets; any
 * other value is the probe untouched.
 */
export function withSimulatedSessionFault(
  probe: () => Promise<SessionProbe>,
  mode: string | undefined,
): () => Promise<SessionProbe> {
  if (mode !== "once" && mode !== "always") return probe;
  let played = false;
  return async () => {
    if (mode === "always" || !played) {
      played = true;
      return SIMULATED_SESSION_FAULT;
    }
    return probe();
  };
}

export interface SessionCheckDeps {
  /** One ask; never throws ({@link probeMainChatSession}). */
  probe: () => Promise<SessionProbe>;
  /** Restart the gateway the way the caller does, and wait until it listens; throws when it does not. */
  restart: () => Promise<void>;
  /** How long a gateway that cannot be asked yet is asked again, before any restart. */
  windowMs: number;
  /** How long the restarted gateway has to answer. */
  recoveryWindowMs: number;
  /** Between two asks. */
  intervalMs: number;
  log?: (line: string) => void;
  /** What the update screen says while the check recovers; `undefined` clears it. */
  onDetail?: (detail: string | undefined) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds on a monotonic clock; only differences are read. Default `monotonicNow`. */
  now?: () => number;
}

export type SessionCheckOutcome =
  | { verdict: "serving"; restarted: boolean }
  /**
   * It could not be asked, answered with another refusal, or was still "not
   * yet" after its restart: the caller carries on. `answer` is the last ask, so
   * the caller can tell a gateway that never answered from one still getting
   * its sessions ready, and from one that answered something else.
   */
  | {
    verdict: "unconfirmed";
    detail: string;
    restarted: boolean;
    answer: Exclude<SessionProbe, { kind: "ok" } | { kind: "store-failure" }>;
  };

/** The shortest pause between two asks, whatever the caller passed: never a hot spin. */
const MIN_INTERVAL_MS = 250;

/** The step's failure: the gateway still cannot serve sessions after its one restart. */
export class GatewaySessionsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewaySessionsUnavailableError";
  }
}

/**
 * Ask until `settles` says the answer is the one wanted or the window is spent,
 * and answer the last ask. Always asks once, also on a spent window; never asks
 * again when asking again cannot help.
 *
 * A "not yet" (`unavailable`) is timed on its own clock, from its first answer:
 * the window it must outlast is `windowMs` of "not yet", not of asking. So a
 * gateway that refused connects for most of the window ("gateway starting")
 * and first says "rebuilding" on the last ask is asked on, not handed back as
 * a whole window of "not yet"; and a window of "not yet" whose last ask
 * happened to time out is still that "not yet". All asking ends by twice the
 * window. Returns the last answer — or, when that last ask went unanswered
 * after a "not yet", the last "not yet".
 */
async function askWithin(
  deps: SessionCheckDeps,
  windowMs: number,
  settles: (answer: SessionProbe) => boolean,
): Promise<SessionProbe> {
  // Monotonic (`@/lib/monotonic-clock`): gateway_verify runs right after the
  // update's reboot, when timesyncd steps the clock of a box with no RTC, and
  // on `Date.now()` that step would end the restarted gateway's window after
  // one ask — failing a healthy update — or stretch it by hours.
  const now = deps.now ?? monotonicNow;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const window = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 0;
  const started = now();
  const interval = Number.isFinite(deps.intervalMs) ? Math.max(MIN_INTERVAL_MS, deps.intervalMs) : MIN_INTERVAL_MS;
  let notYet: Extract<SessionProbe, { kind: "unavailable" }> | null = null;
  let notYetSince = 0;
  for (;;) {
    const answer = await deps.probe();
    if (settles(answer) || (answer.kind === "unreachable" && answer.final)) return answer;
    const at = now();
    if (answer.kind === "unavailable") {
      if (!notYet) notYetSince = at;
      notYet = answer;
    }
    // A "not yet" seen in this window has its own deadline, capped at twice
    // the window; without one, the window is the deadline.
    const deadline = notYet ? Math.min(notYetSince + window, started + 2 * window) : started + window;
    const left = deadline - at;
    // The latest answer, unless it is an ask that went unanswered after a
    // "not yet": one dropped ask does not turn that into "no answer".
    if (left <= 0) return answer.kind === "unreachable" && notYet ? notYet : answer;
    await sleep(Math.min(interval, left));
  }
}

function stillUnavailableMessage(
  before: Extract<SessionProbe, { kind: "store-failure" | "unavailable" }>,
  after: Extract<SessionProbe, { kind: "store-failure" | "unreachable" }>,
): string {
  const now = after.kind === "unreachable"
    ? `it does not answer (${after.detail})`
    : `it ${before.kind === "store-failure" ? "still " : ""}answers ${after.detail}`;
  return `The OpenClaw gateway is running but cannot open chat sessions (${before.detail}), `
    + `and restarting it once did not fix that: ${now}. The chat will not answer until it can. `
    + "Restart the device; if the chat is still silent, retry the update or contact support with this message.";
}

/**
 * Prove the gateway serves chat sessions, restarting it once if it answers
 * that it cannot. Throws {@link GatewaySessionsUnavailableError} when the store
 * failure is named after that restart, or was named before it and the
 * restarted gateway has not answered since; and whatever `restart` throws when
 * it does not come back at all.
 */
export async function verifyGatewaySessions(deps: SessionCheckDeps): Promise<SessionCheckOutcome> {
  const log = deps.log ?? ((line: string) => console.log(line));
  // Before any restart, "cannot ask yet" and the core's "not yet" are asked
  // again, so a gateway still starting or rebuilding its history is waited
  // for, not restarted. The store failure, an answer or another refusal
  // settles it at once.
  const first = await askWithin(
    deps,
    deps.windowMs,
    (answer) => answer.kind !== "unreachable" && answer.kind !== "unavailable",
  );
  if (first.kind === "ok") return { verdict: "serving", restarted: false };
  if (first.kind === "refused" || first.kind === "unreachable") {
    log(`could not confirm the gateway serves chat sessions (${first.detail}); carrying on`);
    return { verdict: "unconfirmed", detail: first.detail, restarted: false, answer: first };
  }

  // The store failure, or "not yet" for the whole window: the restart that
  // cleared it in the field.
  log(`the gateway is up but cannot serve chat sessions (${first.detail}); restarting it once`);
  deps.onDetail?.("The gateway is up but cannot open chat sessions — restarting it once");
  try {
    await deps.restart();
    deps.onDetail?.("Waiting for the restarted gateway to open chat sessions");
    // After the restart only an answer or another refusal settles it: a fresh
    // gateway may spend a while starting, rebuilding, or in the same
    // reclamation, before it can.
    const after = await askWithin(
      deps,
      deps.recoveryWindowMs,
      (answer) => answer.kind === "ok" || answer.kind === "refused",
    );
    if (after.kind === "ok") {
      log("the restarted gateway serves chat sessions again");
      return { verdict: "serving", restarted: true };
    }
    // A failed update needs the store failure in the evidence: named now, or
    // named before the restart and the restarted gateway never answering since.
    // A restart earned by "not yet" alone, over a gateway still starting or
    // rebuilding at the end, is a slow box — warned about, not failed.
    if (after.kind === "store-failure" || (after.kind === "unreachable" && first.kind === "store-failure")) {
      log(`the restarted gateway still cannot serve chat sessions (${after.detail})`);
      throw new GatewaySessionsUnavailableError(stillUnavailableMessage(first, after));
    }
    log(`the restarted gateway does not name the store failure (${after.detail}); carrying on`);
    return { verdict: "unconfirmed", detail: after.detail, restarted: true, answer: after };
  } finally {
    deps.onDetail?.(undefined);
  }
}
