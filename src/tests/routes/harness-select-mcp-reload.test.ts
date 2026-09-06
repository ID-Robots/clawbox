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
const setActiveHarness = vi.fn(async (_harness: string) => "openclaw" as string);
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
/**
 * The identity sync, held open on demand.
 *
 * It runs `clawbox-identity-sync.sh` with a 60 s budget, and that is the window
 * two concurrent switches overlap in — so the interleaving case below has to be
 * able to stand two requests inside it at once and finish them in a chosen
 * order. Everything else runs it to completion immediately, as before.
 */
let holdSync = false;
const pendingSyncs: (() => void)[] = [];
vi.mock("child_process", () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    execFile();
    const finish = () => cb(null, { stdout: "", stderr: "" });
    if (holdSync) pendingSyncs.push(finish);
    else finish();
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
  holdSync = false;
  pendingSyncs.length = 0;
  getActiveHarness.mockResolvedValue("openclaw");
  setActiveHarness.mockResolvedValue("openclaw");
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

  it("still asks for the reload when two opposite switches overlap", async () => {
    // `previous` used to be read at the top of the handler, BEFORE an identity
    // sync with a 60 s budget. Two switches in opposite directions therefore
    // both saw the same predecessor: the second one persisted its harness and
    // then decided nothing had moved, so the box ended on one harness with the
    // agent still holding the other one's tools — for the rest of the session,
    // since nothing else restarts it. Reading the predecessor FROM THE WRITE
    // closes the window.
    let stored = "openclaw";
    getActiveHarness.mockImplementation(async () => stored);
    setActiveHarness.mockImplementation(async (harness: string) => {
      const replaced = stored;
      stored = harness;
      return replaced;
    });

    // Both requests are inside their identity sync before either persists.
    holdSync = true;
    const toHermes = post("hermes");
    const toOpenclaw = post("openclaw");
    await vi.waitFor(() => expect(pendingSyncs).toHaveLength(2));

    // Hermes lands first and really does flip the box.
    pendingSyncs[0]();
    await toHermes;
    // Then OpenClaw lands, and it flips it back — a real change, from hermes.
    pendingSyncs[1]();
    await toOpenclaw;

    expect(stored).toBe("openclaw");
    expect(setActiveHarness.mock.calls.map(([h]) => h)).toEqual(["hermes", "openclaw"]);
    // One reload for each real flip. The second is the one that used to be
    // skipped, and it is the one that leaves the agent matching the box.
    expect(dashboardRpc).toHaveBeenCalledTimes(2);
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
