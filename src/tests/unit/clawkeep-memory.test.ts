import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * TASK-398, added UI scope: what the ClawKeep memory panel is allowed to say.
 *
 * The status half is tested against a payload CAPTURED FROM A REAL BOX
 * (`src/tests/fixtures/openclaw-memory-status.json`, taken from
 * `openclaw memory status --agent main --deep --json` on .177) rather than a
 * hand-written shape. A fixture we invented would keep passing after the CLI
 * changed its output, which is exactly the drift this panel exists to expose.
 */

const REAL_STATUS = JSON.parse(
  await fs.readFile(new URL("../fixtures/openclaw-memory-status.json", import.meta.url), "utf8"),
) as unknown;

let tmpDir = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawkeep-memory-"));
  process.env.CLAWKEEP_DATA_DIR = tmpDir;
  // CLAWKEEP_DATA_DIR is read once at module load, so each test needs a fresh
  // module graph or they would all share the first test's directory.
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.CLAWKEEP_DATA_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function lib() {
  return await import("@/lib/clawkeep-memory");
}

const IDLE_RUN = {
  status: "idle" as const,
  mode: "" as const,
  trigger: "" as const,
  startedAtMs: 0,
  finishedAtMs: 0,
  durationMs: 0,
  error: "",
};

describe("reading the real memory status", () => {
  it("reports a local embedder as on-device, not as cloud", async () => {
    const { parseMemoryStatus, DEFAULT_MEMORY_SCHEDULE } = await lib();
    const status = await parseMemoryStatus(REAL_STATUS, IDLE_RUN, DEFAULT_MEMORY_SCHEDULE);
    // The whole privacy claim rests on this one field being right.
    expect(status.provider).toBe("ollama");
    expect(status.model).toBe("qwen3-embedding:0.6b");
    expect(status.location).toBe("local");
    expect(status.health).toBe("healthy");
    expect(status.indexIdentity).toBe("valid");
  });

  it("does not count a scan warning as a failed item", async () => {
    const { parseMemoryStatus, DEFAULT_MEMORY_SCHEDULE } = await lib();
    // The captured payload is from a box that had never written a memory file,
    // so `scan.issues` carries "memory directory missing". Counting that put a
    // red "Failed: 1" on a healthy new device.
    const raw = REAL_STATUS as Array<{ scan: { issues: string[] } }>;
    expect(raw[0].scan.issues.length).toBe(1);
    const status = await parseMemoryStatus(REAL_STATUS, IDLE_RUN, DEFAULT_MEMORY_SCHEDULE);
    expect(status.failedItems).toBe(0);
  });

  it("never leaks a path, a model file or CLI text into what the UI renders", async () => {
    const { parseMemoryStatus, DEFAULT_MEMORY_SCHEDULE } = await lib();
    const status = await parseMemoryStatus(REAL_STATUS, IDLE_RUN, DEFAULT_MEMORY_SCHEDULE);
    const rendered = JSON.stringify(status);
    // Everything in the captured payload that must not reach a customer.
    expect(rendered).not.toContain("/home/");
    expect(rendered).not.toContain(".sqlite");
    expect(rendered).not.toContain("vec0.so");
    expect(rendered).not.toContain("plugin-state:");
    expect(rendered).not.toContain("directory missing");
  });

  it("tells the customer to reindex when the index belongs to another model", async () => {
    const { parseMemoryStatus, DEFAULT_MEMORY_SCHEDULE } = await lib();
    const rows = JSON.parse(JSON.stringify(REAL_STATUS)) as Array<Record<string, never>>;
    (rows[0] as unknown as { status: { custom: { indexIdentity: { status: string } } } })
      .status.custom.indexIdentity.status = "mismatched";
    const status = await parseMemoryStatus(rows, IDLE_RUN, DEFAULT_MEMORY_SCHEDULE);
    expect(status.indexIdentity).toBe("mismatched");
    expect(status.error).toContain("full reindex");
  });

  it("keeps the fingerprint stable for a configuration and changes it with the model", async () => {
    const { parseMemoryStatus, DEFAULT_MEMORY_SCHEDULE } = await lib();
    const a = await parseMemoryStatus(REAL_STATUS, IDLE_RUN, DEFAULT_MEMORY_SCHEDULE);
    const again = await parseMemoryStatus(REAL_STATUS, IDLE_RUN, DEFAULT_MEMORY_SCHEDULE);
    expect(a.fingerprint).toBe(again.fingerprint);
    expect(a.fingerprint).not.toBe("");

    const rows = JSON.parse(JSON.stringify(REAL_STATUS)) as unknown;
    (rows as Array<{ status: { model: string } }>)[0].status.model = "text-embedding-3-large";
    const other = await parseMemoryStatus(rows, IDLE_RUN, DEFAULT_MEMORY_SCHEDULE);
    expect(other.fingerprint).not.toBe(a.fingerprint);
  });

  it("says unavailable rather than pretending, when the CLI says nothing", async () => {
    const { parseMemoryStatus, DEFAULT_MEMORY_SCHEDULE } = await lib();
    const status = await parseMemoryStatus([{ agentId: "main", status: {} }], IDLE_RUN, DEFAULT_MEMORY_SCHEDULE);
    expect(status.available).toBe(false);
    expect(status.health).toBe("unavailable");
    expect(status.location).toBe("unknown");
  });
});

describe("the managed schedule", () => {
  it("survives a write and a read, which is what makes it survive a reboot", async () => {
    const { readMemorySchedule, writeMemorySchedule } = await lib();
    await writeMemorySchedule({ enabled: true, frequency: "weekly", timeOfDay: "04:30", weekday: 3 });
    expect(await readMemorySchedule()).toEqual({
      enabled: true, frequency: "weekly", timeOfDay: "04:30", weekday: 3,
    });
  });

  it("refuses junk instead of persisting it", async () => {
    const { writeMemorySchedule, DEFAULT_MEMORY_SCHEDULE } = await lib();
    const saved = await writeMemorySchedule({
      enabled: "yes", frequency: "hourly", timeOfDay: "25:99", weekday: 42,
    });
    expect(saved.enabled).toBe(false);
    expect(saved.frequency).toBe("daily");
    expect(saved.timeOfDay).toBe(DEFAULT_MEMORY_SCHEDULE.timeOfDay);
    expect(saved.weekday).toBe(DEFAULT_MEMORY_SCHEDULE.weekday);
  });

  it("computes the next daily slot as tomorrow once today's has passed", async () => {
    const { computeNextMemoryRunMs } = await lib();
    const now = new Date("2026-08-22T05:00:00");
    const next = computeNextMemoryRunMs(
      { enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0 }, now,
    );
    expect(new Date(next).getDate()).toBe(23);
    expect(new Date(next).getHours()).toBe(3);
  });

  it("computes the next weekly slot on the chosen weekday", async () => {
    const { computeNextMemoryRunMs } = await lib();
    const now = new Date("2026-08-22T05:00:00"); // a Saturday
    const next = computeNextMemoryRunMs(
      { enabled: true, frequency: "weekly", timeOfDay: "03:00", weekday: 2 }, now,
    );
    expect(new Date(next).getDay()).toBe(2);
    expect(next).toBeGreaterThan(now.getTime());
  });

  it("is disarmed while disabled, so a saved-but-off schedule cannot fire", async () => {
    const { computeNextMemoryRunMs } = await lib();
    expect(computeNextMemoryRunMs(
      { enabled: false, frequency: "daily", timeOfDay: "03:00", weekday: 0 }, new Date(),
    )).toBe(0);
  });
});

describe("run state", () => {
  it("reports a run whose process is gone as interrupted, not as still running", async () => {
    const { readMemoryRunState } = await lib();
    // A box that lost power mid-index leaves exactly this on disk. Without the
    // reconcile the panel would show a spinner forever and the run lock would
    // never be released.
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "memory-index-state.json"), JSON.stringify({
      status: "running", mode: "full", trigger: "manual",
      startedAtMs: Date.now() - 10 * 60_000, finishedAtMs: 0, durationMs: 0,
      error: "", childPid: 999_999,
    }));
    const run = await readMemoryRunState();
    expect(run.status).toBe("failed");
    expect(run.error).toContain("interrupted");
  });

  it("never hands the UI the pid it ran under", async () => {
    const { readMemoryRunState } = await lib();
    await fs.writeFile(path.join(tmpDir, "memory-index-state.json"), JSON.stringify({
      status: "succeeded", mode: "incremental", trigger: "schedule",
      startedAtMs: 1, finishedAtMs: 2, durationMs: 1, error: "", childPid: 4242,
    }));
    const run = await readMemoryRunState();
    expect(JSON.stringify(run)).not.toContain("4242");
    expect("childPid" in run).toBe(false);
  });
});
