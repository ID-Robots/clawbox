import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Switching the harness has to reach the agent's own tool list (TASK-715).
 *
 * The ClawBox MCP server resolves which harness is active ONCE, when its stdio
 * child boots, and registers whole tool families and the built-in app list off
 * that answer. This route deliberately does not bounce the other gateway, so on
 * the dual SKU nothing told that child the harness had moved: `ui_open_app`
 * answered "There is no such app on this ClawBox" for the box's own dashboard
 * until the next MCP restart, while `clawbox app open` from the same agent's
 * shell succeeded — a CLI run is its own startup.
 */

const getActiveHarness = vi.fn(async () => "openclaw" as string);
const setActiveHarness = vi.fn(async (_harness: string) => {});
const harnessHealthy = vi.fn(async () => true);
vi.mock("@/lib/harness", () => ({
  getActiveHarness: () => getActiveHarness(),
  setActiveHarness: (h: string) => setActiveHarness(h),
  harnessHealthy: () => harnessHealthy(),
  isHarness: (h: unknown) => h === "openclaw" || h === "hermes",
  isSingleHarnessEdition: () => false,
}));

const dashboardRpc = vi.fn(async (_method: string, _params?: unknown) => ({ status: "ok" }) as unknown);
vi.mock("@/lib/hermes-dashboard-rpc", () => ({ dashboardRpc: (m: string, p: unknown) => dashboardRpc(m, p) }));

const execFile = vi.fn();
vi.mock("child_process", () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    execFile();
    cb(null, { stdout: "", stderr: "" });
  },
}));

import { POST } from "@/app/setup-api/harness/select/route";

function post(harness: string) {
  return POST(new Request("http://localhost/setup-api/harness/select", {
    method: "POST",
    body: JSON.stringify({ harness }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  getActiveHarness.mockResolvedValue("openclaw");
  harnessHealthy.mockResolvedValue(true);
  dashboardRpc.mockResolvedValue({ status: "ok" });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("POST /setup-api/harness/select", () => {
  it("asks the harness to rebuild its MCP tool list after a real switch", async () => {
    const res = await post("hermes");

    expect(res.status).toBe(200);
    expect(setActiveHarness).toHaveBeenCalledWith("hermes");
    expect(dashboardRpc).toHaveBeenCalledWith("reload.mcp", { confirm: true });
  });

  it("asks for nothing when the owner re-selects the harness already running", async () => {
    // The reload respawns every MCP child and invalidates the model's prompt
    // cache; a save that moved nothing must not buy that.
    const res = await post("openclaw");

    expect(res.status).toBe(200);
    expect(dashboardRpc).not.toHaveBeenCalled();
  });

  it("still reports the switch when the box has no dashboard to ask", async () => {
    // The selection is persisted before the refresh runs, and a best-effort
    // reload must never turn a switch that succeeded into an error.
    dashboardRpc.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await post("hermes");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, active: "hermes" });
  });
});
