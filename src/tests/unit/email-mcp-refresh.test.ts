import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
// `email_list`/`email_read` are registered on BOTH editions, but the only
// mechanism here is Hermes' dashboard socket — so the edition decides what a
// refused reload MEANS. Hermes unless a case says otherwise.
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));

import { refreshEmailToolsIfReadabilityChanged } from "@/lib/email-mcp-refresh";
import { dashboardRpc } from "@/lib/hermes-dashboard-rpc";
import { getActiveHarness } from "@/lib/harness";

const mockRpc = vi.mocked(dashboardRpc);
const mockHarness = vi.mocked(getActiveHarness);
let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ status: "ok" });
  mockHarness.mockReset();
  mockHarness.mockResolvedValue("hermes");
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
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

  it("does not report an OpenClaw box as broken for having no dashboard", async () => {
    // Same rule as the coding-agent sibling, and for the same reason: an
    // OpenClaw box has no dashboard BY DESIGN, so a refusal there is the
    // edition, not a fault. Its MCP server is spawned per session and reaped
    // when idle, so the tool list catches up on its own.
    mockHarness.mockResolvedValue("openclaw");
    mockRpc.mockResolvedValue(null);
    await refreshEmailToolsIfReadabilityChanged(false, true);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
  });

  it("still reports a HERMES box whose dashboard refused", async () => {
    mockHarness.mockResolvedValue("hermes");
    mockRpc.mockResolvedValue(null);
    await refreshEmailToolsIfReadabilityChanged(false, true);
    expect(errorSpy).toHaveBeenCalled();
  });
});
