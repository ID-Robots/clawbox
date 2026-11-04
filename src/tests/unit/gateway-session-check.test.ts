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

  it("restarts the gateway once when it answers UNAVAILABLE, and passes when the restarted one answers", async () => {
    const { deps, restart, events } = harness([RECLAIM, OK]);
    await expect(verifyGatewaySessions(deps)).resolves.toEqual({ verdict: "serving", restarted: true });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["ask:unavailable", "restart", "ask:ok"]);
    // The owner's screen said what was happening, and is cleared after.
    expect(deps.onDetail).toHaveBeenCalledWith(expect.stringMatching(/cannot open chat sessions — restarting it once/));
    expect(vi.mocked(deps.onDetail!).mock.calls.at(-1)).toEqual([undefined]);
  });

  it("fails the step with the owner's words when the gateway still answers UNAVAILABLE after its one restart", async () => {
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
    expect(events).toEqual(["ask:unavailable", "restart", "ask:unreachable", "ask:unavailable", "ask:unavailable", "ask:ok"]);
  });

  it("waits out a gateway that is still starting rather than restarting it", async () => {
    const { deps, restart, asked } = harness([STARTING, STARTING, OK]);
    await expect(verifyGatewaySessions(deps)).resolves.toEqual({ verdict: "serving", restarted: false });
    expect(asked()).toBe(3);
    expect(restart).not.toHaveBeenCalled();
  });

  it("carries on, unconfirmed, when the gateway cannot be asked for the whole window — as the step did before", async () => {
    const { deps, restart, asked } = harness([STARTING]);
    await expect(verifyGatewaySessions(deps)).resolves.toEqual({ verdict: "unconfirmed", detail: STARTING.kind === "unreachable" ? STARTING.detail : "" });
    expect(asked()).toBe(11);
    expect(restart).not.toHaveBeenCalled();
  });

  it("asks once and carries on when there is no gateway token this server can use", async () => {
    const { deps, restart, asked } = harness([{ kind: "unreachable", detail: "no gateway token", final: true }]);
    await expect(verifyGatewaySessions(deps)).resolves.toEqual({ verdict: "unconfirmed", detail: "no gateway token" });
    expect(asked()).toBe(1);
    expect(restart).not.toHaveBeenCalled();
  });

  it("does not restart over a refusal that is not the session-store failure", async () => {
    const { deps, restart, asked } = harness([{ kind: "refused", detail: "INVALID_REQUEST: invalid chat.history params" }]);
    await expect(verifyGatewaySessions(deps)).resolves.toMatchObject({ verdict: "unconfirmed" });
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
});

describe("classifySessionProbeError", () => {
  it("reads the field box's answer — UNAVAILABLE with the reclamation text — as the failure", () => {
    expect(classifySessionProbeError(new GatewayRpcError("SQLite session reclamation commit checkpoint expired", "UNAVAILABLE")))
      .toEqual({ kind: "unavailable", detail: "UNAVAILABLE: SQLite session reclamation commit checkpoint expired" });
    // Either half is enough: the code alone, or the core's words under another code.
    expect(classifySessionProbeError(new GatewayRpcError("session store busy", "UNAVAILABLE")).kind).toBe("unavailable");
    expect(classifySessionProbeError(new GatewayRpcError("SQLite session reclamation commit checkpoint expired", "INTERNAL")).kind).toBe("unavailable");
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
