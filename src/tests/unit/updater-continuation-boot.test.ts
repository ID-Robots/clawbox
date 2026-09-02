import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { armUpdateContinuation } from "@/instrumentation";

/**
 * The second half of an update — the system fixups, the Hermes
 * re-provisioning, the build-identity check — runs after the reboot, and only
 * once something calls `checkContinuation()`. The only caller was the status
 * route, so the update sat at "running" until somebody opened the Update page:
 * both test boxes waited six and a half hours after booting and then bounced
 * the gateway and the dashboard the moment a page was opened (2026-09-01). The
 * server has to ask on its own.
 *
 * The arming is a plain function with the check handed in, driven here with
 * fake timers. The wiring into `register()` is pinned by reading the boot file,
 * as the transcript sweep does: `register()` pulls its dependencies in through
 * `require()` to keep Node APIs out of the Edge bundle and is never called from
 * a test. What was missing was the WIRING, so the wiring is what this pins.
 */

const BOOT_DELAY_MS = 5_000;
// The call in register(), as distinct from the helper's own definition.
const BOOT_CALL = /armUpdateContinuation\(checkContinuation\)/;

describe("armUpdateContinuation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks the updater once the boot rush has passed, without any request", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const checkContinuation = vi.fn(async () => true);

    armUpdateContinuation(checkContinuation);
    expect(checkContinuation).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS - 1);
    expect(checkContinuation).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(checkContinuation).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("[Updater] continuation resumed at boot");

    // Once. A second ask would find the flag consumed anyway, but the log line
    // is what an owner greps for, so it must not repeat.
    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS * 10);
    expect(checkContinuation).toHaveBeenCalledTimes(1);
  });

  it("says nothing when there was no update to resume", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const checkContinuation = vi.fn(async () => false);

    armUpdateContinuation(checkContinuation, 10);
    await vi.advanceTimersByTimeAsync(10);

    expect(checkContinuation).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("logs a check that rejects instead of raising it into boot", async () => {
    // clawbox-setup.service is Restart=always: an unhandled rejection here
    // would be a crash loop, not a missed update step.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const checkContinuation = vi.fn(async () => {
      throw new Error("config unreadable");
    });

    armUpdateContinuation(checkContinuation, 10);
    await vi.advanceTimersByTimeAsync(10);

    expect(error).toHaveBeenCalledWith(expect.stringContaining("continuation"), "config unreadable");
  });

  it("logs a check that throws synchronously the same way", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const checkContinuation = vi.fn((): Promise<boolean> => {
      throw new Error("updater failed to load");
    });

    armUpdateContinuation(checkContinuation, 10);
    await vi.advanceTimersByTimeAsync(10);

    expect(error).toHaveBeenCalledWith(expect.stringContaining("continuation"), "updater failed to load");
  });

  it("does not keep the process alive for it", () => {
    const timer = armUpdateContinuation(async () => false);
    expect(timer.hasRef()).toBe(false);
    clearTimeout(timer);
  });
});

describe("boot arms the update continuation", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "instrumentation.ts"), "utf8");

  it("reaches for the updater's checkContinuation", () => {
    expect(source).toContain("lib/updater");
    expect(source).toMatch(BOOT_CALL);
  });

  it("keeps it behind the Node-runtime guard", () => {
    // `register` runs in both runtimes. The updater shells out and reads the
    // disk, so it has to sit after the edge early-return.
    const guard = source.indexOf("NEXT_RUNTIME === 'edge'");
    const call = source.search(BOOT_CALL);
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(guard);
  });

  it("does not let a failed load stop the box booting", () => {
    // The require() and the arming sit inside their own try/catch, like every
    // other boot hook: a broken updater module must cost the update its
    // second half, not the box its web server.
    const call = source.search(BOOT_CALL);
    const tryStart = source.lastIndexOf("try {", call);
    expect(tryStart).toBeGreaterThan(-1);
    const inside = source.slice(tryStart, call);
    expect(inside).toMatch(/require\(['"]\.\/lib\/updater['"]\)/);
    expect(inside).not.toContain("catch");
    const after = source.slice(call, call + 400);
    expect(after).toMatch(/\}\s*catch\s*\(/);
  });
});
