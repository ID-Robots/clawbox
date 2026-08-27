import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Restarting the chat backend without root — and, far more importantly, NOT
 * restarting it when nothing is going to bring it back.
 *
 * The whole module is one dangerous verb behind one guard. `hermes dashboard
 * --stop` is the only unprivileged way to make the dashboard re-read its `.env`
 * and re-scan its plugins, because repo policy deliberately refuses a
 * `systemctl` sudoers grant over any Hermes unit — a `restart` grant would let
 * an OpenClaw box resurrect the dashboard its foreign-edition teardown just
 * disabled. So the stop is safe exactly when systemd promises to start it
 * again, and this suite is about that promise.
 */

const cliMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("child_process", () => ({ execFile: execFileMock }));

import { bounceHermesDashboard } from "@/lib/hermes-dashboard-control";

/** `systemctl show … --property=Restart --value` prints `value`. */
function systemdRestartPolicy(value: string): void {
  execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: unknown) => {
    (cb as (e: Error | null, out: { stdout: string; stderr: string }) => void)(null, {
      stdout: `${value}\n`,
      stderr: "",
    });
  });
}

/** The argv of the `systemctl` read, so the query itself can be asserted. */
function systemctlCall(): [string, string[]] {
  const [bin, args] = execFileMock.mock.calls[0] as [string, string[]];
  return [bin, args];
}

beforeEach(() => {
  cliMock.mockReset();
  execFileMock.mockReset();
  cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  systemdRestartPolicy("always");
});

describe("bounceHermesDashboard", () => {
  it("stops the dashboard when systemd promises to start it again", async () => {
    await expect(bounceHermesDashboard()).resolves.toBe(true);
    expect(cliMock).toHaveBeenCalledWith(["dashboard", "--stop"], expect.anything());
  });

  it("asks systemd BEFORE it stops anything", async () => {
    await bounceHermesDashboard();
    const [bin, args] = systemctlCall();
    // Absolute path, like every other systemctl call site in the repo, and a
    // READ — this module must never need a privilege it cannot have.
    expect(bin).toBe("/usr/bin/systemctl");
    expect(args).toEqual([
      "show",
      "clawbox-hermes-dashboard.service",
      "--property=Restart",
      "--value",
    ]);
  });

  it("refuses to stop a dashboard that nothing will restart", async () => {
    // A dev checkout running the dashboard by hand, or an older unit file. The
    // stop would leave the owner with no chat at all, which is far worse than
    // whatever staleness the caller was trying to clear.
    systemdRestartPolicy("no");
    await expect(bounceHermesDashboard()).resolves.toBe(false);
    expect(cliMock).not.toHaveBeenCalled();
  });

  it("refuses when systemd cannot be asked", async () => {
    // No systemd, no unit, a failed query: none of them is a promise, and the
    // answer that keeps the dashboard up is the same for all three.
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: unknown) => {
      (cb as (e: Error) => void)(new Error("no such unit"));
    });
    await expect(bounceHermesDashboard()).resolves.toBe(false);
    expect(cliMock).not.toHaveBeenCalled();
  });

  it("reports false when the stop itself did not take", async () => {
    cliMock.mockResolvedValue({ code: 1, stdout: "", stderr: "unkillable" });
    await expect(bounceHermesDashboard()).resolves.toBe(false);
  });

  it("does not throw when the CLI is missing entirely", async () => {
    cliMock.mockRejectedValue(new Error("ENOENT"));
    await expect(bounceHermesDashboard()).resolves.toBe(false);
  });
});
