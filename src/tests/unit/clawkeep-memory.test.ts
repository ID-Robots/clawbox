import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
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
      // Older than INDEX_TIMEOUT_MS as well as naming a dead pid: on a kernel
      // with a large pid_max, 999999 can exist and the age is what makes the
      // reconcile deterministic.
      startedAtMs: Date.now() - 3 * 60 * 60_000, finishedAtMs: 0, durationMs: 0,
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

describe("what the first Index now click actually runs", () => {
  /**
   * Observed on .177, not reasoned about: on a box whose vector index has
   * never been built, `openclaw memory index` WITHOUT `--force` exits 1 with
   * `no such table: memory_index_chunks_vec`, while the same command with
   * `--force` exits 0 and creates it. Without this rule the very first
   * "Index now" a new owner clicks fails and blames their embedding model.
   *
   * Driven through the real spawn-and-parse path by pointing the binary at a
   * script that prints a status payload, so a change to either the CLI probe
   * or the rule breaks it.
   */
  async function withStatusChunks(chunks: number): Promise<typeof import("@/lib/clawkeep-memory")> {
    const payload = JSON.parse(JSON.stringify(REAL_STATUS)) as Array<{ status: { chunks: number; files: number } }>;
    payload[0].status.chunks = chunks;
    payload[0].status.files = chunks ? 7 : 0;
    const script = path.join(tmpDir, "fake-openclaw");
    await fs.writeFile(script, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(payload)}\nJSON\n`, { mode: 0o755 });
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = script;
    vi.resetModules();
    return await import("@/lib/clawkeep-memory");
  }

  afterEach(() => { delete process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN; });

  it("upgrades to a full build when nothing is indexed yet", async () => {
    const { resolveIndexMode } = await withStatusChunks(0);
    expect(await resolveIndexMode("incremental")).toBe("full");
  });

  it("leaves an existing index alone", async () => {
    const { resolveIndexMode } = await withStatusChunks(512);
    expect(await resolveIndexMode("incremental")).toBe("incremental");
  });

  it("does not turn a failed status probe into a full reindex", async () => {
    // getMemoryStatus() answers with the unavailable status when the probe
    // fails, and that fallback also reports zero chunks. Promoting on chunks
    // alone would re-embed a perfectly good index every time the CLI hiccuped
    // — including on the unattended schedule.
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = "false";
    vi.resetModules();
    const { resolveIndexMode, getMemoryStatus } = await import("@/lib/clawkeep-memory");
    const status = await getMemoryStatus();
    expect(status.available).toBe(false);
    expect(status.chunks).toBe(0);
    expect(await resolveIndexMode("incremental")).toBe("incremental");
  });

  it("never downgrades an explicit full reindex", async () => {
    const { resolveIndexMode } = await withStatusChunks(512);
    expect(await resolveIndexMode("full")).toBe("full");
  });
});

describe("the status cache", () => {
  /**
   * The probe boots a whole OpenClaw process, ~8 s on a Jetson. Settings →
   * Local AI polls the inventory every five seconds and blocked on that probe
   * whenever the cache had aged out — a skeleton for eight seconds every half
   * minute. A stale reading must be answered at once and refreshed behind it;
   * only a caller with no reading at all waits.
   */
  afterEach(() => {
    delete process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN;
    vi.useRealTimers();
  });

  it("never blocks the caller that peeks, and starts the probe for it", async () => {
    const calls = path.join(tmpDir, "peek-calls");
    const script = path.join(tmpDir, "slow-openclaw");
    await fs.writeFile(script, `#!/bin/sh\necho x >> ${calls}\nsleep 1\ncat <<'JSON'\n${JSON.stringify(REAL_STATUS)}\nJSON\n`, { mode: 0o755 });
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = script;
    vi.resetModules();
    const { peekMemoryStatus } = await import("@/lib/clawkeep-memory");

    // Cold: no reading yet, and the caller is not made to wait for one.
    const started = performance.now();
    expect(peekMemoryStatus()).toBeNull();
    expect(performance.now() - started).toBeLessThan(200);

    // ...but the probe it started fills the cache, so the next peek answers.
    await new Promise((r) => setTimeout(r, 1500));
    expect(peekMemoryStatus()?.available).toBe(true);
    // One probe for the burst, not one per peek.
    peekMemoryStatus();
    expect((await fs.readFile(calls, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("answers a stale reading immediately and refreshes it in the background", async () => {
    const calls = path.join(tmpDir, "calls");
    const script = path.join(tmpDir, "slow-openclaw");
    await fs.writeFile(script, `#!/bin/sh\necho x >> ${calls}\nsleep 1\ncat <<'JSON'\n${JSON.stringify(REAL_STATUS)}\nJSON\n`, { mode: 0o755 });
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = script;
    vi.resetModules();
    const { getMemoryStatus } = await import("@/lib/clawkeep-memory");

    // Cold: the only time a reader waits on the probe.
    const first = await getMemoryStatus();
    expect(first.available).toBe(true);
    expect((await fs.readFile(calls, "utf8")).trim().split("\n")).toHaveLength(1);

    // Aged out: the stale reading comes back at once, not after the probe.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 300_000);
    const started = performance.now();
    const stale = await getMemoryStatus();
    expect(performance.now() - started).toBeLessThan(500);
    expect(stale.available).toBe(true);

    // ...and the probe ran again behind it, exactly once for the burst.
    await getMemoryStatus();
    await new Promise((r) => setTimeout(r, 1500));
    expect((await fs.readFile(calls, "utf8")).trim().split("\n")).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it("keeps answering at once after an invalidation, rather than blocking on the probe", async () => {
    // A finished run invalidates the reading. Dropping it outright made the
    // panel's very next read — the one right after "Index now" — wait on the
    // cold probe for the whole pass. Stale is answered now, fresh follows.
    const script = path.join(tmpDir, "slow-openclaw");
    await fs.writeFile(script, `#!/bin/sh\nsleep 1\ncat <<'JSON'\n${JSON.stringify(REAL_STATUS)}\nJSON\n`, { mode: 0o755 });
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = script;
    vi.resetModules();
    const { getMemoryStatus, invalidateMemoryStatusCache } = await import("@/lib/clawkeep-memory");
    await getMemoryStatus();
    invalidateMemoryStatusCache();
    const started = performance.now();
    expect((await getMemoryStatus()).available).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
    await new Promise((r) => setTimeout(r, 1500));
  });

  it("answers the run state as it is when the cold probe returns, not as it was when it started", async () => {
    // The panel's read after a short run used to say "running" for a pass
    // that had finished during the probe — the run state was read before
    // the eight-second probe and handed back unchanged.
    const script = path.join(tmpDir, "slow-openclaw");
    await fs.writeFile(script, `#!/bin/sh\nsleep 1\ncat <<'JSON'\n${JSON.stringify(REAL_STATUS)}\nJSON\n`, { mode: 0o755 });
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = script;
    vi.resetModules();
    const { getMemoryStatus } = await import("@/lib/clawkeep-memory");
    const pending = getMemoryStatus();
    await new Promise((r) => setTimeout(r, 300));
    await fs.writeFile(path.join(tmpDir, "memory-index-state.json"), JSON.stringify({
      status: "succeeded", mode: "full", trigger: "manual",
      startedAtMs: Date.now() - 9_000, finishedAtMs: Date.now(), durationMs: 9_000, error: "", childPid: 0,
    }));
    expect((await pending).run.status).toBe("succeeded");
  });
});

describe("how a run ends", () => {
  afterEach(() => {
    delete process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN;
    delete process.env.CLAWKEEP_MEMORY_EMBED_LOCK;
  });

  async function settledRun(): Promise<{ status: string; error: string; childPid: number }> {
    for (let i = 0; i < 300; i++) {
      const now = JSON.parse(await fs.readFile(path.join(tmpDir, "memory-index-state.json"), "utf8").catch(() => "{}"));
      if (now.status && now.status !== "running") return now;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("the run never settled");
  }

  it("reports a busy model migration as such, within milliseconds — never as interrupted", async () => {
    // `flock -n` exits in a couple of milliseconds when ensure-local-embeddings
    // holds the lock, inside the state write. With the listeners attached
    // after that write, the exit went unseen and the reconcile later called
    // the run interrupted — advice that fails identically on the retry.
    const lock = path.join(tmpDir, "embed.lock");
    process.env.CLAWKEEP_MEMORY_EMBED_LOCK = lock;
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = "true";
    const holder = spawn("flock", ["--no-fork", lock, "sleep", "5"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    vi.resetModules();
    const { startMemoryIndex } = await import("@/lib/clawkeep-memory");
    try {
      const started = performance.now();
      expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);
      const run = await settledRun();
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(run.status).toBe("failed");
      expect(run.error).toContain("still being set up");
      expect(run.error).not.toContain("interrupted");
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("says a run killed from outside was interrupted, not that the model is broken", async () => {
    // The OOM killer, an operator, a service restart: none of them is the
    // embedding model's fault, and the old message sent the owner to check
    // a model that was fine.
    const script = path.join(tmpDir, "fake-index");
    await fs.writeFile(script, `#!/bin/sh\nexec sleep 5\n`, { mode: 0o755 });
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = script;
    process.env.CLAWKEEP_MEMORY_EMBED_LOCK = path.join(tmpDir, "embed.lock");
    vi.resetModules();
    const { startMemoryIndex } = await import("@/lib/clawkeep-memory");
    expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);
    let childPid = 0;
    for (let i = 0; i < 100 && !childPid; i++) {
      childPid = JSON.parse(await fs.readFile(path.join(tmpDir, "memory-index-state.json"), "utf8")).childPid;
      if (!childPid) await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 100));
    // Never signal pid 0: on Unix that targets this whole process group —
    // the test runner included — so a run that never recorded its child must
    // fail here, not kill the suite.
    expect(childPid).toBeGreaterThan(0);
    process.kill(childPid, "SIGKILL");
    const run = await settledRun();
    expect(run.status).toBe("failed");
    expect(run.error).toContain("interrupted");
    expect(run.error).not.toContain("embedding model");
  });
});

describe("the process the run supervises", () => {
  it("is the indexer itself, not a flock wrapper around it", async () => {
    /**
     * util-linux `flock` defaults to forking the command and waiting on it.
     * Without `--no-fork` the pid this module records and signals would be the
     * WRAPPER: the timeout handler and the failed-state-write cleanup would
     * kill it and leave `openclaw memory index` running unsupervised, while
     * the lock it was holding is released along with the wrapper — the exact
     * opposite of what both paths are for.
     *
     * The same goes one level down: the installed `openclaw` is a launcher
     * that re-spawns the real CLI as a grandchild unless OPENCLAW_NO_RESPAWN
     * is set, and only forwards SIGTERM to it. The fake binary here does the
     * same, so a run that forgets the opt-out records the launcher's pid and
     * fails this.
     *
     * Asserted against the real spawn, by giving the run a "binary" that
     * writes its own pid: with `--no-fork` and the opt-out that pid is the
     * child we recorded.
     */
    const marker = path.join(tmpDir, "who-am-i");
    const script = path.join(tmpDir, "fake-index");
    // Lives just long enough for the module to record its pid; the test then
    // waits for it to exit before the fixture directory is torn down.
    await fs.writeFile(script, [
      "#!/bin/sh",
      'if [ -z "$OPENCLAW_NO_RESPAWN" ] && [ -z "$FAKE_INNER" ]; then FAKE_INNER=1 "$0" "$@" & wait; exit 0; fi',
      `printf '%s' "$$" > ${JSON.stringify(marker)}`,
      "sleep 0.5",
      "",
    ].join("\n"), { mode: 0o755 });
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = script;
    process.env.CLAWKEEP_MEMORY_EMBED_LOCK = path.join(tmpDir, "embed.lock");
    vi.resetModules();
    const { startMemoryIndex } = await import("@/lib/clawkeep-memory");

    const { accepted } = await startMemoryIndex("full", "manual");
    expect(accepted).toBe(true);
    for (let i = 0; i < 100 && !(await fs.readFile(marker, "utf8").catch(() => "")); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const execPid = Number(await fs.readFile(marker, "utf8"));
    expect(execPid).toBeGreaterThan(0);

    // Settle before asserting and before the fixture directory is torn down —
    // the run writes the lock and the state file from its own close handler,
    // and racing that is how this test used to fail the suite with ENOTEMPTY.
    let persisted: { childPid: number; status: string } | null = null;
    for (let i = 0; i < 200; i++) {
      persisted = JSON.parse(await fs.readFile(path.join(tmpDir, "memory-index-state.json"), "utf8"));
      if (persisted && persisted.childPid) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    // The pid this module recorded is the one the script saw as its own — so
    // the thing we supervise and signal is the indexer, not a wrapper.
    expect(persisted?.childPid).toBe(execPid);
    for (let i = 0; i < 200; i++) {
      const now = JSON.parse(await fs.readFile(path.join(tmpDir, "memory-index-state.json"), "utf8"));
      if (now.status !== "running") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    delete process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN;
    delete process.env.CLAWKEEP_MEMORY_EMBED_LOCK;
  });
});
