import { beforeEach, describe, expect, it, vi } from "vitest";

// The busy gate's real reads (issue #1269), with the gateway socket and the
// coding agent's store replaced: a unit test must never reach a real gateway.
const { mockGatewayWsCall, mockRunningCount } = vi.hoisted(() => ({
  mockGatewayWsCall: vi.fn(),
  mockRunningCount: vi.fn(() => 0),
}));
vi.mock("@/lib/openclaw-gateway-ws", () => ({ gatewayWsCall: mockGatewayWsCall }));
vi.mock("@/lib/coding-agent", () => ({ runningCount: mockRunningCount }));

import { activeAgentWork, gatewayCall, resumeGatewayAdmission } from "@/lib/update-busy-server";

const rpcError = (code: string) => Object.assign(new Error(code), { name: "GatewayRpcError", code });

describe("activeAgentWork", () => {
  beforeEach(() => {
    mockGatewayWsCall.mockReset();
    mockRunningCount.mockReset().mockReturnValue(0);
  });

  it("adds the gateway's active sessions to the coding agent's running count", async () => {
    mockGatewayWsCall.mockResolvedValue({
      sessions: [
        { key: "agent:main:main", hasActiveRun: true },
        { key: "agent:main:subagent:1", hasActiveRun: true },
      ],
    });
    mockRunningCount.mockReturnValue(1);
    expect(await activeAgentWork()).toEqual({ agentRuns: 1, subagentRuns: 1, codingRuns: 1, total: 3 });
    expect(mockGatewayWsCall).toHaveBeenCalledWith("sessions.list", { activeOnly: true }, { timeoutMs: 5_000 });
  });

  it("asks for the plain list when the gateway refuses the activeOnly filter", async () => {
    mockGatewayWsCall
      .mockRejectedValueOnce(rpcError("INVALID_REQUEST"))
      .mockResolvedValueOnce({ sessions: [{ key: "agent:main:main", hasActiveRun: true }, { key: "agent:main:x", hasActiveRun: false }] });
    expect(await activeAgentWork()).toMatchObject({ agentRuns: 1, total: 1 });
    expect(mockGatewayWsCall.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ["sessions.list", { activeOnly: true }],
      ["sessions.list", {}],
    ]);
  });

  it("counts nothing for a gateway that is not there to ask, and still counts coding runs", async () => {
    mockGatewayWsCall.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { name: "GatewayWsUnavailableError" }));
    mockRunningCount.mockReturnValue(2);
    expect(await activeAgentWork()).toEqual({ agentRuns: 0, subagentRuns: 0, codingRuns: 2, total: 2 });
    expect(mockGatewayWsCall).toHaveBeenCalledTimes(1);
  });
});

describe("gatewayCall", () => {
  it("gives the drain's own calls longer than the 15 s the core may hold them, and reads 5 s", async () => {
    mockGatewayWsCall.mockReset().mockResolvedValue({});
    await gatewayCall("gateway.suspend.status", { suspensionId: "s1" });
    await gatewayCall("gateway.suspend.prepare", { requestId: "r" });
    await gatewayCall("sessions.list", {});
    expect(mockGatewayWsCall.mock.calls.map(([method, , options]) => [method, options])).toEqual([
      ["gateway.suspend.status", { timeoutMs: 30_000 }],
      ["gateway.suspend.prepare", { timeoutMs: 30_000 }],
      ["sessions.list", { timeoutMs: 5_000 }],
    ]);
  });
});

describe("resumeGatewayAdmission", () => {
  it("asks the gateway to reopen admission, and stays quiet when it cannot", async () => {
    mockGatewayWsCall.mockReset().mockResolvedValueOnce({ ok: true, status: "running", resumed: true });
    await resumeGatewayAdmission("s1");
    expect(mockGatewayWsCall).toHaveBeenCalledWith("gateway.suspend.resume", { suspensionId: "s1" }, { timeoutMs: 30_000 });
    mockGatewayWsCall.mockRejectedValueOnce(rpcError("INVALID_REQUEST"));
    await expect(resumeGatewayAdmission("gone")).resolves.toBeUndefined();
  });
});
