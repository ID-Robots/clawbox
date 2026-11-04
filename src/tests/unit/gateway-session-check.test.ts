import { describe, expect, it, vi } from "vitest";
import {
  classifySessionProbeError,
  GatewaySessionsUnavailableError,
  SIMULATED_SESSION_FAULT,
  verifyGatewaySessions,
  withSimulatedSessionFault,
  type SessionCheckDeps,
  type SessionProbe,
} from "@/lib/gateway-session-check";
import { GatewayRpcError, GatewayWsUnavailableError } from "@/lib/openclaw-gateway-ws";

/**
 * The update's session check (TASK-2153), with no gateway: the probe answers
 * from a script, the restart is a spy, and the clock only moves when the check
 * sleeps — so a window is a number of asks, not seconds of a test run.
 */

const OK: SessionProbe = { kind: "ok" };
const RECLAIM: SessionProbe = SIMULATED_SESSION_FAULT;
const STARTING: SessionProbe = { kind: "unreachable", detail: "gateway starting; retry shortly", final: false };
// The core's own retryable "not yet" (respondChatHistoryUnavailable, 2026.10.9).
const REBUILDING: SessionProbe = { kind: "unavailable", detail: "UNAVAILABLE: session history is rebuilding; retry shortly" };

function harness(answers: SessionProbe[], overrides: Partial<SessionCheckDeps> = {}) {
  let clock = 0;
  let asked = 0;
  const events: string[] = [];
  const restart = vi.fn(async () => {
    events.push("restart");
  });
  const deps: SessionCheckDeps = {
    // The last scripted answer repeats: "still failing" is one entry, not twenty.
    probe: vi.fn(async () => {
      const answer = answers[Math.min(asked, answers.length - 1)];
      asked += 1;
      events.push(`ask:${answer.kind}`);
      return answer;
    }),
    restart,
    windowMs: 10_000,
    recoveryWindowMs: 30_000,
    intervalMs: 1_000,
    log: vi.fn(),
    onDetail: vi.fn(),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...overrides,
  };
  return { deps, restart, events, asked: () => asked };
}

describe("verifyGatewaySessions", () => {
  it("passes a gateway that answers chat.history, asking once and restarting nothing", async () => {
    const { deps, restart, asked } = harness([OK]);
    await expect(verifyGatewaySessions(deps)).resolves.toEqual({ verdict: "serving", restarted: false });
    expect(asked()).toBe(1);
    expect(restart).not.toHaveBeenCalled();
  });

  it("restarts the gateway once when it names the store failure, and passes when the restarted one answers", async () => {
    const { deps, restart, events } = harness([RECLAIM, OK]);
    await expect(verifyGatewaySessions(deps)).resolves.toEqual({ verdict: "serving", restarted: true });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["ask:store-failure", "restart", "ask:ok"]);
    // The owner's screen said what was happening, and is cleared after.
    expect(deps.onDetail).toHaveBeenCalledWith(expect.stringMatching(/cannot open chat sessions — restarting it once/));
    expect(vi.mocked(deps.onDetail!).mock.calls.at(-1)).toEqual([undefined]);
  });

  it("fails the step with the owner's words when the gateway still names the store failure after its one restart", async () => {
    const { deps, restart, asked } = harness([RECLAIM]);
    const failure = await verifyGatewaySessions(deps).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(GatewaySessionsUnavailableError);
    const message = (failure as Error).message;
    expect(message).toMatch(/^The OpenClaw gateway is running but cannot open chat sessions/);
    expect(message).toContain("UNAVAILABLE: SQLite session reclamation commit checkpoint expired");
    expect(message).toContain("restarting it once did not fix that");
    expect(message).toMatch(/Restart the device/);
    // Exactly one restart, and the restarted gateway was given its whole window.
    expect(restart).toHaveBeenCalledTimes(1);
    expect(asked()).toBe(1 + 31);
    expect(vi.mocked(deps.onDetail!).mock.calls.at(-1)).toEqual([undefined]);
  });

  it("gives a restarted gateway still in its reclamation the recovery window before calling it dead", async () => {
    const { deps, restart, events } = harness([RECLAIM, STARTING, RECLAIM, RECLAIM, OK]);
    await expect(verifyGatewaySessions(deps)).resolves.toEqual({ verdict: "serving", restarted: true });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["ask:store-failure", "restart", "ask:unreachable", "ask:store-failure", "ask:store-failure", "ask:ok"]);
  });

  it("waits out a gateway that is still starting rather than restarting it", async () => {
    const { deps, restart, asked } = harness([STARTING, STARTING, OK]);
    await expect(verifyGatewaySessions(deps)).resolves.toEqual({ verdict: "serving", restarted: false });
    expect(asked()).toBe(3);
    expect(restart).not.toHaveBeenCalled();
  });

  it("carries on, unconfirmed, when the gateway cannot be asked for the whole window — as the step did before", async () => {
    const { deps, restart, asked } = harness([STARTING]);
    await expect(verifyGatewaySessions(deps)).resolves.toEqual({
      verdict: "unconfirmed",
      detail: "gateway starting; retry shortly",
      restarted: false,
      answer: STARTING,
    });
    expect(asked()).toBe(11);
    expect(restart).not.toHaveBeenCalled();
  });

  it("asks once and carries on when there is no gateway token this server can use", async () => {
    const noToken: SessionProbe = { kind: "unreachable", detail: "no gateway token", final: true };
    const { deps, restart, asked } = harness([noToken]);
    await expect(verifyGatewaySessions(deps)).resolves.toEqual({ verdict: "unconfirmed", detail: "no gateway token", restarted: false, answer: noToken });
    expect(asked()).toBe(1);
    expect(restart).not.toHaveBeenCalled();
  });

  it("settles a restarted gateway's other refusal the way it settles one before a restart — carrying on, not failing", async () => {
    const refused: SessionProbe = { kind: "refused", detail: "INVALID_REQUEST: invalid chat.history params" };
    const { deps, restart, asked } = harness([RECLAIM, refused]);
    await expect(verifyGatewaySessions(deps)).resolves.toEqual({ verdict: "unconfirmed", detail: refused.detail, restarted: true, answer: refused });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(asked()).toBe(2);
  });

  it("never asks faster than every 250 ms, whatever interval it was given", async () => {
    for (const intervalMs of [Number.NaN, 0, -5, 1]) {
      const slept: number[] = [];
      let clock = 0;
      const { deps, asked } = harness([STARTING], {
        intervalMs,
        windowMs: 1_000,
        sleep: async (ms) => {
          slept.push(ms);
          clock += ms;
        },
        now: () => clock,
      });
      await verifyGatewaySessions(deps);
      expect(slept).toEqual([250, 250, 250, 250]);
      expect(asked()).toBe(5);
    }
  });

  it("does not restart over a refusal that is not the session-store failure", async () => {
    const { deps, restart, asked } = harness([{ kind: "refused", detail: "INVALID_REQUEST: invalid chat.history params" }]);
    await expect(verifyGatewaySessions(deps)).resolves.toMatchObject({ verdict: "unconfirmed", answer: { kind: "refused" } });
    expect(asked()).toBe(1);
    expect(restart).not.toHaveBeenCalled();
  });

  it("fails with the restart's own error, and does not restart twice, when the gateway does not come back", async () => {
    const { deps, asked } = harness([RECLAIM, OK], {
      restart: vi.fn(async () => {
        throw new Error("OpenClaw gateway is not listening on port 18789 (clawbox-gateway.service is failed (exit-code))");
      }),
    });
    await expect(verifyGatewaySessions(deps)).rejects.toThrow(/not listening on port 18789/);
    expect(deps.restart).toHaveBeenCalledTimes(1);
    expect(asked()).toBe(1);
    expect(vi.mocked(deps.onDetail!).mock.calls.at(-1)).toEqual([undefined]);
  });

  it("names a restarted gateway that never answers as not answering", async () => {
    const { deps } = harness([RECLAIM, STARTING]);
    await expect(verifyGatewaySessions(deps)).rejects.toThrow(/it does not answer \(gateway starting; retry shortly\)/);
  });

  // The core answers chat.history UNAVAILABLE, retryable, while its history is
  // rebuilding or busy — as right after a core upgrade. That is "not yet", not
  // the store failure: a restart then only starts the rebuild over.
  it("asks a gateway still rebuilding its history again, and restarts nothing, when it answers within the window", async () => {
    const { deps, restart, events } = harness([REBUILDING, REBUILDING, OK]);
    await expect(verifyGatewaySessions(deps)).resolves.toEqual({ verdict: "serving", restarted: false });
    expect(events).toEqual(["ask:unavailable", "ask:unavailable", "ask:ok"]);
    expect(restart).not.toHaveBeenCalled();
  });

  it("restarts once over a 'not yet' that lasts the whole window, and passes when the restarted gateway answers", async () => {
    // Window 10 s at 1 s: eleven asks, all "not yet", then the restart.
    const { deps, restart, events } = harness([...Array<SessionProbe>(11).fill(REBUILDING), OK]);
    await expect(verifyGatewaySessions(deps)).resolves.toEqual({ verdict: "serving", restarted: true });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(events.slice(-3)).toEqual(["ask:unavailable", "restart", "ask:ok"]);
    expect(events.filter((e) => e === "ask:unavailable")).toHaveLength(11);
  });

  it("carries on, with the answer, when the restarted gateway is still 'not yet' at the end of its window — never a failed update", async () => {
    const { deps, restart, asked } = harness([RECLAIM, REBUILDING]);
    await expect(verifyGatewaySessions(deps)).resolves.toEqual({
      verdict: "unconfirmed",
      detail: REBUILDING.kind === "unavailable" ? REBUILDING.detail : "",
      restarted: true,
      answer: REBUILDING,
    });
    expect(restart).toHaveBeenCalledTimes(1);
    // The restarted gateway was asked for its whole window before that.
    expect(asked()).toBe(1 + 31);
  });

  // The "not yet" has its own clock, from its first answer: a window spent
  // mostly on "gateway starting" is not a window of "not yet".
  it("does not restart a gateway that was starting for most of the window and first says 'not yet' near its end", async () => {
    for (const answers of [
      [...Array<SessionProbe>(10).fill(STARTING), REBUILDING, OK],
      [...Array<SessionProbe>(7).fill(STARTING), ...Array<SessionProbe>(6).fill(REBUILDING), OK],
    ]) {
      const { deps, restart } = harness(answers);
      await expect(verifyGatewaySessions(deps)).resolves.toEqual({ verdict: "serving", restarted: false });
      expect(restart).not.toHaveBeenCalled();
    }
  });

  it("times a 'not yet' that began late for a whole window of its own", async () => {
    // Starting until 9 s, then "not yet" from 9 s: restarted at 19 s — ten
    // seconds of "not yet" — not at the 10 s mark of the asking.
    const { deps, restart, events } = harness([...Array<SessionProbe>(9).fill(STARTING), REBUILDING]);
    const outcome = await verifyGatewaySessions(deps);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(events.indexOf("restart")).toBe(9 + 11);
    // Still "not yet" after the restart: carried on, never a failed update.
    expect(outcome).toMatchObject({ verdict: "unconfirmed", restarted: true, answer: { kind: "unavailable" } });
  });

  it("gives a 'not yet' first answered by a slow ask across the window's end a whole window too", async () => {
    // Real asks take time (connect, then up to 15 s for the call). Here the ask
    // sent at the 10 s mark answers "not yet" only at 15 s, and the gateway
    // answers at 22 s — seven seconds of "not yet", never a window of it.
    let clock = 0;
    const restart = vi.fn(async () => {});
    const outcome = await verifyGatewaySessions({
      probe: async () => {
        const sentAt = clock;
        if (sentAt < 10_000) return STARTING;
        if (sentAt === 10_000) {
          clock += 5_000;
          return REBUILDING;
        }
        return clock >= 22_000 ? OK : REBUILDING;
      },
      restart,
      windowMs: 10_000,
      recoveryWindowMs: 30_000,
      intervalMs: 1_000,
      log: () => {},
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(outcome).toEqual({ verdict: "serving", restarted: false });
    expect(restart).not.toHaveBeenCalled();
  });

  it("reads a window of 'not yet' whose last ask went unanswered as that 'not yet', and restarts", async () => {
    const { deps, restart, events } = harness([...Array<SessionProbe>(10).fill(REBUILDING), STARTING, OK]);
    await expect(verifyGatewaySessions(deps)).resolves.toEqual({ verdict: "serving", restarted: true });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(events.slice(-3)).toEqual(["ask:unreachable", "restart", "ask:ok"]);
  });

  it("carries on, never fails, when a restart earned by 'not yet' alone leaves a gateway still starting", async () => {
    // A slow box: the store failure was never named. Warned about by the
    // caller, not a failed update.
    const { deps, restart } = harness([...Array<SessionProbe>(11).fill(REBUILDING), STARTING]);
    await expect(verifyGatewaySessions(deps)).resolves.toEqual({
      verdict: "unconfirmed",
      detail: "gateway starting; retry shortly",
      restarted: true,
      answer: STARTING,
    });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  // After the restart the window is fixed, and silence is silence: no "not
  // yet" clock and no standing in for a dropped ask.
  it("fails when the restarted gateway names the store failure and then stops answering, whatever earned the restart", async () => {
    const { deps, restart } = harness([...Array<SessionProbe>(11).fill(REBUILDING), RECLAIM, STARTING]);
    const failure = await verifyGatewaySessions(deps).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(GatewaySessionsUnavailableError);
    expect((failure as Error).message).toContain("it answers UNAVAILABLE: SQLite session reclamation commit checkpoint expired");
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("fails a store-failure restart whose gateway said 'not yet' once and then nothing for the rest of its window", async () => {
    const { deps, restart } = harness([RECLAIM, REBUILDING, STARTING]);
    await expect(verifyGatewaySessions(deps)).rejects.toThrow(/it does not answer \(gateway starting; retry shortly\)/);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("waits for the restarted gateway exactly its recovery window, however late a 'not yet' begins", async () => {
    const { deps, asked } = harness([RECLAIM, ...Array<SessionProbe>(20).fill(STARTING), REBUILDING]);
    await expect(verifyGatewaySessions(deps)).resolves.toMatchObject({ verdict: "unconfirmed", restarted: true, answer: { kind: "unavailable" } });
    // One ask before the restart, then 0..30 s at 1 s: 31 — not 30 s more from the first "not yet".
    expect(asked()).toBe(1 + 31);
  });

  it("still fails when the restarted gateway names the store failure again after a 'not yet'", async () => {
    const { deps, restart } = harness([REBUILDING, RECLAIM, REBUILDING, RECLAIM], { windowMs: 0, recoveryWindowMs: 2_000 });
    const failure = await verifyGatewaySessions(deps).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(GatewaySessionsUnavailableError);
    // It said "not yet" before the restart, so not "still": it names the store failure now.
    expect((failure as Error).message).toContain("it answers UNAVAILABLE: SQLite session reclamation commit checkpoint expired");
    expect((failure as Error).message).toContain("cannot open chat sessions (UNAVAILABLE: session history is rebuilding; retry shortly)");
    expect(restart).toHaveBeenCalledTimes(1);
  });
});

describe("classifySessionProbeError", () => {
  it("reads the field box's answer — the reclamation checkpoint — as the store failure, whatever code it comes with", () => {
    expect(classifySessionProbeError(new GatewayRpcError("SQLite session reclamation commit checkpoint expired", "UNAVAILABLE")))
      .toEqual({ kind: "store-failure", detail: "UNAVAILABLE: SQLite session reclamation commit checkpoint expired" });
    expect(classifySessionProbeError(new GatewayRpcError("SQLite session reclamation commit checkpoint expired", "INTERNAL")).kind)
      .toBe("store-failure");
    expect(classifySessionProbeError(new Error("SQLite session reclamation commit checkpoint expired")).kind).toBe("store-failure");
  });

  it("reads any other UNAVAILABLE as the core's retryable 'not yet', not as the store failure", () => {
    // The core's own sentences for chat.history (respondChatHistoryUnavailable, 2026.10.9).
    for (const sentence of [
      "session history is rebuilding; retry shortly",
      "session history is busy; retry shortly",
      "session rows are initializing; reload the conversation",
      "session changed while reading history",
    ]) {
      expect(classifySessionProbeError(new GatewayRpcError(sentence, "UNAVAILABLE")))
        .toEqual({ kind: "unavailable", detail: `UNAVAILABLE: ${sentence}` });
    }
  });

  it("reads any other refusal as an answer that is not this failure", () => {
    expect(classifySessionProbeError(new GatewayRpcError("invalid chat.history params", "INVALID_REQUEST")))
      .toEqual({ kind: "refused", detail: "INVALID_REQUEST: invalid chat.history params" });
  });

  it("reads a gateway it could not reach as one to ask again — except when there is no token to ask with", () => {
    expect(classifySessionProbeError(new GatewayWsUnavailableError("connect ECONNREFUSED 127.0.0.1:18789")))
      .toEqual({ kind: "unreachable", detail: "connect ECONNREFUSED 127.0.0.1:18789", final: false });
    expect(classifySessionProbeError(new Error("chat.history timed out after 15000ms")))
      .toEqual({ kind: "unreachable", detail: "chat.history timed out after 15000ms", final: false });
    expect(classifySessionProbeError(new GatewayWsUnavailableError("no gateway token")))
      .toEqual({ kind: "unreachable", detail: "no gateway token", final: true });
  });
});

describe("withSimulatedSessionFault", () => {
  it("plays the field box's answer once, then hands every ask to the real probe", async () => {
    const real = vi.fn(async (): Promise<SessionProbe> => OK);
    const probe = withSimulatedSessionFault(real, "once");
    expect(await probe()).toEqual(SIMULATED_SESSION_FAULT);
    expect(await probe()).toEqual(OK);
    expect(await probe()).toEqual(OK);
    expect(real).toHaveBeenCalledTimes(2);
  });

  it("plays it on every ask with `always`, and is the real probe for anything else", async () => {
    const real = vi.fn(async (): Promise<SessionProbe> => OK);
    const always = withSimulatedSessionFault(real, "always");
    expect([await always(), await always()]).toEqual([SIMULATED_SESSION_FAULT, SIMULATED_SESSION_FAULT]);
    expect(real).not.toHaveBeenCalled();
    for (const mode of [undefined, "", "1", "true"]) {
      expect(withSimulatedSessionFault(real, mode)).toBe(real);
    }
  });
});
