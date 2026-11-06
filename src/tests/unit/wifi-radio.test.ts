import { describe, it, expect, vi } from "vitest";
import { promisify } from "node:util";


const execFile = vi.hoisted(() => vi.fn());
const spawn = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ execFile, spawn }));

describe("web radio ownership", () => {
  it("routes the live iw scan through the same radio lock", async () => {
    const { spawnWifiScan } = await import("@/lib/wifi-radio");
    spawnWifiScan();
    expect(spawn).toHaveBeenCalledWith("bash", [
      "/usr/local/libexec/clawbox/wifi-radio.sh", "--iw-scan",
    ]);
  });
  it("runs NM through the unprivileged installed lock helper, never sudo", async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "ok", ""));
    const { execWifiNmcli } = await import("@/lib/wifi-radio");
    await execWifiNmcli(["connection", "up", "Example-Home"], { timeout: 15000 });
    expect(execFile).toHaveBeenCalledWith("bash", [
      "/usr/local/libexec/clawbox/wifi-radio.sh", "--nmcli",
      "connection", "up", "Example-Home",
    ], expect.objectContaining({ timeout: 195000 }), expect.any(Function));
  });
  it("executes process kill, overlapping-owner, recovery and dispatcher regressions", async () => {
    const { execFile: realExecFile } = await vi.importActual<typeof import("child_process")>("child_process");
    const { stdout, stderr } = await promisify(realExecFile)("python3", [
      "scripts/tests/test_wifi_radio_transaction.py",
    ], { timeout: 30000 });
    expect(stdout + stderr).toContain("OK");
  }, 35000);
});
