/**
 * A coding run's share of the CPU (src/lib/coding-run-cpu.ts) and the scope
 * properties beside it (src/lib/coding-run-unit.ts): the budget a run is told
 * to keep its builds and tests to, the battery reading that caps a team to one
 * worker, and the brief that names the budget by each runner's own flag.
 *
 * Why it exists: a team of three pushed a 4-core/8-thread laptop to load 27.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  cpuBudgetBrief,
  hostCpuCount,
  isOnBattery,
  MAX_CPU_BUDGET,
  onBatteryPower,
  RUN_CPU_BUDGET_ENV,
  runCpuBudget,
  teamWorkerCap,
} from "@/lib/coding-run-cpu";
import { readBattery } from "@/lib/battery";
import { buildScopeArgv, RUN_CPU_WEIGHT, RUN_IO_WEIGHT, RUN_NICE } from "@/lib/coding-run-unit";

describe("the budget", () => {
  it("gives a lone run half the logical CPUs — the physical cores on an SMT laptop", () => {
    expect(runCpuBudget({ cpus: 8 })).toBe(4);
    expect(runCpuBudget({ cpus: 4 })).toBe(2);
    expect(runCpuBudget({ cpus: 6 })).toBe(3);
  });

  it("shares that half between the runs going at once", () => {
    // The laptop that hit load 27: three workers, eight threads.
    expect(runCpuBudget({ cpus: 8, concurrent: 3 })).toBe(1);
    expect(runCpuBudget({ cpus: 8, concurrent: 2 })).toBe(2);
    expect(runCpuBudget({ cpus: 16, concurrent: 2 })).toBe(4);
  });

  it("halves again on battery", () => {
    expect(runCpuBudget({ cpus: 8, onBattery: true })).toBe(2);
    expect(runCpuBudget({ cpus: 16, onBattery: true })).toBe(4);
  });

  it("never goes below one job, whatever it is handed", () => {
    expect(runCpuBudget({ cpus: 1 })).toBe(1);
    expect(runCpuBudget({ cpus: 2, concurrent: 5, onBattery: true })).toBe(1);
    expect(runCpuBudget({ cpus: Number.NaN })).toBe(1);
    expect(runCpuBudget({ cpus: 0, concurrent: 0 })).toBe(1);
    expect(runCpuBudget({ cpus: 8, concurrent: -3 })).toBe(4);
  });

  it("is bounded for a record a hand could have edited", () => {
    expect(runCpuBudget({ cpus: 10_000 })).toBe(MAX_CPU_BUDGET);
  });

  it("counts the box's own CPUs as at least one", () => {
    const n = hostCpuCount();
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(1);
  });
});

describe("the brief", () => {
  it("names the budget, the variable it is in, and each common runner's own flag", () => {
    const brief = cpuBudgetBrief(2);
    expect(brief).toContain("CPU budget: 2 parallel jobs");
    expect(brief).toContain(`$${RUN_CPU_BUDGET_ENV}`);
    expect(brief).toContain("--maxWorkers=2");
    expect(brief).toContain("make -j2");
    expect(brief).toContain("-n 2");
    expect(brief).toMatch(/one heavy command at a time/i);
  });

  it("says one job in the singular", () => {
    expect(cpuBudgetBrief(1)).toContain("CPU budget: 1 parallel job ");
    expect(cpuBudgetBrief(0)).toContain("--maxWorkers=1");
  });
});

describe("on battery", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  /** A power_supply class directory the way sysfs lays it out. */
  function sysfs(supplies: Record<string, Record<string, string>>): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "power-supply-"));
    for (const [name, attrs] of Object.entries(supplies)) {
      fs.mkdirSync(path.join(dir, name));
      for (const [attr, value] of Object.entries(attrs)) fs.writeFileSync(path.join(dir, name, attr), `${value}\n`);
    }
    return dir;
  }

  it("is the charger's `online` 0 — on battery — and its 1 — plugged in", async () => {
    const unplugged = sysfs({ AC: { type: "Mains", online: "0" }, BAT0: { type: "Battery", capacity: "80", status: "Discharging" } });
    expect(await onBatteryPower(() => readBattery({ root: unplugged, arch: "x64" }))).toBe(true);
    fs.writeFileSync(path.join(unplugged, "AC", "online"), "1\n");
    expect(await onBatteryPower(() => readBattery({ root: unplugged, arch: "x64" }))).toBe(false);
  });

  it("counts a USB-C charger that is online as plugged in", async () => {
    const usb = sysfs({ AC: { type: "Mains", online: "0" }, "ucsi-source-psy-USBC000:002": { type: "USB", online: "1" }, BAT0: { type: "Battery", capacity: "80", status: "Charging" } });
    expect(await onBatteryPower(() => readBattery({ root: usb, arch: "x64" }))).toBe(false);
  });

  it("is never on battery without a battery — a Jetson, a desktop PC — or when nothing can be read", async () => {
    const desktop = sysfs({ AC: { type: "Mains", online: "0" } });
    expect(await onBatteryPower(() => readBattery({ root: desktop, arch: "x64" }))).toBe(false);
    expect(await onBatteryPower(() => readBattery({ root: "/nonexistent-power-supply", arch: "x64" }))).toBe(false);
    expect(await onBatteryPower(async () => { throw new Error("sysfs gone"); })).toBe(false);
  });

  it("falls back to a discharging battery when no supply reports `online`", () => {
    expect(isOnBattery({ available: true, percent: 50, state: "discharging", acOnline: null, minutesLeft: null })).toBe(true);
    expect(isOnBattery({ available: true, percent: 50, state: "charging", acOnline: null, minutesLeft: null })).toBe(false);
    expect(isOnBattery({ available: false })).toBe(false);
  });

  it("caps a team to one worker at a time, and leaves the plan's number alone on mains", () => {
    expect(teamWorkerCap(3, true)).toBe(1);
    expect(teamWorkerCap(3, false)).toBe(3);
    expect(teamWorkerCap(1, false)).toBe(1);
    expect(teamWorkerCap(0, false)).toBe(1);
  });
});

describe("the scope", () => {
  it("asks for a lower CPU and I/O weight and a nice level than everything else on the box", () => {
    expect(RUN_CPU_WEIGHT).toBeLessThan(100);
    expect(RUN_IO_WEIGHT).toBeLessThan(100);
    expect(RUN_NICE).toBeGreaterThan(0);
    const { argv } = buildScopeArgv("/usr/bin/systemd-run", "clawbox-run-abc.scope", "/usr/bin/setpriv", ["--", "claude-ds"]);
    const prefix = argv.slice(0, argv.indexOf("--"));
    expect(prefix).toContain(`CPUWeight=${RUN_CPU_WEIGHT}`);
    expect(prefix).toContain(`IOWeight=${RUN_IO_WEIGHT}`);
    expect(prefix).toContain(`--nice=${RUN_NICE}`);
    // Each property is its own `-p`, which is the form systemd-run reads.
    expect(prefix[prefix.indexOf(`CPUWeight=${RUN_CPU_WEIGHT}`) - 1]).toBe("-p");
    expect(prefix[prefix.indexOf(`IOWeight=${RUN_IO_WEIGHT}`) - 1]).toBe("-p");
  });
});
