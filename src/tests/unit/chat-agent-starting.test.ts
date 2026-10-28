import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_STARTING_DEADLINE_MS,
  AGENT_STARTING_RETRY_DELAYS_MS,
  AgentStartingTimeoutError,
  gatewayFrameError,
  isAgentStartingRefusal,
  retryWhileAgentStarting,
} from "@/lib/chat-gateway-starting";
import { subscribeSessionApprovals, subscribeSessionMessages } from "@/lib/gateway-approvals";
import { loadPendingQuestions } from "@/lib/gateway-questions";
import { HarnessError } from "@/lib/harness/transport";

/**
 * Right after the gateway restarts, the socket is back before the agent is: a
 * call for an agent whose database is still being inspected and prepared is
 * refused with the core's "has not completed startup inspection and
 * preparation", which ends by telling the owner to run `openclaw doctor --fix`.
 * The chat showed that as a red "Failed to change effort" for the few seconds
 * every restart takes. These are the rules that make the chat wait it out
 * instead — bounded — tested without rendering it.
 */

const NOT_READY =
  "Agent main has not completed startup inspection and preparation. If this persists, run `openclaw doctor --fix`.";

/** The refusal as an older core may send it: prose, no code. */
const notReadyProse = () => gatewayFrameError({ message: NOT_READY });
/** …with a code that says nothing about startup, and `retryable: false`. */
const notReadyFlaggedFinal = () => gatewayFrameError({ code: "INVALID_REQUEST", retryable: false, message: NOT_READY });
/** …and structured, by the code the core reports pending inspection under. */
const notReadyStructured = () => gatewayFrameError({
  code: "UNAVAILABLE",
  message: "agent unavailable",
  details: { code: "agent-database-inspection-pending", agentId: "main" },
});
/** What the gateway adapter hands the chat: its own error, the frame as `cause`. */
const wrapped = (inner: Error) => new HarnessError("upstream", inner.message, inner);

describe("isAgentStartingRefusal", () => {
  it("reads the core's not-ready refusal, bare, flagged final or wrapped by the adapter", () => {
    expect(isAgentStartingRefusal(NOT_READY)).toBe(true);
    expect(isAgentStartingRefusal(notReadyProse())).toBe(true);
    expect(isAgentStartingRefusal(notReadyFlaggedFinal())).toBe(true);
    expect(isAgentStartingRefusal(wrapped(notReadyProse()))).toBe(true);
    expect(isAgentStartingRefusal(notReadyStructured())).toBe(true);
    expect(isAgentStartingRefusal(wrapped(notReadyStructured()))).toBe(true);
    expect(isAgentStartingRefusal(gatewayFrameError({
      code: "UNAVAILABLE", message: "x", details: { reason: "agent-database-preparation-pending" },
    }))).toBe(true);
  });

  it("counts the gateway's own startup refusal: the same state, one step earlier", () => {
    expect(isAgentStartingRefusal(wrapped(gatewayFrameError({
      code: "UNAVAILABLE", retryable: true, message: "gateway starting; retry shortly", details: { reason: "startup-sidecars" },
    })))).toBe(true);
  });

  it("does not wait on what waiting will not change", () => {
    // An inspection that FAILED is the refusal the core's repair advice is for.
    expect(isAgentStartingRefusal(gatewayFrameError({
      code: "UNAVAILABLE", retryable: false, message: "Agent main failed startup inspection: database is corrupt. Run `openclaw doctor --fix`.",
    }))).toBe(false);
    expect(isAgentStartingRefusal(gatewayFrameError({
      code: "UNAVAILABLE", retryable: false, message: "control ui build mismatch", details: { code: "PROTOCOL_MISMATCH" },
    }))).toBe(false);
    expect(isAgentStartingRefusal(wrapped(gatewayFrameError({ code: "INVALID_REQUEST", message: "unknown session" })))).toBe(false);
    expect(isAgentStartingRefusal(new HarnessError("not-connected", "Not connected"))).toBe(false);
    expect(isAgentStartingRefusal(new Error("Request timeout"))).toBe(false);
    expect(isAgentStartingRefusal(new Error('thinkingLevel "high" is not supported for llamacpp/gemma (use off)'))).toBe(false);
    expect(isAgentStartingRefusal(undefined)).toBe(false);
  });
});

describe("retryWhileAgentStarting", () => {
  // A fake clock the loop reads and a sleep that advances it — the loop's
  // arithmetic is under test, not the event loop's.
  let clock = 0;
  const now = () => clock;
  const sleep = vi.fn(async (ms: number) => { clock += ms; });
  const opts = (extra: Parameters<typeof retryWhileAgentStarting>[1] = {}) => ({
    now, sleep, delaysMs: [1_000, 2_000, 4_000], deadlineMs: 20_000, ...extra,
  });

  beforeEach(() => {
    clock = 0;
    sleep.mockClear();
  });

  it("an agent that is ready: one call, no wait", async () => {
    const attempt = vi.fn(async () => "ok");
    await expect(retryWhileAgentStarting(attempt, opts())).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("an agent still starting: waits it out on the backoff, then answers", async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(wrapped(notReadyProse()))
      .mockRejectedValueOnce(wrapped(notReadyFlaggedFinal()))
      .mockRejectedValueOnce(wrapped(notReadyStructured()))
      .mockRejectedValueOnce(wrapped(notReadyProse()))
      .mockResolvedValueOnce("applied");
    const onWaiting = vi.fn();
    await expect(retryWhileAgentStarting(attempt, opts({ onWaiting }))).resolves.toBe("applied");
    expect(attempt).toHaveBeenCalledTimes(5);
    // The last delay repeats.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000, 4_000, 4_000]);
    expect(onWaiting.mock.calls.map(([info]) => info)).toEqual([
      { attempt: 1, delayMs: 1_000 },
      { attempt: 2, delayMs: 2_000 },
      { attempt: 3, delayMs: 4_000 },
      { attempt: 4, delayMs: 4_000 },
    ]);
  });

  it("any other failure is the caller's, at once and unchanged", async () => {
    const refusal = wrapped(gatewayFrameError({ code: "INVALID_REQUEST", message: "unknown session" }));
    const attempt = vi.fn().mockRejectedValue(refusal);
    await expect(retryWhileAgentStarting(attempt, opts())).rejects.toBe(refusal);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("a refusal that never clears ends at the deadline, carrying the last refusal", async () => {
    const last = wrapped(notReadyProse());
    const attempt = vi.fn().mockRejectedValue(last);
    const err = await retryWhileAgentStarting(attempt, opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentStartingTimeoutError);
    expect((err as AgentStartingTimeoutError).cause).toBe(last);
    // 1 + 2 + 4 + 4 + 4 + 4 = 19 s waited; the next 4 s would cross 20 s.
    expect((err as AgentStartingTimeoutError).attempts).toBe(7);
    expect(clock).toBe(19_000);
    expect(clock).toBeLessThanOrEqual(20_000);
  });

  it("a newer call, a new socket or an unmount calls the wait off without another try", async () => {
    const controller = new AbortController();
    const attempt = vi.fn().mockRejectedValue(wrapped(notReadyProse()));
    const abortingSleep = vi.fn(async () => { controller.abort(); });
    const err = await retryWhileAgentStarting(attempt, opts({ signal: controller.signal, sleep: abortingSleep }))
      .catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does not start once called off", async () => {
    const controller = new AbortController();
    controller.abort();
    const attempt = vi.fn(async () => "ok");
    await expect(retryWhileAgentStarting(attempt, opts({ signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
    expect(attempt).not.toHaveBeenCalled();
  });

  it("ships a wait that outlasts a slow restart and still ends", () => {
    // A restart is ten to twenty seconds; two minutes clears a slow one.
    expect(AGENT_STARTING_DEADLINE_MS).toBe(120_000);
    expect(AGENT_STARTING_RETRY_DELAYS_MS[0]).toBeLessThanOrEqual(1_000);
    expect(Math.max(...AGENT_STARTING_RETRY_DELAYS_MS)).toBeLessThanOrEqual(15_000);
  });

  it("the shipped default, on real timers: a starting agent's call lands once it is ready", async () => {
    vi.useFakeTimers();
    try {
      const attempt = vi.fn()
        .mockRejectedValueOnce(wrapped(notReadyProse()))
        .mockRejectedValueOnce(wrapped(notReadyProse()))
        .mockResolvedValueOnce("applied");
      const done = retryWhileAgentStarting(attempt);
      await vi.advanceTimersByTimeAsync(AGENT_STARTING_RETRY_DELAYS_MS[0] + AGENT_STARTING_RETRY_DELAYS_MS[1]);
      await expect(done).resolves.toBe("applied");
      expect(attempt).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the chat's other on-load calls wait out a starting agent too", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** A gateway whose agent is ready after `refusals` not-ready answers. */
  function startingGateway(refusals: number, answer: unknown = {}) {
    let left = refusals;
    return vi.fn<(method: string, params: unknown) => Promise<unknown>>(async () => {
      if (left > 0) { left -= 1; throw notReadyFlaggedFinal(); }
      return answer;
    });
  }

  it("the approvals subscribe lands its replay instead of falling back and wiping the cards", async () => {
    const request = startingGateway(2, { approvalReplay: { approvals: [], truncated: false } });
    const applyReplay = vi.fn();
    const done = subscribeSessionApprovals(request, "agent:main:main", applyReplay);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "sessions.messages.subscribe", "sessions.messages.subscribe", "sessions.messages.subscribe",
    ]);
    // Every try was the approvals opt-in; the plain fallback was never needed.
    expect(request.mock.calls.every(([, params]) => (params as { includeApprovals?: boolean }).includeApprovals === true)).toBe(true);
    expect(applyReplay).toHaveBeenCalledTimes(1);
  });

  it("a subscribe the connection called off applies nothing and does not fall back", async () => {
    const request = startingGateway(5);
    const applyReplay = vi.fn();
    const controller = new AbortController();
    const done = subscribeSessionApprovals(request, "agent:main:main", applyReplay, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(request).toHaveBeenCalledTimes(1);
    expect(applyReplay).not.toHaveBeenCalled();
  });

  it("the plain transcript subscribe is taken once the agent is ready", async () => {
    const request = startingGateway(1);
    const done = subscribeSessionMessages(request, "agent:main:main");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(done).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("the pending-question replay still brings back a question the agent is parked on", async () => {
    const now = Date.now();
    const parked = {
      id: "ask_1",
      questions: [{ questionId: "target", header: "Deploy", question: "Where should this go?", options: [{ label: "Staging" }, { label: "Production" }] }],
      agentId: "main",
      sessionKey: "agent:main:main",
      runId: "run-1",
      createdAtMs: now - 1_000,
      expiresAtMs: now + 900_000,
      status: "pending",
    };
    const request = startingGateway(2, { questions: [parked] });
    const apply = vi.fn();
    const done = loadPendingQuestions(request, "agent:main:main", apply);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(request).toHaveBeenCalledTimes(3);
    expect(apply).toHaveBeenCalledTimes(1);
    expect((apply.mock.calls[0][0] as Array<{ id: string }>).map((card) => card.id)).toEqual(["ask_1"]);
    expect(apply.mock.calls[0][1]).toBe("agent:main:main");
  });
});
