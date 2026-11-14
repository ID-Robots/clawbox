import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { processStartKey } from "@/lib/process-identity";

// It starts a real process (`sleep`): both ceilings, as test-timeout-hygiene asks.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

/**
 * `processStartKey` is what lets a record say WHICH process a pid was — the
 * memory index's run record keeps it beside `childPid`, and with no time limit
 * on a pass it is the only thing that tells a run that is going from a record
 * whose pid another process has since been given.
 */
describe("processStartKey", () => {
  const procfs = existsSync("/proc/self/stat");

  it("answers nothing for a pid that names no process", () => {
    expect(processStartKey(0)).toBe("");
    expect(processStartKey(-1)).toBe("");
    expect(processStartKey(1.5)).toBe("");
    expect(processStartKey(Number.NaN)).toBe("");
  });

  it("names this process the same way every time it is asked", () => {
    const key = processStartKey(process.pid);
    expect(key).not.toBe("");
    expect(processStartKey(process.pid)).toBe(key);
  });

  it.runIf(procfs)("is the boot id and the start time, so neither a reboot nor a reused pid can pass for it", () => {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const [boot, ticks] = processStartKey(process.pid).split(":");
    expect(boot).toBe(bootId);
    expect(ticks).toMatch(/^\d+$/);
  });

  it("answers nothing once the process is gone", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const pid = child.pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    const alive = processStartKey(pid);
    expect(alive).not.toBe("");
    // The same process for as long as it runs.
    expect(processStartKey(pid)).toBe(alive);
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGKILL");
    await closed;
    // Collected by now: the pid names nothing — or, on a busy box, already
    // names something else, which is the one thing it must not be taken for.
    expect(processStartKey(pid)).not.toBe(alive);
  });
});
