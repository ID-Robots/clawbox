import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { armMemoryStatusWarm } from "@/instrumentation";

/**
 * The boot-time memory-status warm boots an OpenClaw process against the v2
 * SQLite store 45 s after start. The second half of an update is resumed from
 * boot now, and it runs post_update against that same store with the gateway
 * masked and stopped so there is ONE writer — the warm would have been a
 * second one on every first boot after an update ("database is locked", and
 * the fixups, non-fatal by design, silently skipped). So the warm asks the
 * updater first and stands down while an update owns the box.
 *
 * Driven here with fake timers through the plain helper; the wiring into
 * `register()` is pinned by reading the boot file, as the other hooks are.
 */

const WARM_DELAY_MS = 45_000;
const BOOT_CALL = /armMemoryStatusWarm\(\{ warm: warmMemoryStatusCache, updateInFlight \}\)/;

describe("armMemoryStatusWarm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("warms once the boot rush has passed on a box with no update in flight", async () => {
    const warm = vi.fn(async () => {});
    const updateInFlight = vi.fn(async () => false);

    armMemoryStatusWarm({ warm, updateInFlight });
    await vi.advanceTimersByTimeAsync(WARM_DELAY_MS - 1);
    expect(warm).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(updateInFlight).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("stands down while an update owns the box", async () => {
    const warm = vi.fn(async () => {});
    const updateInFlight = vi.fn(async () => true);

    armMemoryStatusWarm({ warm, updateInFlight, delayMs: 10 });
    await vi.advanceTimersByTimeAsync(10);

    expect(updateInFlight).toHaveBeenCalledTimes(1);
    expect(warm).not.toHaveBeenCalled();
  });

  it("stands down when it cannot tell", async () => {
    // Better one slow Settings open than a second writer on the store.
    const warm = vi.fn(async () => {});
    const updateInFlight = vi.fn(async (): Promise<boolean> => {
      throw new Error("config unreadable");
    });

    armMemoryStatusWarm({ warm, updateInFlight, delayMs: 10 });
    await vi.advanceTimersByTimeAsync(10);

    expect(warm).not.toHaveBeenCalled();
  });

  it("swallows a failed probe — the first reader retries", async () => {
    const warm = vi.fn(async () => {
      throw new Error("memory status unavailable");
    });

    armMemoryStatusWarm({ warm, updateInFlight: async () => false, delayMs: 10 });
    await expect(vi.advanceTimersByTimeAsync(10)).resolves.not.toThrow();
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("does not keep the process alive for it", () => {
    const timer = armMemoryStatusWarm({ warm: async () => {}, updateInFlight: async () => false });
    expect(timer.hasRef()).toBe(false);
    clearTimeout(timer);
  });
});

describe("boot arms the memory-status warm behind the update gate", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "instrumentation.ts"), "utf8");

  it("hands the helper the real probe and the updater's gate", () => {
    expect(source).toMatch(BOOT_CALL);
    const call = source.search(BOOT_CALL);
    const tryStart = source.lastIndexOf("try {", call);
    const inside = source.slice(tryStart, call);
    expect(inside).toMatch(/require\(['"]\.\/lib\/clawkeep-memory['"]\)/);
    expect(inside).toMatch(/require\(['"]\.\/lib\/updater['"]\)/);
  });

  it("keeps it off the Hermes edition", () => {
    // There is no openclaw to probe there; the guard has to come first.
    const guard = source.indexOf("if (!openclawIsAbsent())");
    const call = source.search(BOOT_CALL);
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(guard);
  });
});
