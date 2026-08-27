import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The narrow trigger that keeps `coding_agent_run` / `_status` / `_stop` in step
 * with the owner's switch.
 *
 * The gate that family is registered behind is probed ONCE, when the MCP server
 * starts (`mcp/lib/context.ts` probeCodingAgent), and the server is a long-lived
 * stdio child of the agent — so a switch flipped underneath it never reaches the
 * tool list. Asking Hermes to reload its MCP servers fixes that, and a reload
 * respawns every MCP child and invalidates the model's prompt cache, so the
 * no-op cases below are the load-bearing ones: the enable route also carries the
 * effort, step-limit, token-ceiling and default-folder settings, and none of
 * those change which tools exist.
 */

vi.mock("@/lib/hermes-dashboard-rpc", () => ({ dashboardRpc: vi.fn() }));

import { refreshCodingAgentToolsIfReadinessChanged } from "@/lib/coding-agent-mcp-refresh";
import { dashboardRpc } from "@/lib/hermes-dashboard-rpc";

const mockRpc = vi.mocked(dashboardRpc);
let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ status: "ok" });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

describe("refreshCodingAgentToolsIfReadinessChanged", () => {
  it("does NOTHING when the verdict did not change", async () => {
    // The prompt cache is the reason this test exists. Switching on a box whose
    // harness is not installed leaves the family unavailable either way, and a
    // save that changes nothing the agent can see may not cost a reload.
    await refreshCodingAgentToolsIfReadinessChanged(false, false);
    await refreshCodingAgentToolsIfReadinessChanged(true, true);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("reloads when the family becomes available", async () => {
    await refreshCodingAgentToolsIfReadinessChanged(false, true);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    // `confirm` is not decoration: the call is gated by
    // approvals.mcp_reload_confirm, which defaults to true, and without the flag
    // the dashboard answers `confirm_required` and does nothing.
    expect(mockRpc).toHaveBeenCalledWith("reload.mcp", { confirm: true });
  });

  it("reloads when the family stops being available", async () => {
    // Tools left registered against a switch the owner turned off answer 409
    // forever, which is what opens Hermes' per-server circuit breaker and takes
    // EVERY ClawBox tool offline with it, not just these three.
    await refreshCodingAgentToolsIfReadinessChanged(true, false);
    expect(mockRpc).toHaveBeenCalledWith("reload.mcp", { confirm: true });
  });

  it("never sends a session id — the reload has to be global", async () => {
    await refreshCodingAgentToolsIfReadinessChanged(false, true);
    const params = mockRpc.mock.calls[0][1];
    expect(params).not.toHaveProperty("session_id");
  });

  it("does not throw when the dashboard cannot be reached", async () => {
    // An OpenClaw box has no dashboard at all, and the setting IS saved. The
    // worst case is a logged line and a tool list that catches up at the next
    // restart — the behaviour of every box before this existed.
    mockRpc.mockResolvedValue(null);
    await expect(refreshCodingAgentToolsIfReadinessChanged(false, true)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("does not throw when the RPC helper itself rejects", async () => {
    mockRpc.mockRejectedValue(new Error("socket exploded"));
    await expect(refreshCodingAgentToolsIfReadinessChanged(true, false)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("does not claim success when the dashboard refused", async () => {
    // The recurring shape: reporting success from a call that returned, without
    // checking what it returned. A refused reload has to read as a refusal.
    mockRpc.mockResolvedValue(null);
    await refreshCodingAgentToolsIfReadinessChanged(false, true);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
