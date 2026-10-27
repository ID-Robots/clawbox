/**
 * The memory caps a unit gets are a share of the board's RAM, not a literal.
 *
 * The box ships the same image on an 8 GB Orin Nano, a 16 GB x64 laptop and a
 * 128 GB DGX Spark. The numbers used to be hardcoded (an app had none at all, a
 * run had 3G/4G); this pins the scale, the floors that keep a small board
 * usable, and the env overrides an operator can use without a rebuild.
 */
import { describe, expect, it } from "vitest";
import { appMemoryLimits, parseSystemdSize, runMemoryLimits, systemdSize } from "@/lib/box-memory-policy";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const noEnv: Record<string, string | undefined> = {};

describe("systemdSize", () => {
  it("prints whole gigabytes as G and anything else in M", () => {
    expect(systemdSize(2 * GIB)).toBe("2G");
    expect(systemdSize(768 * MIB)).toBe("768M");
    expect(systemdSize(1536 * MIB)).toBe("1536M");
  });
});

describe("parseSystemdSize", () => {
  it("reads the sizes an operator would write, and refuses the rest", () => {
    expect(parseSystemdSize("4G")).toBe(4 * GIB);
    expect(parseSystemdSize("1536M")).toBe(1536 * MIB);
    expect(parseSystemdSize("512m")).toBe(512 * MIB);
    for (const bad of ["", "0G", "4 GiB", "4GB", "-1G", "G", undefined]) expect(parseSystemdSize(bad)).toBeNull();
  });
});

describe("runMemoryLimits", () => {
  it("keeps the 3G/4G a 16 GB box has today", () => {
    const limits = runMemoryLimits(16 * GIB, noEnv);
    expect(limits.max).toBe("4G");
    expect(limits.high).toBe("3G");
  });

  it("floors an 8 GB board at 3G rather than a quarter of it", () => {
    const limits = runMemoryLimits(8 * GIB, noEnv);
    expect(limits.max).toBe("3G");
    // 75% of the cap, but never below 1G even where the share would be.
    expect(limits.high).toBe("2304M");
  });

  it("grows on a big box, up to the ceiling", () => {
    expect(runMemoryLimits(64 * GIB, noEnv).max).toBe("16G");
    expect(runMemoryLimits(128 * GIB, noEnv).max).toBe("16G");
  });

  it("takes an operator's override, and ignores one that does not parse", () => {
    expect(runMemoryLimits(16 * GIB, { CLAWBOX_RUN_MEMORY_MAX: "6G" }).max).toBe("6G");
    expect(runMemoryLimits(16 * GIB, { CLAWBOX_RUN_MEMORY_MAX: "6GB" }).max).toBe("4G");
  });

  it("never lets a high above its max become the cap", () => {
    const limits = runMemoryLimits(16 * GIB, { CLAWBOX_RUN_MEMORY_MAX: "2G", CLAWBOX_RUN_MEMORY_HIGH: "8G" });
    expect(limits.max).toBe("2G");
    expect(limits.highBytes).toBeLessThanOrEqual(limits.maxBytes);
  });
});

describe("appMemoryLimits", () => {
  it("caps an app at a quarter of what a run may have on the same box", () => {
    const run = runMemoryLimits(16 * GIB, noEnv);
    const app = appMemoryLimits(16 * GIB, noEnv);
    expect(app.max).toBe("2G");
    expect(app.high).toBe("768M");
    expect(app.maxBytes * 2).toBe(run.maxBytes);
  });

  it("floors an 8 GB board at 768M with a high that still lets it work", () => {
    const app = appMemoryLimits(8 * GIB, noEnv);
    expect(app.max).toBe("1G");
    expect(app.high).toBe("512M");
  });

  it("does not run away on a 128 GB Spark", () => {
    expect(appMemoryLimits(128 * GIB, noEnv).max).toBe("6G");
  });
});
