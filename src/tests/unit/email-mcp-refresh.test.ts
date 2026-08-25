import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The narrow trigger that keeps `email_list`/`email_read` in step with the
 * owner's mailbox mode.
 *
 * The gate those two tools are registered behind is probed ONCE, when the MCP
 * server starts, so a mailbox connected under a running server never reaches the
 * agent. Asking Hermes to reload its MCP servers fixes that — and a reload
 * respawns every MCP child process and invalidates the model's prompt cache, so
 * the no-op case below is the load-bearing test: firing on saves that changed
 * nothing about readability would charge the owner for nothing, on every edit.
 */

vi.mock("@/lib/hermes-dashboard-rpc", () => ({ dashboardRpc: vi.fn() }));

import { refreshEmailToolsIfReadabilityChanged } from "@/lib/email-mcp-refresh";
import { dashboardRpc } from "@/lib/hermes-dashboard-rpc";

const mockRpc = vi.mocked(dashboardRpc);

beforeEach(() => {
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ status: "ok" });
});

describe("refreshEmailToolsIfReadabilityChanged", () => {
  it("does NOTHING when readability did not change", async () => {
    // The prompt cache is the reason this test exists. A password rotated in
    // place, a display name edited, an allowlist trimmed — none of them change
    // which tools the MCP server would register, and none of them may reload.
    await refreshEmailToolsIfReadabilityChanged(false, false);
    await refreshEmailToolsIfReadabilityChanged(true, true);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("reloads when the mailbox becomes readable", async () => {
    await refreshEmailToolsIfReadabilityChanged(false, true);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    // `confirm` is not decoration: the call is gated by
    // approvals.mcp_reload_confirm, which defaults to true, and without the flag
    // the dashboard answers `confirm_required` and does nothing.
    expect(mockRpc).toHaveBeenCalledWith("reload.mcp", { confirm: true });
  });

  it("reloads when the mailbox stops being readable", async () => {
    // The other direction matters just as much: tools left registered against a
    // mailbox that is gone answer 409 forever, which is what opens Hermes'
    // per-server circuit breaker and takes EVERY ClawBox tool offline.
    await refreshEmailToolsIfReadabilityChanged(true, false);
    expect(mockRpc).toHaveBeenCalledWith("reload.mcp", { confirm: true });
  });

  it("never sends a session id — the reload has to be global", async () => {
    await refreshEmailToolsIfReadabilityChanged(false, true);
    const params = mockRpc.mock.calls[0][1];
    expect(params).not.toHaveProperty("session_id");
  });

  it("does not throw when the dashboard cannot be reached", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRpc.mockResolvedValue(null);
    await expect(refreshEmailToolsIfReadabilityChanged(false, true)).resolves.toBeUndefined();
    // Logged, because "the agent still cannot see my mailbox" is otherwise
    // invisible from the outside.
    expect(errorSpy).toHaveBeenCalled();
  });

  it("does not throw when the RPC helper itself rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRpc.mockRejectedValue(new Error("socket exploded"));
    await expect(refreshEmailToolsIfReadabilityChanged(true, false)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});
