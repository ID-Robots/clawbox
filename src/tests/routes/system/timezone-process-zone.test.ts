import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startRootStep } from "@/lib/root-step-runner";
import { refresh as refreshClawKeepScheduler } from "@/lib/clawkeep-scheduler";
import { refresh as refreshMemoryScheduler } from "@/lib/clawkeep-memory-scheduler";
import { saveEnv } from "@/tests/helpers/env";

/**
 * F-B of the Memory Shard sweep (2026-09-06): the owner set Europe/Sofia at
 * 19:51 on a web server that had started at 19:44 in UTC, and every
 * "device-local" schedule since was three hours off — the wizard's "weekly,
 * Tue 04:30" was armed for 07:30 local. The OS leg moved `/etc/localtime`, the
 * harness leg moved the assistant, and nothing moved the process the
 * schedulers run in.
 *
 * So, behind a LANDED OS leg, the route now puts the zone into the process
 * and re-arms both schedulers; behind a refused one it does neither, because
 * the process must never run ahead of the `date` the Terminal shows. The
 * response shape and the two-leg failure reporting are the existing test's
 * business (src/tests/routes/system-timezone.test.ts) and are not re-pinned
 * here beyond what the new behaviour touches.
 */

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-timezone-process-tests-${process.pid}-${Date.now()}`);

const { getMock, setMock } = vi.hoisted(() => ({
  getMock: vi.fn<(key: string) => Promise<unknown>>(async () => undefined),
  setMock: vi.fn<(key: string, value: unknown) => Promise<void>>(async () => {}),
}));

vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: vi.fn(async () => true) }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: vi.fn(() => true) }));
vi.mock("@/lib/root-step-runner", () => ({
  ROOT_STEP_LAUNCHER: "/usr/local/libexec/clawbox/clawbox-run-root-step.sh",
  startRootStep: vi.fn(async () => {}),
}));
vi.mock("@/lib/config-store", () => ({ get: getMock, set: setMock }));
// Whole-module mocks for the two schedulers: their real `refresh` reads the
// ClawKeep schedule files under the account's home and would arm a real
// backup timer inside the test process.
vi.mock("@/lib/clawkeep-scheduler", () => ({ refresh: vi.fn(async () => {}) }));
vi.mock("@/lib/clawkeep-memory-scheduler", () => ({ refresh: vi.fn(async () => {}) }));
vi.mock("@/lib/edition-source", async (orig) => ({
  ...(await orig<typeof import("@/lib/edition-source")>()),
  hasHermesHarness: vi.fn(() => false),
}));
// PARTIAL, over the real module — a whole-module factory drops every other
// export, which openclaw-config-mock-completeness.test.ts exists to stop.
vi.mock("@/lib/openclaw-config", async (orig) => ({
  ...(await orig<typeof import("@/lib/openclaw-config")>()),
  runOpenclawConfigSet: vi.fn(async () => {}),
  openclawIsAbsent: vi.fn(() => false),
}));

const mockStartRootStep = vi.mocked(startRootStep);
const mockRefreshClawKeep = vi.mocked(refreshClawKeepScheduler);
const mockRefreshMemory = vi.mocked(refreshMemoryScheduler);

let restoreEnv: () => void;

beforeAll(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "TZ");
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(path.join(TEST_ROOT, "data"), { recursive: true });
});

afterAll(async () => {
  restoreEnv();
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  // A box that has never been told a zone, whose web server started in UTC.
  getMock.mockResolvedValue(undefined);
  setMock.mockResolvedValue(undefined);
  mockStartRootStep.mockResolvedValue(undefined);
  mockRefreshClawKeep.mockResolvedValue(undefined);
  mockRefreshMemory.mockResolvedValue(undefined);
  process.env.TZ = "UTC";
});

afterEach(() => {
  vi.restoreAllMocks();
});

function post(body: unknown): Request {
  return new Request("http://localhost/setup-api/system/timezone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /setup-api/system/timezone reaches the running web server", () => {
  it("moves the process zone and re-arms both schedulers once the OS leg has landed", async () => {
    const mod = await import("@/app/setup-api/system/timezone/route");
    const res = await mod.POST(post({ timezone: "Europe/Sofia" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, changed: true, applied: true });
    expect(process.env.TZ).toBe("Europe/Sofia");
    expect(mockRefreshClawKeep).toHaveBeenCalledTimes(1);
    expect(mockRefreshMemory).toHaveBeenCalledTimes(1);
    // With no schedule handed over: the scheduler re-reads its own file, so
    // what it arms is the saved schedule, in the zone the process now has.
    expect(mockRefreshClawKeep).toHaveBeenCalledWith();
  });

  it("re-arms in the SPELLING the OS leg was given, not the caller's", async () => {
    const mod = await import("@/app/setup-api/system/timezone/route");
    await mod.POST(post({ timezone: "europe/sofia" }));

    expect(process.env.TZ).toBe("Europe/Sofia");
  });

  it("leaves the process on the old zone, and the schedulers untouched, when the OS leg is refused", async () => {
    mockStartRootStep.mockRejectedValueOnce(new Error("sudo: a password is required"));
    const mod = await import("@/app/setup-api/system/timezone/route");
    const res = await mod.POST(post({ timezone: "Europe/Sofia" }));

    // The existing failure semantics, untouched: a half-applied change the
    // caller can see.
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ success: true, changed: true, applied: false });
    expect(process.env.TZ).toBe("UTC");
    expect(mockRefreshClawKeep).not.toHaveBeenCalled();
    expect(mockRefreshMemory).not.toHaveBeenCalled();
  });

  it("does not turn a scheduler that could not re-arm into a failed timezone", async () => {
    mockRefreshClawKeep.mockRejectedValueOnce(new Error("schedule.json unreadable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("@/app/setup-api/system/timezone/route");
    const res = await mod.POST(post({ timezone: "Europe/Sofia" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, changed: true, applied: true });
    // Logged, and the OTHER scheduler still re-armed: one refusal does not
    // leave the memory index on the old zone's hour.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not re-arm the ClawKeep backup scheduler"),
      expect.any(Error),
    );
    expect(mockRefreshMemory).toHaveBeenCalledTimes(1);
  });

  it("runs two overlapping requests one after the other, each root step reading its own zone", async () => {
    // TimezoneAdopter fires this route from every open tab. Unserialised, the
    // second request replaced data/timezone.env before the first one's root
    // step read it: the OS landed on the second zone while the first request
    // put ITS zone into the process and re-armed the schedules in it
    // (CodeRabbit on PR #758). Here the root step reads the env file the way
    // step_set_timezone does, slowly, and the store writes take a moment,
    // which is exactly the window the interleaving needs.
    const envPath = path.join(TEST_ROOT, "data", "timezone.env");
    const seen: Array<{ env: string; processZone: string | undefined }> = [];
    mockStartRootStep.mockImplementation(async () => {
      seen.push({ env: (await fs.readFile(envPath, "utf-8")).trim(), processZone: process.env.TZ });
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    setMock.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });

    const mod = await import("@/app/setup-api/system/timezone/route");
    const [first, second] = await Promise.all([
      mod.POST(post({ timezone: "Europe/Sofia" })),
      mod.POST(post({ timezone: "America/New_York" })),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Each OS leg was given the zone of the request it belongs to, and the
    // second began only once the first had reached the process.
    expect(seen).toEqual([
      { env: "TIMEZONE=Europe/Sofia", processZone: "UTC" },
      { env: "TIMEZONE=America/New_York", processZone: "Europe/Sofia" },
    ]);
    // The last zone asked for is the one every layer ends on.
    expect(process.env.TZ).toBe("America/New_York");
    const appliedWrites = setMock.mock.calls.filter(([key]) => key === "timezone_applied").map(([, value]) => value);
    expect(appliedWrites.at(-1)).toBe("America/New_York");
    expect(mockRefreshMemory).toHaveBeenCalledTimes(2);
  });

  it("answers a second tab's identical zone off the state the first one left, without re-running it", async () => {
    // Both tabs adopt the same browser zone. Queued, the second reads the
    // first's applied marker and is `changed: false` — no second env write,
    // root step or scheduler re-arm for a zone that has just landed.
    const store = new Map<string, unknown>();
    getMock.mockImplementation(async (key: string) => store.get(key));
    setMock.mockImplementation(async (key: string, value: unknown) => {
      if (value === undefined) store.delete(key); else store.set(key, value);
    });

    const mod = await import("@/app/setup-api/system/timezone/route");
    const [first, second] = await Promise.all([
      mod.POST(post({ timezone: "Europe/Sofia", adopt: true })),
      mod.POST(post({ timezone: "Europe/Sofia", adopt: true })),
    ]);

    expect(await first.json()).toMatchObject({ success: true, changed: true, applied: true });
    expect(await second.json()).toMatchObject({ success: true, changed: false, timezone: "Europe/Sofia" });
    expect(mockStartRootStep).toHaveBeenCalledTimes(1);
    expect(mockRefreshMemory).toHaveBeenCalledTimes(1);
  });

  it("never touches the process for a zone it refused", async () => {
    const mod = await import("@/app/setup-api/system/timezone/route");
    const res = await mod.POST(post({ timezone: "Not/A/Zone" }));

    expect(res.status).toBe(400);
    expect(process.env.TZ).toBe("UTC");
    expect(mockStartRootStep).not.toHaveBeenCalled();
    expect(mockRefreshClawKeep).not.toHaveBeenCalled();
    expect(mockRefreshMemory).not.toHaveBeenCalled();
  });
});
