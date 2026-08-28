import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `reloadMcpServers()` has to report the DASHBOARD'S VERDICT, not the fact that
 * a frame came back.
 *
 * The whole point of the helper is that three families — the mailbox read tools
 * (#486), the image tools (#503) and the coding-agent family (#514) — are
 * registered off a probe the MCP server runs ONCE at boot, and the only way to
 * make a running agent re-probe is Hermes' `reload.mcp`. That call is gated by
 * `approvals.mcp_reload_confirm`, and a dashboard that wants a confirmation
 * answers `{ status: "confirm_required" }` AND DOES NOTHING. It is a perfectly
 * ordinary, non-error reply, so a helper that reads "not null" as "it worked"
 * logs "asked the agent to reload its MCP servers" over a box whose tool list
 * never moved — and the one line that would have told an operator the bug is
 * still happening is the line that says it isn't.
 */

vi.mock("@/lib/hermes-dashboard-rpc", () => ({ dashboardRpc: vi.fn() }));

import { reloadMcpServers } from "@/lib/hermes-mcp-reload";
import { dashboardRpc } from "@/lib/hermes-dashboard-rpc";

const mockRpc = vi.mocked(dashboardRpc);

beforeEach(() => {
  mockRpc.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reloadMcpServers", () => {
  it("reports the documented confirmation gate as a refusal", async () => {
    // The reply this module's own RELOAD_PARAMS doc describes: the dashboard
    // asked rather than acted.
    mockRpc.mockResolvedValue({ status: "confirm_required" });
    await expect(reloadMcpServers()).resolves.toBe(false);
  });

  it("reports any other named non-acting status as a refusal", async () => {
    for (const status of ["error", "denied", "unauthorized", "busy"]) {
      mockRpc.mockResolvedValue({ status });
      await expect(reloadMcpServers()).resolves.toBe(false);
    }
  });

  it("still reports a plain acknowledgement as success", async () => {
    mockRpc.mockResolvedValue({ status: "ok" });
    await expect(reloadMcpServers()).resolves.toBe(true);
  });

  it("accepts the synonyms a reload can acknowledge with", async () => {
    for (const status of ["reloaded", "success", "completed", "OK", " ok "]) {
      mockRpc.mockResolvedValue({ status });
      await expect(reloadMcpServers()).resolves.toBe(true);
    }
  });

  it("does not invent a refusal out of a reply that names no status", async () => {
    // The historical shape, and the one this helper has always read as success.
    // Only a reply that NAMES a state is allowed to contradict it — otherwise a
    // dashboard that answers `{}` or `true` would start reporting a refusal that
    // did not happen, which is the false alarm the sibling helpers are careful
    // to avoid.
    for (const result of [{}, { servers: 3 }, true, "reloaded"]) {
      mockRpc.mockResolvedValue(result);
      await expect(reloadMcpServers()).resolves.toBe(true);
    }
  });

  it("still reports a transport failure as a refusal", async () => {
    mockRpc.mockResolvedValue(null);
    await expect(reloadMcpServers()).resolves.toBe(false);
    mockRpc.mockRejectedValue(new Error("socket exploded"));
    await expect(reloadMcpServers()).resolves.toBe(false);
  });
});
