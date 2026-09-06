import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The fifth boot-time snapshot, and the biggest: WHICH HARNESS IS ACTIVE.
 *
 * `mcp/lib/edition.ts` resolves it once while the ClawBox MCP stdio child
 * boots, and that one answer decides which harness's built-in apps
 * `ui_open_app`/`ui_list_apps` offer, which tool families are registered at
 * all, what `device_status` calls the agent and which field guide
 * `clawbox_context` serves. `/setup-api/harness/select` deliberately does not
 * bounce the other gateway, so on the dual SKU nothing told that child — and
 * `ui_open_app("hermes")` went on answering "There is no such app on this
 * ClawBox" for the box's own dashboard until the next MCP restart (TASK-715,
 * TASK-541's symptom returning through the switch).
 *
 * The mechanism is the harness's own `reload.mcp`, shared with the four
 * siblings; what is pinned here is the RULE for when it is worth paying for.
 */

const rpcMock = vi.hoisted(() => vi.fn());
const activeHarnessMock = vi.hoisted(() => vi.fn(async () => "hermes" as string));

vi.mock("@/lib/hermes-dashboard-rpc", () => ({ dashboardRpc: rpcMock }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: activeHarnessMock }));

import { refreshHarnessToolsIfSwitched } from "@/lib/harness-mcp-refresh";

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  rpcMock.mockReset();
  activeHarnessMock.mockReset();
  activeHarnessMock.mockResolvedValue("hermes");
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("the agent's tool list, after the owner switches harness", () => {
  it("asks the harness to rebuild it when the harness really moved", async () => {
    rpcMock.mockResolvedValue({ status: "ok" });

    await expect(refreshHarnessToolsIfSwitched("openclaw", "hermes")).resolves.toBe(true);
    expect(rpcMock).toHaveBeenCalledWith("reload.mcp", { confirm: true });
  });

  it("asks in the other direction too", async () => {
    rpcMock.mockResolvedValue({ status: "ok" });

    await expect(refreshHarnessToolsIfSwitched("hermes", "openclaw")).resolves.toBe(true);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("costs nothing when the owner re-selects the harness already running", async () => {
    // A reload respawns every MCP child and invalidates the model's prompt
    // cache, so the next turn re-pays for a system prompt that was cached. A
    // save that changed nothing the agent can see must not buy that.
    await expect(refreshHarnessToolsIfSwitched("hermes", "hermes")).resolves.toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("says so rather than reporting a reload the dashboard refused", async () => {
    // `confirm_required` is an ordinary non-error reply that means NOTHING
    // HAPPENED — the false-success shape the shared helper exists to catch.
    rpcMock.mockResolvedValue({ status: "confirm_required" });

    await expect(refreshHarnessToolsIfSwitched("openclaw", "hermes")).resolves.toBe(false);
  });

  it("never throws when there is no dashboard to ask", async () => {
    rpcMock.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(refreshHarnessToolsIfSwitched("openclaw", "hermes")).resolves.toBe(false);
  });
});
