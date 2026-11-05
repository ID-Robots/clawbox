import { describe, expect, it, vi, beforeEach } from "vitest";

// GitHub #1269: what counts as agent work an update would kill.
vi.mock("@/lib/coding-agent", () => ({ runningCount: vi.fn(() => 0) }));
vi.mock("@/lib/openclaw-gateway-ws", () => ({
  gatewayWsActiveSessions: vi.fn(async () => ({ mainSessionKey: "main", sessionKeys: [] as string[] })),
}));

import { runningCount } from "@/lib/coding-agent";
import { gatewayWsActiveSessions } from "@/lib/openclaw-gateway-ws";
import { activeAgentWork } from "@/lib/update-busy";

describe("activeAgentWork", () => {
  beforeEach(() => {
    vi.mocked(runningCount).mockReturnValue(0);
    vi.mocked(gatewayWsActiveSessions).mockResolvedValue({ mainSessionKey: "main", sessionKeys: [] });
  });

  it("is idle when nothing runs", async () => {
    expect(await activeAgentWork()).toEqual({ coding: 0, agents: 0, total: 0 });
  });

  it("adds live coding runs and gateway sessions with an active run", async () => {
    vi.mocked(runningCount).mockReturnValue(2);
    vi.mocked(gatewayWsActiveSessions).mockResolvedValue({
      mainSessionKey: "main",
      sessionKeys: ["agent:main:main", "agent:main:subagent:x"],
    });
    expect(await activeAgentWork()).toEqual({ coding: 2, agents: 2, total: 4 });
  });

  it("asks the gateway with a short deadline", async () => {
    await activeAgentWork();
    expect(vi.mocked(gatewayWsActiveSessions).mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 3_000 });
  });

  it("counts a gateway that does not answer (stopped, booting, Hermes) as no work", async () => {
    vi.mocked(runningCount).mockReturnValue(1);
    vi.mocked(gatewayWsActiveSessions).mockRejectedValue(new Error("gateway connect timed out"));
    expect(await activeAgentWork()).toEqual({ coding: 1, agents: 0, total: 1 });
  });

  it("never throws when the coding agent cannot be read", async () => {
    vi.mocked(runningCount).mockImplementation(() => { throw new Error("runs file unreadable"); });
    expect(await activeAgentWork()).toEqual({ coding: 0, agents: 0, total: 0 });
  });
});
