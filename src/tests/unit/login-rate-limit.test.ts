import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// Each test gets its own DATA_DIR so persisted state doesn't leak.
let TEST_DIR: string;

vi.mock("@/lib/config-store", () => ({
  get DATA_DIR() {
    return TEST_DIR;
  },
}));

describe("login-rate-limit", () => {
  let lib: typeof import("@/lib/login-rate-limit");

  beforeEach(async () => {
    TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-ratelimit-"));
    vi.resetModules();
    lib = await import("@/lib/login-rate-limit");
    lib._resetForTest();
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  it("starts unlocked", async () => {
    const r = await lib.checkLockout("k1");
    expect(r.locked).toBe(false);
  });

  it("locks after 5 consecutive failures and reports a positive Retry-After", async () => {
    let last: import("@/lib/login-rate-limit").LockoutCheck = { locked: false, retryAfterSeconds: 0 };
    for (let i = 0; i < 5; i++) {
      last = await lib.recordFailure("k1");
    }
    expect(last.locked).toBe(true);
    expect(last.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("escalates the lock window at 10 failures", async () => {
    let after5: number = 0;
    let after10: number = 0;
    for (let i = 1; i <= 5; i++) {
      const r = await lib.recordFailure("k2");
      if (i === 5) after5 = r.retryAfterSeconds;
    }
    for (let i = 6; i <= 10; i++) {
      const r = await lib.recordFailure("k2");
      if (i === 10) after10 = r.retryAfterSeconds;
    }
    expect(after10).toBeGreaterThan(after5);
  });

  it("recordSuccess clears the counter for that key", async () => {
    for (let i = 0; i < 5; i++) await lib.recordFailure("k3");
    expect((await lib.checkLockout("k3")).locked).toBe(true);
    await lib.recordSuccess("k3");
    expect((await lib.checkLockout("k3")).locked).toBe(false);
  });

  it("isolates counters by key", async () => {
    for (let i = 0; i < 5; i++) await lib.recordFailure("attacker");
    expect((await lib.checkLockout("attacker")).locked).toBe(true);
    expect((await lib.checkLockout("owner")).locked).toBe(false);
  });

  it("persists state across module reloads", async () => {
    for (let i = 0; i < 5; i++) await lib.recordFailure("durable");
    // Drop the cached state and re-import — simulates a service restart.
    vi.resetModules();
    const reloaded = await import("@/lib/login-rate-limit");
    reloaded._resetForTest();
    const r = await reloaded.checkLockout("durable");
    expect(r.locked).toBe(true);
  });

  it("padResponseTime waits until the minimum elapsed", async () => {
    const start = Date.now();
    await lib.padResponseTime(start, 50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  it("padResponseTime is a no-op once the minimum has already elapsed", async () => {
    const fakeStart = Date.now() - 1000;
    const before = Date.now();
    await lib.padResponseTime(fakeStart, 50);
    expect(Date.now() - before).toBeLessThan(20);
  });
});
