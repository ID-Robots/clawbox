import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import { IDLE_MEMORY_RUN, settledMemoryRun } from "@/tests/helpers/memory-run-state";
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

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REAL_STATUS = JSON.parse(
  await fs.readFile(new URL("../fixtures/openclaw-memory-status.json", import.meta.url), "utf8"),
) as unknown;

let tmpDir = "";

// The owner's switch, which `startMemoryIndex` reads INSIDE its own lock: the
// box does not index while Memory Shard is off, so a suite that drives the
// real start path has to say the box is switched on. Mocked rather than
// written to the config store, whose file is shared with every other test in
// the worker.
const { shard } = vi.hoisted(() => ({ shard: { enabled: true } }));
vi.mock("@/lib/memory-shard", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/memory-shard")>(),
  getMemoryShardEnabled: async () => shard.enabled,
}));

beforeEach(async () => {
  shard.enabled = true;
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


describe("reading the real memory status", () => {
  it("reports a local embedder as on-device, not as cloud", async () => {
    const { parseMemoryStatus, DEFAULT_MEMORY_SCHEDULE } = await lib();
    const status = await parseMemoryStatus(REAL_STATUS, IDLE_MEMORY_RUN, DEFAULT_MEMORY_SCHEDULE);
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
    const status = await parseMemoryStatus(REAL_STATUS, IDLE_MEMORY_RUN, DEFAULT_MEMORY_SCHEDULE);
    expect(status.failedItems).toBe(0);
  });

  it("never leaks a path, a model file or CLI text into what the UI renders", async () => {
    const { parseMemoryStatus, DEFAULT_MEMORY_SCHEDULE } = await lib();
    const status = await parseMemoryStatus(REAL_STATUS, IDLE_MEMORY_RUN, DEFAULT_MEMORY_SCHEDULE);
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
    const status = await parseMemoryStatus(rows, IDLE_MEMORY_RUN, DEFAULT_MEMORY_SCHEDULE);
    expect(status.indexIdentity).toBe("mismatched");
    expect(status.error).toContain("full reindex");
  });

  it("calls an index built by another model degraded, and names the fact in a code", async () => {
    // Observed on the box: identity "mismatched" with the embedder answering
    // perfectly came back as health "unknown" — a bare "Unknown" chip beside
    // an amber banner that told the owner exactly what was wrong. The state is
    // known; only the wording was missing. The code is what lets a German
    // desktop say it in German instead of printing the English below.
    const { parseMemoryStatus, DEFAULT_MEMORY_SCHEDULE } = await lib();
    for (const [identity, code] of [
      ["mismatched", "index_identity_mismatched"],
      ["missing", "index_identity_missing"],
    ] as const) {
      const rows = JSON.parse(JSON.stringify(REAL_STATUS)) as unknown;
      (rows as Array<{ status: { custom: { indexIdentity: { status: string } } } }>)[0]
        .status.custom.indexIdentity.status = identity;
      const status = await parseMemoryStatus(rows, IDLE_MEMORY_RUN, DEFAULT_MEMORY_SCHEDULE);
      expect(status.indexIdentity).toBe(identity);
      expect(status.health).toBe("degraded");
      expect(status.errorCode).toBe(code);
      expect(status.error).toContain("full reindex");
    }
  });

  it("leaves a healthy index healthy, with no code beside an empty message", async () => {
    const { parseMemoryStatus, DEFAULT_MEMORY_SCHEDULE } = await lib();
    const status = await parseMemoryStatus(REAL_STATUS, IDLE_MEMORY_RUN, DEFAULT_MEMORY_SCHEDULE);
    expect(status.health).toBe("healthy");
    expect(status.error).toBe("");
    expect(status.errorCode).toBe("");
  });

  it("keeps the fingerprint stable for a configuration and changes it with the model", async () => {
    const { parseMemoryStatus, DEFAULT_MEMORY_SCHEDULE } = await lib();
    const a = await parseMemoryStatus(REAL_STATUS, IDLE_MEMORY_RUN, DEFAULT_MEMORY_SCHEDULE);
    const again = await parseMemoryStatus(REAL_STATUS, IDLE_MEMORY_RUN, DEFAULT_MEMORY_SCHEDULE);
    expect(a.fingerprint).toBe(again.fingerprint);
    expect(a.fingerprint).not.toBe("");

    const rows = JSON.parse(JSON.stringify(REAL_STATUS)) as unknown;
    (rows as Array<{ status: { model: string } }>)[0].status.model = "text-embedding-3-large";
    const other = await parseMemoryStatus(rows, IDLE_MEMORY_RUN, DEFAULT_MEMORY_SCHEDULE);
    expect(other.fingerprint).not.toBe(a.fingerprint);
  });

  it("says unavailable rather than pretending, when the CLI says nothing", async () => {
    const { parseMemoryStatus, DEFAULT_MEMORY_SCHEDULE } = await lib();
    const status = await parseMemoryStatus([{ agentId: "main", status: {} }], IDLE_MEMORY_RUN, DEFAULT_MEMORY_SCHEDULE);
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

  it("uses the server Node runtime when the CLI lives beside an obsolete Node", async () => {
    const cli = path.join(tmpDir, "openclaw");
    await fs.writeFile(path.join(tmpDir, "node"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
    await fs.writeFile(cli,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(REAL_STATUS))});\n`,
      { mode: 0o755 },
    );
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = cli;
    const { getMemoryStatus } = await lib();
    const status = await getMemoryStatus();
    expect(status.available).toBe(true);
    expect(status.health).toBe("healthy");
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
    expect(status.errorCode).toBe("status_unavailable");
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
    delete process.env.CLAWKEEP_MEMORY_EMBED_LOCK;
    vi.useRealTimers();
    // A clock spy a failed assertion left behind would put every later test
    // in this file 300 s ahead.
    vi.restoreAllMocks();
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

  /**
   * F-C of the real-browser sweep: the read that flipped the card's `running`
   * off carried the MID-REBUILD reading (identity "mismatched", one pending
   * file) because the probe behind it had started before the run settled and
   * `invalidateMemoryStatusCache` ran, and finished after. At the slow cadence
   * that followed, the amber "Run a full reindex" banner sat for 30 s over an
   * index that had just been rebuilt.
   *
   * The CLI is a script that answers a DIFFERENT payload per call, so the
   * tests can tell which probe's reading a caller was handed, and it HOLDS
   * each answer until the test releases it, so "that probe is in flight" is
   * read off the counter rather than guessed from a sleep. Asked to index it
   * holds the same way, so a run's finish — the real one, in
   * `startMemoryIndex` — lands at the moment the test chose. Every hold is
   * bounded, so a probe a failing test forgot cannot outlive it.
   */
  async function withProbeAnswers(identities: string[]): Promise<{
    mod: typeof import("@/lib/clawkeep-memory");
    probes: () => Promise<number>;
    /** Lets probe N answer. */
    release: (n: number) => Promise<void>;
    /** Lets the held index run exit 0 — the real finish follows. */
    releaseIndex: () => Promise<void>;
    /** Waits until probe N has been spawned (it is then held). */
    untilProbes: (n: number) => Promise<void>;
    /** Waits until a peek reads that identity. */
    untilPeek: (identity: string) => Promise<void>;
  }> {
    for (const [i, identity] of identities.entries()) {
      const payload = JSON.parse(JSON.stringify(REAL_STATUS)) as Array<{
        status: { custom: { indexIdentity: { status: string } } };
      }>;
      payload[0].status.custom.indexIdentity.status = identity;
      await fs.writeFile(path.join(tmpDir, `answer-${i + 1}.json`), JSON.stringify(payload));
    }
    const counter = path.join(tmpDir, "probe-count");
    const script = path.join(tmpDir, "gated-openclaw");
    // The count is taken BEFORE the hold, so a test can settle a run while a
    // known probe is in flight; a call past the last answer repeats it.
    await fs.writeFile(script, [
      "#!/bin/sh",
      'hold() { i=0; while [ ! -e "$1" ] && [ "$i" -lt 500 ]; do sleep 0.02; i=$((i+1)); done; }',
      `if [ "$2" = index ]; then hold "${tmpDir}/go-index"; exit 0; fi`,
      `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${counter}"`,
      `hold "${tmpDir}/go-$n"`,
      `[ "$n" -gt ${identities.length} ] && n=${identities.length}`,
      `cat "${tmpDir}/answer-$n.json"`,
      "",
    ].join("\n"), { mode: 0o755 });
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = script;
    process.env.CLAWKEEP_MEMORY_EMBED_LOCK = path.join(tmpDir, "embed.lock");
    vi.resetModules();
    const mod = await import("@/lib/clawkeep-memory");
    const probes = async () => Number((await fs.readFile(counter, "utf8").catch(() => "0")).trim());
    const until = async (what: string, ready: () => Promise<boolean>) => {
      for (let i = 0; i < 250; i++) {
        if (await ready()) return;
        await settle(20);
      }
      throw new Error(`${what} never happened`);
    };
    return {
      mod,
      probes,
      release: (n) => fs.writeFile(path.join(tmpDir, `go-${n}`), ""),
      releaseIndex: () => fs.writeFile(path.join(tmpDir, "go-index"), ""),
      untilProbes: (n) => until(`probe ${n}`, async () => (await probes()) >= n),
      untilPeek: (identity) => until(`a peek of ${identity}`, async () => mod.peekMemoryStatus()?.indexIdentity === identity),
    };
  }

  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("probes once more when a run settled under the probe, and answers the caller with that reading", async () => {
    const { mod, probes, release, untilProbes } = await withProbeAnswers(["mismatched", "valid"]);
    const pending = mod.getMemoryStatus();
    await untilProbes(1);
    // A run finishes while the first probe is still in flight.
    mod.invalidateMemoryStatusCache();
    await release(1);
    await untilProbes(2);
    await release(2);
    const status = await pending;
    // The caller gets the second probe's reading, never the straddled one.
    expect(status.indexIdentity).toBe("valid");
    expect(await probes()).toBe(2);
    // ...and that reading is fresh and settled: the next read is answered
    // from it, with no third process booted behind it (a third would be held,
    // and would show on the counter).
    expect((await mod.getMemoryStatus()).indexIdentity).toBe("valid");
    await settle(100);
    expect(await probes()).toBe(2);
  });

  it("serves a probe nothing invalidated as it is, without a second process", async () => {
    const { mod, probes, release, untilProbes } = await withProbeAnswers(["mismatched", "valid"]);
    const pending = mod.getMemoryStatus();
    await untilProbes(1);
    await release(1);
    expect((await pending).indexIdentity).toBe("mismatched");
    await settle(100);
    expect(await probes()).toBe(1);
  });

  it("retries once and never loops when the retry straddles as well; the read after it pays the probe that settles", async () => {
    const { mod, probes, release, untilProbes } = await withProbeAnswers(["mismatched", "mismatched", "valid"]);
    const pending = mod.getMemoryStatus();
    await untilProbes(1);
    mod.invalidateMemoryStatusCache();
    await release(1);
    // A second run settles under the retry.
    await untilProbes(2);
    mod.invalidateMemoryStatusCache();
    await release(2);
    // Bounded: the caller is answered after the retry, with its reading, and
    // no third probe starts on its own.
    const status = await pending;
    expect(status.indexIdentity).toBe("mismatched");
    await settle(100);
    expect(await probes()).toBe(2);
    // That reading predates the last change, and nothing is running: the next
    // read waits for one more probe rather than serving it — the settled
    // index is what it is answered with.
    const next = mod.getMemoryStatus();
    await untilProbes(3);
    await release(3);
    expect((await next).indexIdentity).toBe("valid");
    expect(mod.peekMemoryStatus()?.indexIdentity).toBe("valid");
    await settle(100);
    expect(await probes()).toBe(3);
  });

  it("keeps the reading it had while the retry runs, rather than showing the mid-run one to a peek", async () => {
    // A peek during the retry is answered with the pre-run reading — stale,
    // but the index as it was — not with the straddled probe's. The third
    // answer differs from the first so the last peek proves the retried
    // reading REPLACED the pre-run one rather than merely matching it.
    const { mod, probes, release, untilProbes } = await withProbeAnswers(["valid", "mismatched", "missing"]);
    const warm = mod.warmMemoryStatusCache();
    await untilProbes(1);
    await release(1);
    await warm;
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 300_000);
    const refreshed = mod.warmMemoryStatusCache();
    await untilProbes(2);
    mod.invalidateMemoryStatusCache();
    await release(2);
    // The straddled "mismatched" reading came back and was thrown away; the
    // retry is in flight, and the peek still reads the index as it was.
    await untilProbes(3);
    expect(mod.peekMemoryStatus()?.indexIdentity).toBe("valid");
    await release(3);
    await refreshed;
    expect(mod.peekMemoryStatus()?.indexIdentity).toBe("missing");
    await settle(100);
    expect(await probes()).toBe(3);
  });

  /**
   * The two reads the sweep actually saw, driven through the REAL finish in
   * `startMemoryIndex` with a held indexer: the card holds a reading, so it
   * never waits on a probe the way the cold callers above do — what it is
   * answered with after the pass is `getMemoryStatus`'s rule, not the
   * retry's.
   */
  it("answers the read after a run with the settled reading, not one a probe took while the pass was writing the index", async () => {
    // The pre-run reading, the one a TTL probe takes mid-pass, the post-run one.
    const { mod, probes, release, releaseIndex, untilProbes, untilPeek } =
      await withProbeAnswers(["valid", "mismatched", "valid"]);
    const warm = mod.warmMemoryStatusCache();
    await untilProbes(1);
    await release(1);
    await warm;
    expect((await mod.startMemoryIndex("full", "manual")).accepted).toBe(true);
    // The cache ages past its TTL during the pass; the card's poll is answered
    // at once from the pre-run reading and kicks a probe behind it, as ever.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_000);
    const during = await mod.getMemoryStatus();
    expect(during.run.status).toBe("running");
    expect(during.indexIdentity).toBe("valid");
    // That probe comes back while the pass is still writing: stored — a
    // reading is a reading while the run is going — but never settled.
    await untilProbes(2);
    await release(2);
    await untilPeek("mismatched");
    // The pass ends; the finish starts the post-run probe and holds nothing.
    await releaseIndex();
    await untilProbes(3);
    // The read that flips the card out of "running" WAITS for that probe
    // rather than answering from the mid-pass reading...
    let answered = false;
    const flip = mod.getMemoryStatus().then((s) => { answered = true; return s; });
    await settle(200);
    expect(answered).toBe(false);
    await release(3);
    const status = await flip;
    expect(status.run.status).toBe("succeeded");
    expect(status.indexIdentity).toBe("valid");
    expect(await probes()).toBe(3);
    // ...and that reading is settled: the next read is answered from it.
    expect((await mod.getMemoryStatus()).indexIdentity).toBe("valid");
    await settle(100);
    expect(await probes()).toBe(3);
  });

  it("answers the read after a run with the retried reading when the run settled under a probe, even for a caller that held one", async () => {
    // The owner pressed Full reindex OVER the amber banner: the pre-run
    // reading says "mismatched" too, so answering it after the pass would
    // have drawn the same banner over the rebuilt index.
    const { mod, probes, release, releaseIndex, untilProbes } =
      await withProbeAnswers(["mismatched", "mismatched", "valid"]);
    const warm = mod.warmMemoryStatusCache();
    await untilProbes(1);
    await release(1);
    await warm;
    expect((await mod.startMemoryIndex("full", "manual")).accepted).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_000);
    expect((await mod.getMemoryStatus()).run.status).toBe("running");
    // The TTL probe is in flight when the pass ends: the finish settles under
    // it, it is retried, and the read after the pass waits for the retry.
    await untilProbes(2);
    await releaseIndex();
    await release(2);
    await untilProbes(3);
    let answered = false;
    const flip = mod.getMemoryStatus().then((s) => { answered = true; return s; });
    await settle(200);
    expect(answered).toBe(false);
    await release(3);
    const status = await flip;
    expect(status.run.status).toBe("succeeded");
    expect(status.indexIdentity).toBe("valid");
    expect(await probes()).toBe(3);
    await settle(100);
    expect(await probes()).toBe(3);
  });
});

describe("the switch, read where the run actually starts", () => {
  it("refuses a start while Memory Shard is off, and leaves no lock behind", async () => {
    // Both callers check the switch before they get here, and neither check is
    // the authorisation: resolveIndexMode can wait seconds on a cold CLI probe,
    // and a switch flipped inside that window would otherwise start the very
    // pass it forbids. Read inside the lock, the two are on one side of it.
    shard.enabled = false;
    const { startMemoryIndex } = await lib();
    const { accepted, declined } = await startMemoryIndex("full", "manual");
    expect(accepted).toBe(false);
    expect(declined).toBe("disabled");
    // The lock is handed back rather than left for the next caller to trip on,
    // and nothing was written that would show as a run in the panel.
    for (const left of ["memory-index.lock", "memory-index-state.json"]) {
      expect(await fs.access(path.join(tmpDir, left)).then(() => true, () => false)).toBe(false);
    }
  });
});

describe("how a run ends", () => {
  afterEach(() => {
    delete process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN;
    delete process.env.CLAWKEEP_MEMORY_EMBED_LOCK;
  });

  const settledRun = () => settledMemoryRun(tmpDir);

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
      expect(run.errorCode).toBe("migration_busy");
      expect(run.error).not.toContain("interrupted");
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("keeps the CLI's own reason for the failure, where the box can be read", async () => {
    // The run is spawned with the CLI's stderr thrown away, so a pass that
    // died in 1.3 s left the owner with the catch-all "check that the
    // embedding model is available" — about an embedder that was answering
    // 200s — and nothing anywhere on the box said why. The sentence the owner
    // gets is still the fixed one (raw CLI output never crosses the API
    // boundary), but the reason now reaches the device log.
    const script = path.join(tmpDir, "fake-index");
    await fs.writeFile(script, [
      "#!/bin/sh",
      "echo 'loading index...' >&2",
      "echo 'vector dimension mismatch: index 768, model 1024' >&2",
      "exit 1",
      "",
    ].join("\n"), { mode: 0o755 });
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = script;
    process.env.CLAWKEEP_MEMORY_EMBED_LOCK = path.join(tmpDir, "embed.lock");
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { startMemoryIndex } = await import("@/lib/clawkeep-memory");
      expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);
      const run = await settledRun();
      expect(run.status).toBe("failed");
      expect(run.error).toContain("Check that the embedding model is available");
      expect(run.errorCode).toBe("index_failed");
      const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toContain("vector dimension mismatch: index 768, model 1024");
      // The LAST word it said, not the whole transcript.
      expect(logged).not.toContain("loading index...");
    } finally {
      warn.mockRestore();
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
    expect(run.errorCode).toBe("interrupted");
    expect(run.error).not.toContain("embedding model");
  });
});

/**
 * TASK-1024: a box that had Memory Shard indexed before 4.0.
 *
 * The 4.0 core changed how text is cut into chunks, so every index built
 * before it is one the core disowns. It says so in the status payload — and
 * ClawBox read three spellings of `indexIdentity.status` and answered
 * "unknown" to the one the new core actually sends, so the panel showed a
 * healthy-looking nothing, "Index now" ran the incremental pass that cannot
 * succeed against a disowned index, and the failure fell through to "check
 * that the embedding model is available" about a model that was answering.
 *
 * The payloads below are the captured one from a real box with only the
 * fields under test changed, so a CLI that renames them breaks this.
 */
describe("an index the update left behind", () => {
  function payloadWith(
    identity: Record<string, unknown> | null,
    extra: Record<string, unknown> = {},
  ): unknown {
    const payload = JSON.parse(JSON.stringify(REAL_STATUS)) as Array<{ status: Record<string, unknown> }>;
    const custom = payload[0].status.custom as Record<string, unknown>;
    if (identity) custom.indexIdentity = identity;
    else delete custom.indexIdentity;
    Object.assign(payload[0].status, extra);
    return payload;
  }

  async function read(raw: unknown) {
    const { parseMemoryStatus, DEFAULT_MEMORY_SCHEDULE } = await lib();
    return await parseMemoryStatus(raw, IDLE_MEMORY_RUN, DEFAULT_MEMORY_SCHEDULE);
  }

  /** The shape the customer's box reported, with the core's own wording. */
  const CHUNKING_VERDICT = {
    status: "stale",
    reason: "index chunking implementation changed",
    owner: "openclaw",
    code: "chunking_version",
  };

  it("reads the core's chunking verdict whatever it calls the status", async () => {
    const status = await read(payloadWith(CHUNKING_VERDICT));
    expect(status.indexIdentity).toBe("mismatched");
    expect(status.indexIdentityCode).toBe("chunking_version");
    expect(status.health).toBe("degraded");
  });

  it("sends the owner to the button instead of to the embedding model", async () => {
    const status = await read(payloadWith(CHUNKING_VERDICT));
    expect(status.errorCode).toBe("index_rebuild_required");
    expect(status.error).toContain("rebuilt after the update");
    expect(status.error).not.toContain("embedding model");
  });

  it("still blames the model when the model is what changed", async () => {
    // Not every mismatch is the update's doing, and an owner who moved memory
    // onto another embedder must not be told to wait for a rebuild that will
    // not help them.
    const status = await read(payloadWith({ status: "mismatched", code: "embedding_model" }));
    expect(status.errorCode).toBe("index_identity_mismatched");
    expect(status.error).toContain("configured embedding model");
  });

  it("does not invent a verdict out of a status it does not recognise", async () => {
    // A word with no reason and no code behind it is a core reporting
    // something this build has never heard of — not a core reporting a fault.
    const status = await read(payloadWith({ status: "provisional" }));
    expect(status.indexIdentity).toBe("unknown");
    expect(status.errorCode).toBe("");
  });

  it("is silent about an identity block the core did not send at all", async () => {
    const status = await read(payloadWith(null));
    expect(status.indexIdentity).toBe("unknown");
    expect(status.indexIdentityCode).toBe("");
    expect(status.errorCode).toBe("");
  });

  it("names a provider the core fell back to, which used to be invisible", async () => {
    // The half of TASK-1024 a full reindex could not fix: the configuration
    // says one embedder and the core is using another, so the rebuilt index
    // is rebuilt with the wrong model and search is no better afterwards.
    const status = await read(payloadWith(null, { requestedProvider: "openai-compatible", provider: "ollama" }));
    expect(status.requestedProvider).toBe("openai-compatible");
    expect(status.errorCode).toBe("provider_mismatch");
    expect(status.error).toContain("Re-run Memory Shard setup");
    expect(status.health).toBe("degraded");
  });

  it("names the fallback FIRST, because rebuilding under it is wasted work", async () => {
    const status = await read(
      payloadWith(CHUNKING_VERDICT, { requestedProvider: "openai-compatible", provider: "ollama" }),
    );
    expect(status.indexIdentity).toBe("mismatched");
    expect(status.errorCode).toBe("provider_mismatch");
  });

  it("does not call a provider the config never pinned a fallback", async () => {
    // `auto` is a value this box's own boot script recognises and migrates
    // (scripts/ensure-local-embeddings.sh, `""|auto|ollama`). It means "pick
    // one", so the core resolving it IS the configuration being honoured —
    // and calling that a fallback would put an amber banner, a degraded chip
    // and "re-run setup" on the failure of every box that never pinned one.
    // The identity is left VALID: the point is that an otherwise healthy box
    // stays healthy, so the assertion has to be able to tell the difference.
    const status = await read(payloadWith({ status: "valid" }, { requestedProvider: "auto", provider: "ollama" }));
    expect(status.errorCode).toBe("");
    expect(status.health).toBe("healthy");
  });

  it("does not read a difference of spelling as a difference of provider", async () => {
    const status = await read(payloadWith({ status: "valid" }, { requestedProvider: "Ollama", provider: "ollama" }));
    expect(status.errorCode).toBe("");
    expect(status.health).toBe("healthy");
  });

  it("says nothing about a core that used the provider it was asked for", async () => {
    // The captured payload: requestedProvider and provider both "ollama".
    const status = await read(REAL_STATUS);
    expect(status.requestedProvider).toBe("ollama");
    expect(status.errorCode).toBe("");
    expect(status.health).toBe("healthy");
  });
});

describe("what a disowned index makes Index now run", () => {
  afterEach(() => {
    delete process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN;
    delete process.env.CLAWKEEP_MEMORY_EMBED_LOCK;
  });

  /** A CLI that answers the status probe and fails every index pass. */
  async function withCli(mutate: (status: Record<string, unknown>) => void): Promise<string> {
    const payload = JSON.parse(JSON.stringify(REAL_STATUS)) as Array<{ status: Record<string, unknown> }>;
    mutate(payload[0].status);
    const script = path.join(tmpDir, "fake-openclaw");
    await fs.writeFile(script, [
      "#!/bin/sh",
      'if [ "$2" = "status" ]; then',
      "cat <<'JSON'",
      JSON.stringify(payload),
      "JSON",
      "exit 0",
      "fi",
      "echo 'index identity rejected' >&2",
      "exit 1",
      "",
    ].join("\n"), { mode: 0o755 });
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = script;
    process.env.CLAWKEEP_MEMORY_EMBED_LOCK = path.join(tmpDir, "embed.lock");
    vi.resetModules();
    return script;
  }

  it("upgrades an incremental pass on an index the core has disowned", async () => {
    // 512 chunks, so the empty-index rule is not what is being tested: an
    // incremental pass over a disowned index cannot make it valid again, and
    // running one is how the customer's box failed in five seconds.
    await withCli((status) => {
      status.chunks = 512;
      status.files = 7;
      (status.custom as Record<string, unknown>).indexIdentity = { status: "stale", code: "chunking_version" };
    });
    const { resolveIndexMode } = await import("@/lib/clawkeep-memory");
    expect(await resolveIndexMode("incremental")).toBe("full");
  });

  it("leaves an index the core still owns on the incremental pass", async () => {
    await withCli((status) => { status.chunks = 512; status.files = 7; });
    const { resolveIndexMode } = await import("@/lib/clawkeep-memory");
    expect(await resolveIndexMode("incremental")).toBe("incremental");
  });

  it("blames the fallback, not the model, when the pass fails under one", async () => {
    await withCli((status) => {
      status.requestedProvider = "openai-compatible";
      status.provider = "ollama";
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { startMemoryIndex, getMemoryStatus } = await import("@/lib/clawkeep-memory");
      // The reading the panel takes to draw the banner, and the one the Full
      // reindex arm reads rather than paying for a probe of its own.
      expect((await getMemoryStatus()).errorCode).toBe("provider_mismatch");
      expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);
      const run = await settledMemoryRun(tmpDir);
      expect(run.status).toBe("failed");
      expect(run.errorCode).toBe("provider_mismatch");
      expect(run.error).toContain("not the one you configured");
      expect(run.error).not.toContain("Check that the embedding model");
      // NOT the banner's sentence: the two fire together, and the card showed
      // the same instruction twice. This line says what happened to the pass.
      expect(run.error).not.toContain("Re-run Memory Shard setup");
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the catch-all where the box knows nothing better", async () => {
    await withCli(() => { /* the captured payload: nothing fell back */ });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { startMemoryIndex, getMemoryStatus } = await import("@/lib/clawkeep-memory");
      expect((await getMemoryStatus()).errorCode).toBe("");
      expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);
      const run = await settledMemoryRun(tmpDir);
      expect(run.errorCode).toBe("index_failed");
      expect(run.error).toContain("Check that the embedding model");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not wait for a probe it has no reading for, to word a full pass", async () => {
    // The Full reindex button must not grow a cold-probe wait: with no cached
    // reading the pass runs at once and is worded the way it always was.
    await withCli((status) => {
      status.requestedProvider = "openai-compatible";
      status.provider = "ollama";
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { startMemoryIndex } = await import("@/lib/clawkeep-memory");
      const started = performance.now();
      expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect((await settledMemoryRun(tmpDir)).errorCode).toBe("index_failed");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("what a scheduled slot runs against a disowned index (TASK-1197)", () => {
  /**
   * The button upgrades an incremental pass over a disowned index to a full
   * one (TASK-1024) — the owner asked for it. The schedule must not: a full
   * pass throws away every embedding the box has and spends hours rebuilding
   * them, and a fingerprint going missing is not the owner deciding to do that.
   * Driven through the real spawn-and-parse path, with every CLI call written
   * down, so "held back" is proved by the index command never being run.
   */
  let calls = "";

  afterEach(() => {
    delete process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN;
    delete process.env.CLAWKEEP_MEMORY_EMBED_LOCK;
  });

  async function withRecordingCli(mutate: (status: Record<string, unknown>) => void): Promise<void> {
    const payload = JSON.parse(JSON.stringify(REAL_STATUS)) as Array<{ status: Record<string, unknown> }>;
    mutate(payload[0].status);
    calls = path.join(tmpDir, "cli-calls");
    const script = path.join(tmpDir, "fake-openclaw");
    await fs.writeFile(script, [
      "#!/bin/sh",
      `echo "$*" >> '${calls}'`,
      'if [ "$2" = "status" ]; then',
      "cat <<'JSON'",
      JSON.stringify(payload),
      "JSON",
      "exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"), { mode: 0o755 });
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = script;
    process.env.CLAWKEEP_MEMORY_EMBED_LOCK = path.join(tmpDir, "embed.lock");
    vi.resetModules();
  }

  async function indexCalls(): Promise<string[]> {
    const text = await fs.readFile(calls, "utf8").catch(() => "");
    return text.split("\n").filter((line) => /\bmemory index\b/.test(line));
  }

  const disowned = (status: Record<string, unknown>) => {
    status.chunks = 512;
    status.files = 7;
    (status.custom as Record<string, unknown>).indexIdentity = { status: "stale", code: "chunking_version" };
  };

  it("holds a scheduled pass back from an index the core has disowned — no --force, no pass at all", async () => {
    await withRecordingCli(disowned);
    const { resolveIndexMode, startMemoryIndex } = await import("@/lib/clawkeep-memory");
    expect(await resolveIndexMode("incremental", "schedule")).toBeNull();

    const started = await startMemoryIndex("incremental", "schedule");
    expect(started.accepted).toBe(false);
    expect(started.declined).toBe("full_reindex_required");
    expect(await indexCalls()).toEqual([]);
    // Nothing started, so nothing is locked and no run is on record: the
    // banner the status already draws is what tells the owner.
    for (const left of ["memory-index.lock", "memory-index-state.json"]) {
      expect(await fs.access(path.join(tmpDir, left)).then(() => true, () => false)).toBe(false);
    }
  });

  it("holds it back just the same when the fingerprint is missing rather than different", async () => {
    await withRecordingCli((status) => {
      status.chunks = 512;
      status.files = 7;
      (status.custom as Record<string, unknown>).indexIdentity = { status: "missing" };
    });
    const { startMemoryIndex, getMemoryStatus } = await import("@/lib/clawkeep-memory");
    expect((await getMemoryStatus()).errorCode).toBe("index_identity_missing");
    expect((await startMemoryIndex("incremental", "schedule")).declined).toBe("full_reindex_required");
    expect(await indexCalls()).toEqual([]);
  });

  it("still upgrades the owner's Index now on the same index, which is how it gets rebuilt", async () => {
    await withRecordingCli(disowned);
    const { resolveIndexMode, startMemoryIndex } = await import("@/lib/clawkeep-memory");
    expect(await resolveIndexMode("incremental", "manual")).toBe("full");
    expect((await startMemoryIndex("incremental", "manual")).accepted).toBe(true);
    const run = await settledMemoryRun(tmpDir);
    expect(run.mode).toBe("full");
    expect(run.trigger).toBe("manual");
    const [index] = await indexCalls();
    expect(index).toContain("--force");
  });

  it("gives the schedule the first build of an index that holds nothing — there is nothing to throw away", async () => {
    await withRecordingCli((status) => {
      status.chunks = 0;
      status.files = 0;
      (status.custom as Record<string, unknown>).indexIdentity = { status: "missing" };
    });
    const { resolveIndexMode } = await import("@/lib/clawkeep-memory");
    expect(await resolveIndexMode("incremental", "schedule")).toBe("full");
  });

  it("leaves a scheduled pass over a valid index incremental", async () => {
    await withRecordingCli((status) => { status.chunks = 512; status.files = 7; });
    const { startMemoryIndex } = await import("@/lib/clawkeep-memory");
    expect((await startMemoryIndex("incremental", "schedule")).accepted).toBe(true);
    const run = await settledMemoryRun(tmpDir);
    expect(run.mode).toBe("incremental");
    const [index] = await indexCalls();
    expect(index).not.toContain("--force");
  });

  it("asks a FRESH status for the schedule, so a cached empty reading cannot send --force over a built index", async () => {
    // The button reads the cache on purpose — a click must not wait on a
    // process boot — and pays for a stale zero with one extra pass the owner
    // asked for. The schedule has nobody waiting, and a stale zero there is
    // a re-embed on a timer.
    await withRecordingCli((status) => { status.chunks = 0; status.files = 0; });
    const { resolveIndexMode, getMemoryStatus } = await import("@/lib/clawkeep-memory");
    expect((await getMemoryStatus()).chunks).toBe(0);

    // A pass fills the index; the cache still holds the empty reading.
    const payload = JSON.parse(JSON.stringify(REAL_STATUS)) as Array<{ status: Record<string, unknown> }>;
    payload[0].status.chunks = 512;
    payload[0].status.files = 7;
    const script = process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN!;
    const body = (await fs.readFile(script, "utf8")).replace(/cat <<'JSON'\n.*\nJSON/s, `cat <<'JSON'\n${JSON.stringify(payload)}\nJSON`);
    await fs.writeFile(script, body, { mode: 0o755 });

    expect(await resolveIndexMode("incremental", "manual")).toBe("full");
    expect(await resolveIndexMode("incremental", "schedule")).toBe("incremental");
  });
});

describe("how far an OpenClaw pass has got", () => {
  afterEach(() => {
    delete process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN;
    delete process.env.CLAWKEEP_MEMORY_EMBED_LOCK;
    delete process.env.CLAWKEEP_MEMORY_AGENT_DB;
    delete process.env.CLAWKEEP_MEMORY_PTY_HOST;
  });

  /**
   * A stand-in for `openclaw memory index` that behaves like the real CLI's
   * reporter: `createCliProgress` prints NOTHING unless stderr is a terminal,
   * and draws its `line` face only for `--verbose`. So the numbers can only
   * reach the card if the pass is run on a pseudo-terminal with that flag —
   * which is exactly what the bytes below demand. It also writes chunks into
   * a scratch index as it goes, the way a full reindex does.
   */
  async function fakeIndexer(total: number): Promise<{ script: string; db: string }> {
    const db = path.join(tmpDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await fs.mkdir(path.dirname(db), { recursive: true });
    const script = path.join(tmpDir, "fake-index.mjs");
    await fs.writeFile(script, [
      `#!${process.execPath}`,
      "import { DatabaseSync } from 'node:sqlite';",
      "const verbose = process.argv.includes('--verbose');",
      "const tty = process.stderr.isTTY === true;",
      `const scratch = new DatabaseSync(${JSON.stringify(db)} + '.memory-reindex-' + crypto.randomUUID());`,
      "scratch.exec('PRAGMA journal_mode = WAL');",
      "scratch.exec('CREATE TABLE memory_index_chunks (id TEXT PRIMARY KEY)');",
      "const add = scratch.prepare('INSERT INTO memory_index_chunks VALUES (?)');",
      `const total = ${total};`,
      "const say = (done) => { if (tty && verbose) process.stderr.write(`\\r\\x1b[2KIndexing memory files\\u2026 ${done}/${total} \\u00b7 elapsed 0:0${done % 10} ${Math.round(done / total * 100)}%`); };",
      "say(0);",
      "for (let done = 1; done <= total; done += 1) {",
      "  await new Promise((r) => setTimeout(r, 400));",
      "  add.run('a' + done); add.run('b' + done);",
      "  say(done);",
      "}",
      "scratch.close();",
      "process.stderr.write('\\r\\x1b[2KMemory index updated (main): ' + total + ' files indexed.\\r\\n');",
      "",
    ].join("\n"), { mode: 0o755 });
    return { script, db };
  }

  it("publishes files done of total and the chunks written while the pass runs, then clears them", async () => {
    const { script, db } = await fakeIndexer(8);
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = script;
    process.env.CLAWKEEP_MEMORY_EMBED_LOCK = path.join(tmpDir, "embed.lock");
    process.env.CLAWKEEP_MEMORY_AGENT_DB = db;
    vi.resetModules();
    const { startMemoryIndex, readMemoryRunState } = await import("@/lib/clawkeep-memory");
    expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);

    const seen: Array<{ filesDone: number; filesTotal: number; chunks: number }> = [];
    for (let i = 0; i < 400; i += 1) {
      const run = await readMemoryRunState();
      if (run.status !== "running") break;
      if (run.progress && run.progress.filesTotal > 0) seen.push(run.progress);
      await new Promise((r) => setTimeout(r, 50));
    }
    const settled = await settledMemoryRun(tmpDir);
    expect(settled.status).toBe("succeeded");

    // A real fraction, with the total the CLI's scan found.
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((p) => p.filesTotal === 8)).toBe(true);
    expect(seen.every((p) => p.filesDone <= p.filesTotal)).toBe(true);
    // It MOVES — the whole complaint was a bar with no numbers for the length
    // of the pass.
    const done = seen.map((p) => p.filesDone);
    expect(Math.max(...done)).toBeGreaterThan(Math.min(...done));
    for (let i = 1; i < done.length; i += 1) expect(done[i]).toBeGreaterThanOrEqual(done[i - 1]);
    // Chunks come from the scratch index the pass is building.
    expect(Math.max(...seen.map((p) => p.chunks))).toBeGreaterThan(0);
    // And a finished run carries no bar.
    expect((await readMemoryRunState()).progress).toBeNull();
  });

  it("falls back to the bar with no numbers when there is no terminal to run it on", async () => {
    const { script, db } = await fakeIndexer(3);
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = script;
    process.env.CLAWKEEP_MEMORY_EMBED_LOCK = path.join(tmpDir, "embed.lock");
    process.env.CLAWKEEP_MEMORY_AGENT_DB = db;
    process.env.CLAWKEEP_MEMORY_PTY_HOST = path.join(tmpDir, "no-such-script");
    vi.resetModules();
    const { startMemoryIndex, readMemoryRunState } = await import("@/lib/clawkeep-memory");
    expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);
    const totals = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      const run = await readMemoryRunState();
      if (run.status !== "running") break;
      totals.add(run.progress?.filesTotal ?? 0);
      await new Promise((r) => setTimeout(r, 50));
    }
    // The run still happens — only the numbers are missing, and no total is
    // ever invented for it.
    expect((await settledMemoryRun(tmpDir)).status).toBe("succeeded");
    expect([...totals]).toEqual([0]);
  });
});

describe("the process the run supervises", () => {
  afterEach(() => {
    delete process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN;
    delete process.env.CLAWKEEP_MEMORY_EMBED_LOCK;
    delete process.env.CLAWKEEP_MEMORY_PTY_HOST;
  });

  /**
   * util-linux `flock` defaults to forking the command and waiting on it.
   * Without `--no-fork` the process this module records and signals would be
   * a WRAPPER: the timeout handler and the failed-state-write cleanup would
   * kill it and leave `openclaw memory index` running unsupervised, while the
   * lock it was holding is released along with the wrapper — the exact
   * opposite of what both paths are for.
   *
   * The same goes one level down: the installed `openclaw` is a launcher that
   * re-spawns the real CLI as a grandchild unless OPENCLAW_NO_RESPAWN is set,
   * and only forwards SIGTERM to it. The fake binary here does the same, so a
   * run that forgets the opt-out puts a launcher in between and fails these.
   *
   * Asserted against the real spawn, by giving the run a "binary" that writes
   * its own pid and its parent's, and records the SIGTERM it receives.
   */
  async function whoAmI(): Promise<{ marker: string; termed: string }> {
    const marker = path.join(tmpDir, "who-am-i");
    const termed = path.join(tmpDir, "termed");
    const script = path.join(tmpDir, "fake-index");
    await fs.writeFile(script, [
      "#!/bin/sh",
      'if [ -z "$OPENCLAW_NO_RESPAWN" ] && [ -z "$FAKE_INNER" ]; then FAKE_INNER=1 "$0" "$@" & wait; exit 0; fi',
      `trap 'printf TERM > ${JSON.stringify(termed)}; exit 143' TERM`,
      `printf '%s %s' "$$" "$PPID" > ${JSON.stringify(marker)}`,
      // Short sleeps, so the trap runs promptly when the signal lands.
      "i=0; while [ $i -lt 10 ]; do sleep 0.1; i=$((i+1)); done",
      "",
    ].join("\n"), { mode: 0o755 });
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = script;
    process.env.CLAWKEEP_MEMORY_EMBED_LOCK = path.join(tmpDir, "embed.lock");
    return { marker, termed };
  }

  async function recorded(marker: string): Promise<{ self: number; parent: number; childPid: number }> {
    for (let i = 0; i < 100 && !(await fs.readFile(marker, "utf8").catch(() => "")); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const [self, parent] = (await fs.readFile(marker, "utf8")).split(" ").map(Number);
    let childPid = 0;
    for (let i = 0; i < 200 && !childPid; i++) {
      childPid = JSON.parse(await fs.readFile(path.join(tmpDir, "memory-index-state.json"), "utf8")).childPid;
      if (!childPid) await new Promise((r) => setTimeout(r, 20));
    }
    return { self, parent, childPid };
  }

  it("on a terminal, is the terminal host the indexer runs directly under — no flock, shell or launcher between", async () => {
    const { marker } = await whoAmI();
    vi.resetModules();
    const { startMemoryIndex } = await import("@/lib/clawkeep-memory");
    expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);
    const { self, parent, childPid } = await recorded(marker);
    expect(self).toBeGreaterThan(0);
    // `script` execs the command through `sh -c 'exec …'` and flock execs the
    // CLI, so the indexer's parent is the very process this module recorded.
    expect(childPid).toBe(parent);
    expect(childPid).not.toBe(self);
    // Settle before the fixture directory is torn down — the run writes the
    // lock and the state file from its own close handler.
    expect((await settledMemoryRun(tmpDir)).status).toBe("succeeded");
  });

  it("on a terminal, hands the SIGTERM it is sent on to the indexer", async () => {
    const { marker, termed } = await whoAmI();
    vi.resetModules();
    const { startMemoryIndex } = await import("@/lib/clawkeep-memory");
    expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);
    const { childPid } = await recorded(marker);
    // Never signal pid 0: on Unix that targets this whole process group.
    expect(childPid).toBeGreaterThan(0);
    process.kill(childPid, "SIGTERM");
    await settledMemoryRun(tmpDir);
    expect(await fs.readFile(termed, "utf8")).toBe("TERM");
  });

  it("without a terminal, is the indexer itself", async () => {
    const { marker } = await whoAmI();
    process.env.CLAWKEEP_MEMORY_PTY_HOST = path.join(tmpDir, "no-such-script");
    vi.resetModules();
    const { startMemoryIndex } = await import("@/lib/clawkeep-memory");
    expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);
    const { self, childPid } = await recorded(marker);
    expect(self).toBeGreaterThan(0);
    expect(childPid).toBe(self);
    expect((await settledMemoryRun(tmpDir)).status).toBe("succeeded");
  });
});

// The embedder moved off ollama onto ClawBox's own llama.cpp, which OpenClaw
// reaches as `openai-compatible` at the loopback proxy. That provider id is
// the same one an owner uses for a server across the room, and the status the
// core answers carries the id but never the URL — so the URL is read from the
// config and passed in, and only a loopback host is "on device".
describe("an openai-compatible embedder is on device only at the loopback proxy", () => {
  const row = (provider: string, model = "qwen3-embedding-0.6b") => [{ agentId: "main", status: { provider, model } }];

  it("reads ClawBox's own embedder behind the proxy as local", async () => {
    const { parseMemoryStatus, DEFAULT_MEMORY_SCHEDULE } = await lib();
    const status = await parseMemoryStatus(
      row("openai-compatible"), IDLE_MEMORY_RUN, DEFAULT_MEMORY_SCHEDULE, new Date(),
      "http://127.0.0.1/setup-api/local-ai/embed/v1",
    );
    expect(status.provider).toBe("openai-compatible");
    expect(status.location).toBe("local");
  });

  it("reads the same provider id at another host as cloud", async () => {
    const { parseMemoryStatus, DEFAULT_MEMORY_SCHEDULE } = await lib();
    const status = await parseMemoryStatus(
      row("openai-compatible"), IDLE_MEMORY_RUN, DEFAULT_MEMORY_SCHEDULE, new Date(), "http://192.168.1.50:8081/v1",
    );
    expect(status.location).toBe("cloud");
  });

  it("refuses to guess when no address is recorded", async () => {
    // "unknown", never "local": the privacy claim on the Memory Shard card
    // rests on this field, and a guess in the flattering direction is the
    // one that lies.
    const { parseMemoryStatus, DEFAULT_MEMORY_SCHEDULE } = await lib();
    const status = await parseMemoryStatus(row("openai-compatible"), IDLE_MEMORY_RUN, DEFAULT_MEMORY_SCHEDULE);
    expect(status.location).toBe("unknown");
  });

  it("still reads the old ollama embedder as local, whatever the URL says", async () => {
    // The provider is checked before the URL: an ollama box whose config
    // happens to carry a remote address is still embedding on this box.
    const { parseMemoryStatus, DEFAULT_MEMORY_SCHEDULE } = await lib();
    const status = await parseMemoryStatus(
      row("ollama", "qwen3-embedding:0.6b"), IDLE_MEMORY_RUN, DEFAULT_MEMORY_SCHEDULE, new Date(),
      "http://192.168.1.50:8081/v1",
    );
    expect(status.location).toBe("local");
  });
});
