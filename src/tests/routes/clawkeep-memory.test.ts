import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TASK-398: the three routes behind the ClawKeep memory panel.
 *
 * Driven through the REAL route handlers, not through the lib, because the
 * contract that matters here is what crosses the HTTP boundary: the status
 * codes, and the fact that no path, provider error or CLI output rides along.
 */

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-memory-route-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "clawkeep");

// The schedule route re-arms the in-process scheduler after each PUT. Stub it
// so the suite does not leak a real timer, and so we can assert the re-arm
// happened — a saved schedule that only takes effect at the next reboot is the
// bug this panel is meant to make impossible.
vi.mock("@/lib/clawkeep-memory-scheduler", () => ({
  start: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}),
  nextRunAtMs: vi.fn(() => 0),
}));

// Starting a run and rewriting the schedule are OWNER-ONLY: middleware admits
// the MCP bearer on every /setup-api route, so without that gate the assistant
// could kick off an hours-long full reindex, or change how often one happens.
// These cases are about what the OWNER gets, so the session answers yes; the
// refusal itself is asserted in its own block below.
const { ownerSession } = vi.hoisted(() => ({ ownerSession: { value: true } }));
vi.mock("@/lib/owner-session", () => ({
  hasOwnerSession: vi.fn(async () => ownerSession.value),
}));

// Starting a run also needs Memory Shard to be switched ON: the switch is the
// owner's consent for this box to index at all. Mocked rather than written to
// the config store, whose file is shared with every other test in the worker.
// `answers` is how a test makes the switch CHANGE between two reads, which is
// the whole reason startMemoryIndex reads it again inside its own lock.
const { shard } = vi.hoisted(() => ({ shard: { enabled: true, answers: [] as boolean[] } }));
vi.mock("@/lib/memory-shard", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/memory-shard")>(),
  getMemoryShardEnabled: async () => (shard.answers.length ? shard.answers.shift()! : shard.enabled),
}));

let statusGET: typeof import("@/app/setup-api/clawkeep/memory/route").GET;
let indexPOST: typeof import("@/app/setup-api/clawkeep/memory/index/route").POST;
let scheduleGET: typeof import("@/app/setup-api/clawkeep/memory/schedule/route").GET;
let schedulePUT: typeof import("@/app/setup-api/clawkeep/memory/schedule/route").PUT;
let scheduler: typeof import("@/lib/clawkeep-memory-scheduler");

beforeAll(async () => {
  process.env.CLAWKEEP_DATA_DIR = DATA_DIR;
  // A binary that exits non-zero with no output: the status probe must turn
  // that into an explicit "unavailable", never into a 500.
  process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = "false";
  await fs.mkdir(DATA_DIR, { recursive: true });
  statusGET = (await import("@/app/setup-api/clawkeep/memory/route")).GET;
  indexPOST = (await import("@/app/setup-api/clawkeep/memory/index/route")).POST;
  const sched = await import("@/app/setup-api/clawkeep/memory/schedule/route");
  scheduleGET = sched.GET;
  schedulePUT = sched.PUT;
  scheduler = await import("@/lib/clawkeep-memory-scheduler");
});

afterAll(async () => {
  delete process.env.CLAWKEEP_DATA_DIR;
  delete process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  ownerSession.value = true;
  shard.enabled = true;
  shard.answers = [];
  await fs.rm(path.join(DATA_DIR, "memory-index-schedule.json"), { force: true });
  await fs.rm(path.join(DATA_DIR, "memory-index-state.json"), { force: true });
  await fs.rm(path.join(DATA_DIR, "memory-index.lock"), { recursive: true, force: true });
});

function put(body: unknown): NextRequest {
  return new NextRequest("http://localhost/setup-api/clawkeep/memory/schedule", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /setup-api/clawkeep/memory", () => {
  it("answers 200 with an explicit unavailable status when the CLI cannot be read", async () => {
    const res = await statusGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(false);
    expect(body.health).toBe("unavailable");
    // A panel that renders "unavailable" is useful. An error toast tells the
    // owner nothing about their index.
    expect(body.error).toBeTruthy();
  });

  it("is never cached, so the panel cannot show a stale index", async () => {
    const res = await statusGET();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("names no next run while the shard is switched off, even with a schedule saved", async () => {
    // The scheduler arms no timer in that state, so a "next run" here would be
    // an hour at which nothing happens. The schedule itself is kept, which is
    // what makes switching back on restore the hour the owner chose.
    await schedulePUT(put({ enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0 }));
    expect((await (await statusGET()).json()).nextRunAtMs).toBeGreaterThan(0);

    shard.enabled = false;
    const body = await (await statusGET()).json();
    expect(body.enabled).toBe(false);
    expect(body.nextRunAtMs).toBe(0);
    expect(body.schedule.enabled).toBe(true);
  });
});

describe("PUT /setup-api/clawkeep/memory/schedule", () => {
  it("persists a schedule and re-arms the scheduler in the same request", async () => {
    const res = await schedulePUT(put({ enabled: true, frequency: "weekly", timeOfDay: "04:15", weekday: 3 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schedule).toEqual({ enabled: true, frequency: "weekly", timeOfDay: "04:15", weekday: 3 });
    expect(body.nextRunAtMs).toBeGreaterThan(Date.now());
    expect(scheduler.refresh).toHaveBeenCalledTimes(1);
  });

  it("survives being read back, which is what a reboot does", async () => {
    await schedulePUT(put({ enabled: true, frequency: "daily", timeOfDay: "02:45", weekday: 0 }));
    const body = await (await scheduleGET()).json();
    expect(body.schedule.enabled).toBe(true);
    expect(body.schedule.timeOfDay).toBe("02:45");
  });

  it("does not persist an impossible time as if it were valid", async () => {
    const body = await (await schedulePUT(put({ enabled: true, timeOfDay: "25:99" }))).json();
    expect(body.schedule.timeOfDay).toBe("03:00");
    expect(body.nextRunAtMs).toBeGreaterThan(0);
  });
});

describe("POST /setup-api/clawkeep/memory/index", () => {
  it("declines a second run instead of starting one, and says so with 409", async () => {
    // Pin the box down as mid-run: the lock exists and the state file names a
    // live pid (this process), which is what a real in-flight index looks like.
    await fs.mkdir(path.join(DATA_DIR, "memory-index.lock"), { recursive: true });
    await fs.writeFile(path.join(DATA_DIR, "memory-index-state.json"), JSON.stringify({
      status: "running", mode: "full", trigger: "manual",
      startedAtMs: Date.now(), finishedAtMs: 0, durationMs: 0, error: "", childPid: process.pid,
    }));
    const res = await indexPOST(new NextRequest("http://localhost/x", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "full" }),
    }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.accepted).toBe(false);
    expect(body.run.status).toBe("running");
    // No status payload on this path: attaching it made every accept/decline
    // pay for a fresh 90s-bounded CLI probe on an 8 GB box, and the panel
    // refetches the status straight afterwards anyway.
    expect(body.status).toBeUndefined();
  });

  it("declines an incremental request at once too, without asking the CLI anything", async () => {
    // The incremental path used to resolve its mode — a status probe — BEFORE
    // the single-flight check. With the cache dropped by the run in flight,
    // that probe took as long as the run itself; by the time it answered the
    // first run had finished and a second one started over its record.
    const marker = path.join(TEST_ROOT, "probed");
    const script = path.join(TEST_ROOT, "probing-openclaw");
    await fs.writeFile(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho '[]'\n`, { mode: 0o755 });
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = script;
    try {
      await fs.mkdir(path.join(DATA_DIR, "memory-index.lock"), { recursive: true });
      await fs.writeFile(path.join(DATA_DIR, "memory-index-state.json"), JSON.stringify({
        status: "running", mode: "full", trigger: "manual",
        startedAtMs: Date.now(), finishedAtMs: 0, durationMs: 0, error: "", childPid: process.pid,
      }));
      const started = performance.now();
      const res = await indexPOST(new NextRequest("http://localhost/x", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "incremental" }),
      }));
      expect(res.status).toBe(409);
      // Generous on purpose — a loaded runner must not fail a correct route
      // on timing; the assertion that matters is the absent marker below.
      expect(performance.now() - started).toBeLessThan(5_000);
      expect((await res.json()).run.status).toBe("running");
      await new Promise((r) => setTimeout(r, 100));
      expect(await fs.stat(marker).then(() => true, () => false)).toBe(false);
    } finally {
      process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = "false";
    }
  });

  it("refuses to index at all while Memory Shard is switched off", async () => {
    // The half of "off" that the owner can reach by hand. The scheduler
    // disarms itself; this button has to be refused too, or the switch is a
    // word on a screen. `kind` is what lets the app say WHY — the same 409
    // otherwise means "a run is already going", which would send the owner
    // looking for a run nobody started.
    shard.enabled = false;
    const res = await indexPOST(new NextRequest("http://localhost/x", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "full" }),
    }));
    expect(res.status).toBe(409);
    expect((await res.json()).kind).toBe("disabled");
    // And it never reached the CLI: no run state was written for a pass that
    // was refused.
    expect(
      await fs.access(path.join(DATA_DIR, "memory-index-state.json")).then(() => true, () => false),
    ).toBe(false);
  });

  it("refuses a run whose switch went off between the route's look and the lock", async () => {
    // The route's own check can be a minute old by the time the work starts —
    // resolveIndexMode waits on a CLI probe on a cold box. The reading that
    // decides is the one startMemoryIndex takes inside its lock, so the two
    // are on the same side of it: an "off" either prevents the run or lands
    // after one had already begun.
    shard.answers = [true];
    shard.enabled = false;
    const res = await indexPOST(new NextRequest("http://localhost/x", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "full" }),
    }));
    expect(res.status).toBe(409);
    expect((await res.json()).kind).toBe("disabled");
    // Nothing started, and the lock is handed back rather than left for the
    // next caller to trip over.
    for (const left of ["memory-index.lock", "memory-index-state.json"]) {
      expect(await fs.access(path.join(DATA_DIR, left)).then(() => true, () => false)).toBe(false);
    }
  });

  it("never returns the pid it is running under", async () => {
    await fs.mkdir(path.join(DATA_DIR, "memory-index.lock"), { recursive: true });
    await fs.writeFile(path.join(DATA_DIR, "memory-index-state.json"), JSON.stringify({
      status: "running", mode: "incremental", trigger: "schedule",
      startedAtMs: Date.now(), finishedAtMs: 0, durationMs: 0, error: "", childPid: process.pid,
    }));
    const res = await indexPOST(new NextRequest("http://localhost/x", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }));
    expect(JSON.stringify(await res.json())).not.toContain(String(process.pid));
  });
});

describe("the owner gate on the two routes that spend the box's time", () => {
  // Middleware admits the MCP bearer on every /setup-api route, so "signed in"
  // is not the same question as "the PERSON asked". Reading the status stays
  // open to the agent; starting an hours-long re-embed, or moving when one
  // happens unattended, does not.
  beforeEach(() => { ownerSession.value = false; });

  it("refuses to start an index run without an owner session", async () => {
    const res = await indexPOST(new NextRequest("http://localhost/x", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
  });

  it("refuses to rewrite the schedule without an owner session", async () => {
    const res = await schedulePUT(put({
      enabled: true, frequency: "daily", timeOfDay: "04:15", weekday: 0,
    }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
    // Refused BEFORE it wrote: a gate that persists and then complains is not
    // a gate. The scheduler must not have been re-armed either.
    expect(
      await fs.access(path.join(DATA_DIR, "memory-index-schedule.json")).then(() => true, () => false),
    ).toBe(false);
    expect(scheduler.refresh).not.toHaveBeenCalled();
  });
});
