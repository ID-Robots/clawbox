import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The switch and the "start over" behind Memory Shard's settings page.
 *
 * What these pin down is that OFF is a real state of the box rather than a
 * remembered checkbox: the enable route re-arms (or disarms) the in-process
 * scheduler in the same request, and the reset route writes an EXPLICIT false
 * for both flags — an absent completion flag falls back to the switch, so a
 * reset that merely deleted it would never bring the wizard back.
 */

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-memory-enable-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "clawkeep");
const SCHEDULE_PATH = path.join(DATA_DIR, "memory-index-schedule.json");

// The scheduler is stubbed so the suite leaks no timer, and so the re-arm can
// be asserted: a switch that only took effect at the next reboot is exactly
// the half-applied setting this route exists to rule out.
vi.mock("@/lib/clawkeep-memory-scheduler", () => ({
  start: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}),
  nextRunAtMs: vi.fn(() => 0),
}));

const { ownerSession } = vi.hoisted(() => ({ ownerSession: { value: true } }));
vi.mock("@/lib/owner-session", () => ({
  hasOwnerSession: vi.fn(async () => ownerSession.value),
}));

// The one write in a reset that a full or read-only disk can refuse. Faked
// rather than provoked, because what is under test is the ORDER the reset
// writes in, not what ENOSPC looks like.
const { scheduleWrite } = vi.hoisted(() => ({ scheduleWrite: { fail: false } }));
vi.mock("@/lib/clawkeep-memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clawkeep-memory")>();
  return {
    ...actual,
    writeMemorySchedule: async (value: unknown) => {
      if (scheduleWrite.fail) throw new Error("ENOSPC");
      return actual.writeMemorySchedule(value);
    },
  };
});

let enablePOST: typeof import("@/app/setup-api/clawkeep/memory/enable/route").POST;
let resetPOST: typeof import("@/app/setup-api/clawkeep/memory/reset/route").POST;
let scheduler: typeof import("@/lib/clawkeep-memory-scheduler");
let shard: typeof import("@/lib/memory-shard");
let config: typeof import("@/lib/config-store");
let previousRoot: string | undefined;

beforeAll(async () => {
  // A root of this file's own: config-store resolves it at import time and its
  // file is otherwise shared with every other test in the worker.
  previousRoot = process.env.CLAWBOX_ROOT;
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  process.env.CLAWKEEP_DATA_DIR = DATA_DIR;
  await fs.mkdir(DATA_DIR, { recursive: true });
  enablePOST = (await import("@/app/setup-api/clawkeep/memory/enable/route")).POST;
  resetPOST = (await import("@/app/setup-api/clawkeep/memory/reset/route")).POST;
  scheduler = await import("@/lib/clawkeep-memory-scheduler");
  shard = await import("@/lib/memory-shard");
  config = await import("@/lib/config-store");
});

afterAll(async () => {
  if (previousRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = previousRoot;
  delete process.env.CLAWKEEP_DATA_DIR;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  ownerSession.value = true;
  scheduleWrite.fail = false;
  await fs.rm(path.join(TEST_ROOT, "data", "config.json"), { force: true });
  await fs.rm(SCHEDULE_PATH, { force: true });
});

function post(url: string, body?: unknown): Request {
  return new Request(`http://localhost/setup-api/clawkeep/memory/${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("POST /setup-api/clawkeep/memory/enable", () => {
  it("disarms the scheduler in the same request as it writes the switch off", async () => {
    await shard.setMemoryShardEnabled(true);
    const res = await enablePOST(post("enable", { enabled: false }));
    expect(res.status).toBe(200);
    expect((await res.json()).enabled).toBe(false);
    expect(await shard.getMemoryShardEnabled()).toBe(false);
    expect(scheduler.refresh).toHaveBeenCalledTimes(1);
  });

  it("re-arms the schedule the owner already saved when the switch goes back on", async () => {
    const res = await enablePOST(post("enable", { enabled: true }));
    expect((await res.json()).enabled).toBe(true);
    expect(scheduler.refresh).toHaveBeenCalledTimes(1);
  });

  it("leaves the scheduler alone when only the wizard flag is written", async () => {
    // The wizard writes the flag with the switch; a body that carries the flag
    // alone changes nothing about when the box indexes.
    const res = await enablePOST(post("enable", { setupComplete: true }));
    expect((await res.json()).setupComplete).toBe(true);
    expect(scheduler.refresh).not.toHaveBeenCalled();
  });
});

describe("POST /setup-api/clawkeep/memory/reset", () => {
  it("switches off, clears the schedule and puts the wizard back", async () => {
    await shard.setMemoryShardEnabled(true);
    await shard.setMemoryShardSetupComplete(true);
    await fs.writeFile(SCHEDULE_PATH, JSON.stringify({
      enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0,
    }));

    const res = await resetPOST(post("reset"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, setupComplete: false });

    // EXPLICIT false, not a deleted key: an absent flag falls back to the
    // switch, and a box that had been switched on would then still believe it
    // had finished setup.
    expect(await config.get("memory_shard_setup_complete")).toBe(false);
    expect(await shard.getMemoryShardSetupComplete()).toBe(false);
    expect(await shard.getMemoryShardEnabled()).toBe(false);
    expect(JSON.parse(await fs.readFile(SCHEDULE_PATH, "utf8")).enabled).toBe(false);
    expect(scheduler.refresh).toHaveBeenCalledTimes(1);
  });

  it("leaves the box as it was, and says so, when the schedule cannot be written", async () => {
    await shard.setMemoryShardEnabled(true);
    await shard.setMemoryShardSetupComplete(true);
    await fs.writeFile(SCHEDULE_PATH, JSON.stringify({
      enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0,
    }));
    scheduleWrite.fail = true;

    const res = await resetPOST(post("reset"));
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).kind).toBe("write_failed");

    // The schedule is written FIRST because it is the one that outlives a
    // failure: with the flags cleared first, a reset that failed here would
    // look finished and still re-arm the owner's old hour the moment the
    // feature went back on. Nothing moved, so "Start over" is simply pressed
    // again.
    expect(JSON.parse(await fs.readFile(SCHEDULE_PATH, "utf8")).enabled).toBe(true);
    expect(await shard.getMemoryShardEnabled()).toBe(true);
    expect(await shard.getMemoryShardSetupComplete()).toBe(true);
    // Whatever landed, the armed timer follows it.
    expect(scheduler.refresh).toHaveBeenCalledTimes(1);
  });

  it("refuses the agent, which holds the same bearer middleware admits", async () => {
    await shard.setMemoryShardEnabled(true);
    await shard.setMemoryShardSetupComplete(true);
    ownerSession.value = false;

    const res = await resetPOST(post("reset"));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
    // Refused BEFORE it wrote: a gate that resets and then complains is not a
    // gate.
    expect(await shard.getMemoryShardSetupComplete()).toBe(true);
    expect(scheduler.refresh).not.toHaveBeenCalled();
  });
});
