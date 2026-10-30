import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_DRAIN_MAX_MS,
  NO_AGENT_WORK,
  UPDATE_BUSY_WAIT_DEFAULT_MS,
  countActiveSessions,
  describeAgentWork,
  drainGatewayForStop,
  updateBusyWaitMs,
  waitForAgentWork,
  withTotal,
  type AgentWorkCounts,
  type GatewayCall,
} from "@/lib/update-busy";

// The update's busy gate (issue #1269), driven by a fake clock: `sleep` moves
// time forward instead of waiting, so a 15-minute bound is a few rounds here.
function fakeClock(start = 1_000_000) {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => { sleeps.push(ms); now += ms; },
    advance: (ms: number) => { now += ms; },
    sleeps,
  };
}

const counts = (agentRuns: number, subagentRuns = 0, codingRuns = 0): AgentWorkCounts =>
  withTotal({ agentRuns, subagentRuns, codingRuns });

describe("updateBusyWaitMs", () => {
  it("is 15 minutes by default and honours a whole number of milliseconds, 0 included", () => {
    expect(UPDATE_BUSY_WAIT_DEFAULT_MS).toBe(900_000);
    expect(updateBusyWaitMs({})).toBe(900_000);
    expect(updateBusyWaitMs({ CLAWBOX_UPDATE_BUSY_WAIT_MS: "60000" })).toBe(60_000);
    expect(updateBusyWaitMs({ CLAWBOX_UPDATE_BUSY_WAIT_MS: " 0 " })).toBe(0);
  });

  it("never lets a typo turn the gate off", () => {
    for (const raw of ["", "15m", "-1", "1e3", "abc", "99999999999999999999"]) {
      expect(updateBusyWaitMs({ CLAWBOX_UPDATE_BUSY_WAIT_MS: raw })).toBe(900_000);
    }
  });
});

describe("countActiveSessions", () => {
  it("counts sessions with a run in flight, sub-agent and ACP sessions apart", () => {
    expect(countActiveSessions({
      sessions: [
        { key: "agent:main:main", hasActiveRun: true, hasActiveSubagentRun: true },
        { key: "agent:main:telegram:dm:42", hasActiveRun: true },
        { key: "agent:main:subagent:7c1e", hasActiveRun: true },
        { key: "agent:coder:acp:91ab", hasActiveRun: true },
        { key: "agent:main:cron:nightly", hasActiveRun: false },
        { key: "agent:main:old" },
      ],
    })).toEqual({ agentRuns: 2, subagentRuns: 2 });
  });

  it("takes a parent's hasActiveSubagentRun as a floor when the child's row is not in the answer", () => {
    expect(countActiveSessions({
      sessions: [
        { key: "agent:main:main", hasActiveRun: false, hasActiveSubagentRun: true },
        { key: "agent:other:main", hasActiveSubagentRun: true },
      ],
    })).toEqual({ agentRuns: 0, subagentRuns: 2 });
  });

  it("counts nothing from an answer that is not a list of rows", () => {
    for (const payload of [null, undefined, {}, { sessions: "x" }, { sessions: [null, 3, "a"] }]) {
      expect(countActiveSessions(payload)).toEqual({ agentRuns: 0, subagentRuns: 0 });
    }
    // Only a literal true is a run in flight.
    expect(countActiveSessions({ sessions: [{ key: "agent:main:main", hasActiveRun: "true" }] })).toEqual({ agentRuns: 0, subagentRuns: 0 });
  });
});

describe("describeAgentWork", () => {
  it("names the total and what it is made of", () => {
    expect(describeAgentWork(counts(1))).toBe("1 agent run (1 chat/agent)");
    expect(describeAgentWork(counts(2, 1, 1))).toBe("4 agent runs (2 chat/agent, 1 sub-agent, 1 coding-agent)");
    expect(describeAgentWork(NO_AGENT_WORK)).toBe("0 agent runs");
  });
});

describe("waitForAgentWork", () => {
  it("costs one read and no wait on an idle box", async () => {
    const clock = fakeClock();
    const read = vi.fn(async () => NO_AGENT_WORK);
    const onWaiting = vi.fn();
    expect(await waitForAgentWork({ maxMs: 900_000, read, onWaiting, ...clock })).toEqual({ kind: "idle", waitedMs: 0 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(onWaiting).not.toHaveBeenCalled();
    expect(clock.sleeps).toEqual([]);
  });

  it("waits, polling, until the last run has finished", async () => {
    const clock = fakeClock();
    const answers = [counts(2), counts(1, 0, 1), counts(0, 0, 1), NO_AGENT_WORK];
    const read = vi.fn(async () => answers.shift()!);
    const seen: number[] = [];
    const outcome = await waitForAgentWork({
      maxMs: 900_000,
      pollMs: 10_000,
      read,
      onWaiting: (c) => seen.push(c.total),
      ...clock,
    });
    expect(outcome).toEqual({ kind: "idle", waitedMs: 30_000 });
    expect(seen).toEqual([2, 2, 1]);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("gives up at the bound with the runs still active, never sleeping past it", async () => {
    const clock = fakeClock();
    const outcome = await waitForAgentWork({ maxMs: 25_000, pollMs: 10_000, read: async () => counts(1), ...clock });
    expect(outcome).toEqual({ kind: "expired", counts: counts(1), waitedMs: 25_000 });
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBe(25_000);
  });

  it("does not wait at all with a bound of 0", async () => {
    const clock = fakeClock();
    expect(await waitForAgentWork({ maxMs: 0, read: async () => counts(3), ...clock })).toEqual({ kind: "expired", counts: counts(3), waitedMs: 0 });
    expect(clock.sleeps).toEqual([]);
  });

  it("answers \"Update anyway\" within a second, mid-sleep", async () => {
    const clock = fakeClock();
    let released = false;
    const sleep = async (ms: number) => {
      await clock.sleep(ms);
      if (clock.sleeps.length === 3) released = true;
    };
    const outcome = await waitForAgentWork({
      maxMs: 900_000,
      pollMs: 10_000,
      read: async () => counts(1),
      released: () => released,
      now: clock.now,
      sleep,
    });
    expect(outcome).toMatchObject({ kind: "released", waitedMs: 3_000 });
    expect(clock.sleeps).toEqual([1_000, 1_000, 1_000]);
  });
});

describe("drainGatewayForStop", () => {
  const ID = "clawbox-update-openclaw_install-1";
  type Answer = Record<string, unknown> | Error;
  /** A gateway that answers each call with the next scripted answer for its method. */
  function gateway(script: Record<string, Answer[]>) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const call: GatewayCall = async (method, params) => {
      calls.push([method, params]);
      const next = script[method]?.shift();
      if (!next) throw new Error(`unscripted ${method}`);
      if (next instanceof Error) throw next;
      return next;
    };
    return { call, calls };
  }
  const rpcError = (code: string) => Object.assign(new Error(code), { name: "GatewayRpcError", code });

  it("asks for the documented release-update drain and is done at once on an idle gateway", async () => {
    const clock = fakeClock();
    const gw = gateway({ "gateway.suspend.prepare": [{ status: "ready", suspensionId: "s1", activeCount: 0, expiresAtMs: clock.now() + 120_000 }] });
    expect(await drainGatewayForStop({ call: gw.call, requestId: ID, maxMs: GATEWAY_DRAIN_MAX_MS, ...clock }))
      .toEqual({ kind: "ready", suspensionId: "s1", waitedMs: 0 });
    expect(gw.calls).toEqual([["gateway.suspend.prepare", { requestId: ID, terminalPolicy: "terminate", drain: true }]]);
  });

  it("polls status at the pace the gateway asks for until the admitted work has settled", async () => {
    const clock = fakeClock();
    const gw = gateway({
      "gateway.suspend.prepare": [{ status: "draining", suspensionId: "s1", activeCount: 2, retryAfterMs: 4_000, expiresAtMs: clock.now() + 120_000 }],
      "gateway.suspend.status": [
        { status: "draining", activeCount: 1, retryAfterMs: 4_000 },
        { status: "ready", expiresAtMs: clock.now() + 120_000 },
      ],
    });
    const draining: number[] = [];
    const outcome = await drainGatewayForStop({ call: gw.call, requestId: ID, maxMs: GATEWAY_DRAIN_MAX_MS, onDraining: (n) => draining.push(n), ...clock });
    expect(outcome).toEqual({ kind: "ready", suspensionId: "s1", waitedMs: 8_000 });
    expect(draining).toEqual([2, 1]);
    expect(gw.calls.slice(1)).toEqual([
      ["gateway.suspend.status", { suspensionId: "s1" }],
      ["gateway.suspend.status", { suspensionId: "s1" }],
    ]);
  });

  it("renews the two-minute lease with the same request before it runs out", async () => {
    const clock = fakeClock();
    const start = clock.now();
    const gw = gateway({
      "gateway.suspend.prepare": [
        { status: "draining", suspensionId: "s1", activeCount: 1, retryAfterMs: 10_000, expiresAtMs: start + 120_000 },
        { status: "draining", suspensionId: "s1", activeCount: 1, retryAfterMs: 10_000, expiresAtMs: start + 210_000 },
      ],
      "gateway.suspend.status": [
        ...Array.from({ length: 7 }, () => ({ status: "draining", activeCount: 1, retryAfterMs: 10_000 })),
        { status: "ready" },
      ],
    });
    const outcome = await drainGatewayForStop({ call: gw.call, requestId: ID, maxMs: GATEWAY_DRAIN_MAX_MS, ...clock });
    expect(outcome.kind).toBe("ready");
    const renewals = gw.calls.filter(([m]) => m === "gateway.suspend.prepare");
    expect(renewals).toHaveLength(2);
    expect(renewals[1][1]).toEqual({ requestId: ID, terminalPolicy: "terminate", drain: true });
  });

  it("gives up at its bound with the lease still held, so the stop goes ahead fenced", async () => {
    const clock = fakeClock();
    const gw = gateway({
      "gateway.suspend.prepare": [{ status: "draining", suspensionId: "s1", activeCount: 1, retryAfterMs: 10_000 }],
      "gateway.suspend.status": Array.from({ length: 40 }, () => ({ status: "draining", activeCount: 1, retryAfterMs: 10_000 })),
    });
    expect(await drainGatewayForStop({ call: gw.call, requestId: ID, maxMs: 30_000, ...clock }))
      .toEqual({ kind: "expired", suspensionId: "s1", active: 1, waitedMs: 30_000 });
  });

  it("ends at once on \"Update anyway\", lease held", async () => {
    const clock = fakeClock();
    let released = false;
    const gw = gateway({ "gateway.suspend.prepare": [{ status: "draining", suspensionId: "s1", activeCount: 3, retryAfterMs: 10_000 }] });
    const outcome = await drainGatewayForStop({
      call: gw.call,
      requestId: ID,
      maxMs: GATEWAY_DRAIN_MAX_MS,
      released: () => released,
      now: clock.now,
      sleep: async (ms) => { await clock.sleep(ms); released = true; },
    });
    expect(outcome).toEqual({ kind: "released", suspensionId: "s1", active: 3, waitedMs: 1_000 });
    expect(gw.calls).toHaveLength(1);
  });

  it("holds nothing and says why when there is no drain to be had", async () => {
    const clock = fakeClock();
    // No gateway at all.
    expect(await drainGatewayForStop({ call: gateway({}).call, requestId: ID, maxMs: 1_000, ...clock }))
      .toMatchObject({ kind: "unavailable" });
    // A core without drain mode answers refuse-only `busy` and holds nothing.
    const refuseOnly = gateway({ "gateway.suspend.prepare": [{ status: "busy", activeCount: 2, retryAfterMs: 5_000 }] });
    expect(await drainGatewayForStop({ call: refuseOnly.call, requestId: ID, maxMs: 1_000, ...clock }))
      .toEqual({ kind: "unavailable", reason: "the gateway answered \"busy\" to a drain request" });
    // A refusal of the request itself.
    expect(await drainGatewayForStop({ call: gateway({ "gateway.suspend.prepare": [rpcError("INVALID_REQUEST")] }).call, requestId: ID, maxMs: 1_000, ...clock }))
      .toEqual({ kind: "unavailable", reason: "INVALID_REQUEST" });
  });

  it("rides out a retryable refusal mid-drain and asks again for a lease that lapsed", async () => {
    const clock = fakeClock();
    const gw = gateway({
      "gateway.suspend.prepare": [
        { status: "draining", suspensionId: "s1", activeCount: 1, retryAfterMs: 5_000 },
        { status: "draining", suspensionId: "s2", activeCount: 1, retryAfterMs: 5_000 },
      ],
      "gateway.suspend.status": [rpcError("UNAVAILABLE"), { status: "running" }, { status: "ready" }],
    });
    expect(await drainGatewayForStop({ call: gw.call, requestId: ID, maxMs: GATEWAY_DRAIN_MAX_MS, ...clock }))
      .toMatchObject({ kind: "ready", suspensionId: "s2" });
  });

  it("stops draining a gateway that has stopped answering, holding nothing", async () => {
    const clock = fakeClock();
    const gw = gateway({
      "gateway.suspend.prepare": [{ status: "draining", suspensionId: "s1", activeCount: 1, retryAfterMs: 5_000 }],
      "gateway.suspend.status": [new Error("connect ECONNREFUSED")],
    });
    expect(await drainGatewayForStop({ call: gw.call, requestId: ID, maxMs: GATEWAY_DRAIN_MAX_MS, ...clock }))
      .toEqual({ kind: "unavailable", reason: "connect ECONNREFUSED" });
  });
});
