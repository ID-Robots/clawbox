import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IDLE_MEMORY_RUN, settledMemoryRun } from "@/tests/helpers/memory-run-state";

/**
 * Memory Shard's Hermes arm, at the seam.
 *
 * The port's whole claim to being small is that the two editions share
 * everything but the work in the middle: one `parseMemoryStatus`, one lock, one
 * run-state file, one reconcile, one error-code catalogue, and therefore one
 * set of screens and ten locale packs that neither arm can drift away from.
 * That claim is only worth as much as these tests.
 *
 * So there are two things to pin, and the second matters as much as the first:
 *
 *   1. What ClawBox's own index answers goes through the REAL parser and comes
 *      out a `ClawKeepMemoryStatus` the existing UI can draw — "on this device"
 *      rather than "unknown", a fingerprint, a health the rules agree with, and
 *      NO error code outside the union every locale already words.
 *   2. On an edition WITH OpenClaw not one byte of behaviour changed: the same
 *      argv, through flock, to the same binary.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const { dataDir, absent, spawned, shard } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("node:path") as typeof import("node:path");
  return {
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "memory-hermes-data-")),
    /** What `openclawIsAbsent()` answers — the one predicate the seam turns on. */
    absent: { value: true },
    /** Every child this module spawned. On the local arm there must be none. */
    spawned: [] as { cmd: string; args: string[] }[],
    shard: { enabled: true },
  };
});

vi.mock("@/lib/config-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config-store")>();
  const store = new Map<string, unknown>();
  return {
    ...actual,
    DATA_DIR: dataDir,
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
  };
});
vi.mock("@/lib/openclaw-config", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/openclaw-config")>(),
  openclawIsAbsent: () => absent.value,
  findOpenclawBin: () => "/home/clawbox/.npm-global/bin/openclaw",
}));
vi.mock("@/lib/embed-server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/embed-server")>(),
  getEmbedProxyBaseUrl: () => "http://127.0.0.1/setup-api/local-ai/embed/v1",
  getEmbedProvisioningStatus: async () => ({
    installed: true, binaryAvailable: true, modelAvailable: true, modelBytes: 1, binPath: "", modelPath: "",
  }),
}));
vi.mock("@/lib/local-ai-token", () => ({ getLocalAiToken: () => "t".repeat(64) }));
vi.mock("@/lib/memory-shard", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/memory-shard")>(),
  getMemoryShardEnabled: async () => shard.enabled,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[], opts: unknown) => {
      spawned.push({ cmd, args });
      // A process that exits 0 at once, so the OpenClaw arm's own bookkeeping
      // runs to completion without an openclaw binary being anywhere near it.
      return actual.spawn("true", [], opts as never);
    }),
  };
});

let clawkeepDir = "";
let source = "";

beforeEach(async () => {
  absent.value = true;
  shard.enabled = true;
  spawned.length = 0;
  source = fs.mkdtempSync(path.join(os.tmpdir(), "memory-hermes-src-"));
  clawkeepDir = await fsp.mkdtemp(path.join(os.tmpdir(), "memory-hermes-clawkeep-"));
  process.env.CLAWKEEP_DATA_DIR = clawkeepDir;
  fs.rmSync(path.join(dataDir, "memory-index"), { recursive: true, force: true });
  // CLAWKEEP_DATA_DIR is read once at module load.
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string[] };
    return Response.json({ data: body.input.map((_t, index) => ({ index, embedding: [1, 0, 0.2] })) });
  }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.CLAWKEEP_DATA_DIR;
  await fsp.rm(clawkeepDir, { recursive: true, force: true });
  fs.rmSync(source, { recursive: true, force: true });
});

async function lib() {
  return await import("@/lib/clawkeep-memory");
}

/**
 * Build a real index in the temp DATA_DIR over the registered temp folder.
 *
 * With no `notes` it is the stock box — folders registered, nothing in them yet,
 * one finished pass; `keepFolder: false` is the state the captured OpenClaw
 * payload is in, a registered folder that is not on disk at all.
 */
async function buildIndex(
  { notes, keepFolder = true }: { notes?: string; keepFolder?: boolean } = {},
): Promise<void> {
  const local = await import("@/lib/memory-index-local");
  if (notes) fs.writeFileSync(path.join(source, "notes.md"), notes);
  await local.writeLocalSources([source]);
  if (!keepFolder) fs.rmSync(source, { recursive: true, force: true });
  await local.runLocalIndexPass("full");
}

const NOTES = "The deposit is two months' rent.";

/** Every value `MemoryStatusErrorCode` allows, which is every value a locale
 *  pack words. A status carrying anything else is English on a German desktop. */
const MEMORY_STATUS_CODES = [
  "",
  "index_identity_mismatched",
  "index_identity_missing",
  "provider_degraded",
  "status_unavailable",
];

describe("what ClawBox's own index tells the shared parser", () => {
  it("comes out as an embedder ON THIS DEVICE, not one it cannot place", async () => {
    // The trap this closes: `readEmbeddingRemoteBaseUrl()` reads openclaw.json,
    // which does not exist on this SKU, so it answers null and
    // providerLocation() reports "unknown" — an embedder running on loopback,
    // drawn as one the box cannot account for. The local arm passes its own
    // proxy URL instead.
    await buildIndex({ notes: NOTES });
    const { getMemoryStatus } = await lib();
    const status = await getMemoryStatus();
    expect(status.location).toBe("local");
    expect(status.provider).toBe("openai-compatible");
    expect(status.model).toBe("qwen3-embedding-0.6b");
  });

  it("is healthy, with real counts and a fingerprint", async () => {
    await buildIndex({ notes: NOTES });
    const { getMemoryStatus } = await lib();
    const status = await getMemoryStatus();
    expect(status.available).toBe(true);
    expect(status.health).toBe("healthy");
    expect(status.indexIdentity).toBe("valid");
    expect(status.semanticAvailable).toBe(true);
    expect(status.files).toBe(1);
    expect(status.chunks).toBeGreaterThan(0);
    expect(status.vectors).toBe(status.chunks);
    expect(status.indexBytes).toBeGreaterThan(0);
    expect(status.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it("says nothing no screen can word — a built index carries no code at all", async () => {
    // The whole reason for impersonating the CLI's JSON rather than writing a
    // second status producer. A new code here would be English on a German
    // desktop, and nothing in this repo would have failed.
    await buildIndex({ notes: NOTES });
    const status = await (await lib()).getMemoryStatus();
    expect(MEMORY_STATUS_CODES).toContain(status.errorCode);
    expect(status.errorCode).toBe("");
    expect(status.error).toBe("");
  });

  it("says the index fingerprint is missing on a box that has never been set up", async () => {
    const status = await (await lib()).getMemoryStatus();
    expect(MEMORY_STATUS_CODES).toContain(status.errorCode);
    expect(status.errorCode).toBe("index_identity_missing");
  });

  it("draws no attention badge and no remedy on a box with nothing to index", async () => {
    // What the card showed on the box: "Memory index ON … Needs attention — the
    // index fingerprint is missing. Run a full reindex" over FILES 0 · CHUNKS 0
    // and, underneath, the honest "Nothing to index yet". Three statements, two
    // of them contradicting the third, and the remedy was the full reindex that
    // had already run by hand four hours earlier and finished in 19 ms.
    await buildIndex();
    const { getMemoryStatus, invalidateMemoryStatusCache } = await lib();
    invalidateMemoryStatusCache();
    const status = await getMemoryStatus();
    expect(status.files).toBe(0);
    expect(status.chunks).toBe(0);
    expect(status.indexIdentity).toBe("valid");
    expect(status.health).toBe("healthy");
    expect(status.errorCode).toBe("");
    expect(status.error).toBe("");
  });

  it("says about an empty index exactly what the captured OpenClaw box says", async () => {
    // The parity this arm exists for, on the one state every new box is in. The
    // fixture is `openclaw memory status --agent main --deep --json` taken from a
    // real OpenClaw box that had never written a memory file: zero files, zero
    // chunks, a scan whose only issue is that the memory DIRECTORY IS NOT THERE
    // — and `indexIdentity: valid`. So the OpenClaw edition has always shown
    // that box as healthy, and the nag was this arm's alone. Both editions draw
    // the same card, so the Hermes side is driven into the fixture's own state,
    // a registered folder that does not exist, and has to agree about it.
    const real = JSON.parse(
      await fsp.readFile(new URL("../fixtures/openclaw-memory-status.json", import.meta.url), "utf8"),
    ) as Array<{
      scan: { totalFiles: number; issues: string[] };
      status: { custom: { indexIdentity: { status: string } } };
    }>;
    expect(real[0].scan.totalFiles).toBe(0);
    expect(real[0].scan.issues.length).toBe(1);
    expect(real[0].status.custom.indexIdentity.status).toBe("valid");

    const { getMemoryStatus, invalidateMemoryStatusCache, parseMemoryStatus, DEFAULT_MEMORY_SCHEDULE } = await lib();
    const openclaw = await parseMemoryStatus(real, IDLE_MEMORY_RUN, DEFAULT_MEMORY_SCHEDULE);
    await buildIndex({ keepFolder: false });
    invalidateMemoryStatusCache();
    const hermes = await getMemoryStatus();
    expect(hermes.indexIdentity).toBe(openclaw.indexIdentity);
    expect(hermes.health).toBe(openclaw.health);
    expect(hermes.errorCode).toBe(openclaw.errorCode);
    expect(hermes.error).toBe(openclaw.error);
  });

  it("draws the existing amber banner when the embedder it was built for changed", async () => {
    await buildIndex({ notes: NOTES });
    const { LOCAL_INDEX_PATH } = await import("@/lib/memory-index-local");
    const { openSqlite } = await import("@/lib/openclaw-session-store");
    const db = openSqlite(LOCAL_INDEX_PATH, false);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'identity'").run("another-embedder");
    db.close();

    const { getMemoryStatus, invalidateMemoryStatusCache } = await lib();
    invalidateMemoryStatusCache();
    const status = await getMemoryStatus();
    expect(status.indexIdentity).toBe("mismatched");
    expect(status.health).toBe("degraded");
    // Word for word what the OpenClaw box shows, from the same parser.
    expect(status.errorCode).toBe("index_identity_mismatched");
    expect(status.error).toMatch(/full reindex/i);
  });
});

describe("which arm runs the pass", () => {
  it("indexes IN THIS PROCESS on the edition with no OpenClaw, spawning nothing", async () => {
    fs.writeFileSync(path.join(source, "notes.md"), "The deposit is two months' rent.");
    const local = await import("@/lib/memory-index-local");
    await local.writeLocalSources([source]);

    const { startMemoryIndex } = await lib();
    const started = await startMemoryIndex("full", "manual");
    expect(started.accepted).toBe(true);
    // There is no openclaw binary on this SKU; spawning one is the bug this
    // guards against, and it would fail in a way that reads like a broken
    // embedder rather than like a missing arm.
    expect(spawned).toEqual([]);

    const final = await settledMemoryRun(clawkeepDir);
    expect(final.status).toBe("succeeded");
    const status = await (await lib()).getMemoryStatus();
    expect(status.files).toBe(1);
  });

  it("records THIS process as the run's owner, so the reconcile still works", async () => {
    // `acquireRunLock` asks `processIsAlive(childPid)`. For an in-process pass
    // the answer that means "still going" is this very pid — and a run lost to
    // a web-server restart then reads dead and is reconciled as interrupted,
    // exactly as a killed child was. Read WHILE the pass is going, because the
    // field is cleared when it finishes.
    for (let i = 0; i < 60; i += 1) {
      fs.writeFileSync(path.join(source, `note-${i}.md`), `Paragraph ${i}.\n\n`.repeat(60));
    }
    const local = await import("@/lib/memory-index-local");
    await local.writeLocalSources([source]);
    const { startMemoryIndex } = await lib();
    await startMemoryIndex("full", "manual");

    const statePath = path.join(clawkeepDir, "memory-index-state.json");
    let sawPid = 0;
    for (let i = 0; i < 200 && !sawPid; i += 1) {
      const state = JSON.parse(await fsp.readFile(statePath, "utf8")) as { childPid: number; status: string };
      if (state.status === "running" && state.childPid) sawPid = state.childPid;
      if (state.status !== "running") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(sawPid, "the run must record a live pid while it works").toBe(process.pid);
    await settledMemoryRun(clawkeepDir);
  });

  it("declines a second start while one is going", async () => {
    for (let i = 0; i < 40; i += 1) {
      fs.writeFileSync(path.join(source, `note-${i}.md`), `Paragraph ${i}.\n\n`.repeat(40));
    }
    const local = await import("@/lib/memory-index-local");
    await local.writeLocalSources([source]);
    const { startMemoryIndex } = await lib();

    const first = await startMemoryIndex("full", "manual");
    expect(first.accepted).toBe(true);
    const second = await startMemoryIndex("full", "manual");
    expect(second.accepted).toBe(false);
    expect(second.declined).toBe("running");
    await settledMemoryRun(clawkeepDir);
  });

  it("refuses to index at all while the owner's switch is off", async () => {
    shard.enabled = false;
    const { startMemoryIndex } = await lib();
    const result = await startMemoryIndex("full", "manual");
    expect(result.accepted).toBe(false);
    expect(result.declined).toBe("disabled");
    expect(spawned).toEqual([]);
  });

  it("still drives the OpenClaw CLI, argv for argv, where there IS an OpenClaw", async () => {
    // The regression guard for "additive": the other arm must be untouched.
    // Pinned WITHOUT a terminal host, which is the argv it has always had.
    absent.value = false;
    process.env.CLAWKEEP_MEMORY_PTY_HOST = path.join(clawkeepDir, "no-such-script");
    try {
      const { startMemoryIndex } = await lib();
      const started = await startMemoryIndex("full", "manual");
      expect(started.accepted).toBe(true);
      expect(spawned).toHaveLength(1);
      expect(spawned[0].cmd).toBe("flock");
      expect(spawned[0].args).toEqual([
        "--no-fork", "-n", "-E", "75",
        // The migration lock `scripts/ensure-local-embeddings.sh` also takes; its
        // path is derived from the box's layout, so only its shape is pinned.
        expect.stringMatching(/\.lock$/),
        "/home/clawbox/.npm-global/bin/openclaw",
        "memory", "index", "--agent", "main", "--force",
      ]);
      await settledMemoryRun(clawkeepDir);
    } finally {
      delete process.env.CLAWKEEP_MEMORY_PTY_HOST;
    }
  });

  it("runs the same command on a terminal, with the one flag that makes its reporter print", async () => {
    // `script` is the terminal. Everything after `exec` is the argv above,
    // quoted for sh, plus `--verbose` — the reporter's `line` face.
    absent.value = false;
    process.env.CLAWKEEP_MEMORY_PTY_HOST = "/bin/sh";
    try {
      const { startMemoryIndex } = await lib();
      expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);
      expect(spawned).toHaveLength(1);
      expect(spawned[0].cmd).toBe("/bin/sh");
      const [q, e, c, command, typescript] = spawned[0].args;
      expect([q, e, c, typescript]).toEqual(["-q", "-e", "-c", "/dev/null"]);
      expect(command).toMatch(
        /^exec 'flock' '--no-fork' '-n' '-E' '75' '[^']+\.lock' '\/home\/clawbox\/\.npm-global\/bin\/openclaw' 'memory' 'index' '--agent' 'main' '--force' '--verbose'$/,
      );
      await settledMemoryRun(clawkeepDir);
    } finally {
      delete process.env.CLAWKEEP_MEMORY_PTY_HOST;
    }
  });
});

/**
 * TASK-1197 on the arm ClawBox indexes itself. `runLocalIndexPass` rebuilds on
 * its own when the embedder changed, so the schedule is held back twice: by the
 * plan, on the status it reads, and by the pass, on the store as it is when the
 * pass opens it — the plan's reading can be minutes old.
 */
describe("the schedule never rebuilds ClawBox's own index", () => {
  async function disownIndex(): Promise<void> {
    await buildIndex({ notes: NOTES });
    const { LOCAL_INDEX_PATH } = await import("@/lib/memory-index-local");
    const { openSqlite } = await import("@/lib/openclaw-session-store");
    const db = openSqlite(LOCAL_INDEX_PATH, false);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'identity'").run("another-embedder");
    db.close();
  }

  it("declines a slot over an index built for another embedder, and leaves every row where it was", async () => {
    await disownIndex();
    const embeds = vi.mocked(fetch);
    embeds.mockClear();
    const { startMemoryIndex, getMemoryStatus, invalidateMemoryStatusCache } = await lib();

    const started = await startMemoryIndex("incremental", "schedule");
    expect(started.accepted).toBe(false);
    expect(started.declined).toBe("full_reindex_required");
    // Not one embedding — not even the readiness probe a rebuild starts with.
    expect(embeds).not.toHaveBeenCalled();

    invalidateMemoryStatusCache();
    const status = await getMemoryStatus();
    expect(status.chunks).toBeGreaterThan(0);
    expect(status.indexIdentity).toBe("mismatched");
    expect(status.errorCode).toBe("index_identity_mismatched");
  });

  it("rebuilds the same index when the OWNER asks, which is the recovery the banner names", async () => {
    await disownIndex();
    const { startMemoryIndex, getMemoryStatus, invalidateMemoryStatusCache } = await lib();
    expect((await startMemoryIndex("incremental", "manual")).accepted).toBe(true);
    const run = await settledMemoryRun(clawkeepDir);
    expect(run.status).toBe("succeeded");
    expect(run.mode).toBe("full");
    invalidateMemoryStatusCache();
    expect((await getMemoryStatus()).indexIdentity).toBe("valid");
  });

  it("hands the pass the schedule's rule, and words the pass that found the store stale itself", async () => {
    // The race the pass-level check exists for: the plan read a valid index,
    // the embedder moved before the pass opened the store. The pass throws
    // before touching a row; the run line sends the owner to the button, not
    // to a model that is fine.
    await buildIndex({ notes: NOTES });
    const local = await import("@/lib/memory-index-local");
    const runLocalIndexPass = vi.fn(async () => { throw new local.IndexRebuildRequiredError(); });
    vi.doMock("@/lib/memory-index-local", () => ({ ...local, runLocalIndexPass }));
    // The real module is already in the graph (buildIndex loaded it); only a
    // fresh graph resolves the import through the mock.
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { startMemoryIndex } = await lib();
      expect((await startMemoryIndex("incremental", "schedule")).accepted).toBe(true);
      const run = await settledMemoryRun(clawkeepDir);
      expect(runLocalIndexPass).toHaveBeenCalledWith(
        "incremental", expect.anything(), expect.any(Function), { mayDiscard: false },
      );
      expect(run.status).toBe("failed");
      expect(run.errorCode).toBe("full_reindex_required");
      expect(run.error).toMatch(/full reindex/i);
      expect(run.error).not.toContain("Check that the embedding model");
    } finally {
      warn.mockRestore();
      vi.doUnmock("@/lib/memory-index-local");
    }
  });

  it("lets every run the owner starts discard, as it always could", async () => {
    await buildIndex({ notes: NOTES });
    const local = await import("@/lib/memory-index-local");
    const runLocalIndexPass = vi.fn(async () => ({ mode: "full" as const, files: 1, chunks: 1, failures: 0, capped: false }));
    vi.doMock("@/lib/memory-index-local", () => ({ ...local, runLocalIndexPass }));
    // The real module is already in the graph (buildIndex loaded it); only a
    // fresh graph resolves the import through the mock.
    vi.resetModules();
    try {
      const { startMemoryIndex } = await lib();
      expect((await startMemoryIndex("full", "manual")).accepted).toBe(true);
      await settledMemoryRun(clawkeepDir);
      expect(runLocalIndexPass).toHaveBeenCalledWith(
        "full", expect.anything(), expect.any(Function), { mayDiscard: true },
      );
    } finally {
      vi.doUnmock("@/lib/memory-index-local");
    }
  });
});

/**
 * The bar, at the seam.
 *
 * Progress rides on the run-state FILE, because that file is the only thing
 * every reader of a run shares — the route, the scheduler, and the second copy
 * of this module Next compiles into the same web server (see
 * `src/lib/process-store.ts`). So what is pinned here is what lands on disk
 * and what comes back out of `readMemoryRunState`, not an in-memory channel.
 *
 * And the other arm: `openclaw memory index` writes its progress through a
 * terminal reporter, so it has numbers only when it runs on a pseudo-terminal
 * (clawkeep-memory.test.ts drives that end to end). At dispatch it has counted
 * nothing, and without a terminal it never does — the field stays null and the
 * card draws a bar with no percentage rather than one it made up.
 */
describe("how far the pass has got", () => {
  const statePath = () => path.join(clawkeepDir, "memory-index-state.json");

  async function readState(): Promise<Record<string, unknown>> {
    return JSON.parse(await fsp.readFile(statePath(), "utf8").catch(() => "{}")) as Record<string, unknown>;
  }

  it("puts files done, files found and chunks on the running record", async () => {
    for (let i = 0; i < 80; i += 1) {
      fs.writeFileSync(path.join(source, `note-${i}.md`), `Paragraph ${i}.\n\n`.repeat(60));
    }
    const local = await import("@/lib/memory-index-local");
    await local.writeLocalSources([source]);
    const { startMemoryIndex } = await lib();
    await startMemoryIndex("full", "manual");

    let seen: { filesDone?: number; filesTotal?: number; chunks?: number } | null = null;
    for (let i = 0; i < 400 && !seen; i += 1) {
      const state = await readState();
      if (state.status === "running" && state.progress) {
        seen = state.progress as { filesDone?: number; filesTotal?: number; chunks?: number };
      }
      if (state.status !== "running") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(seen, "a running pass must say how far it has got").toBeTruthy();
    expect(seen!.filesTotal).toBe(80);
    expect(seen!.filesDone).toBeGreaterThanOrEqual(0);
    expect(seen!.filesDone).toBeLessThanOrEqual(80);
    expect(typeof seen!.chunks).toBe("number");
    await settledMemoryRun(clawkeepDir);
  });

  it("takes the bar back off the record when the pass ends", async () => {
    // A settled run with a bar on it is a card drawing progress over work that
    // is finished. The final write also has to WIN: it is a rename, and a
    // report still in flight would otherwise land on top of it for good.
    fs.writeFileSync(path.join(source, "notes.md"), "The deposit is two months' rent.");
    const local = await import("@/lib/memory-index-local");
    await local.writeLocalSources([source]);
    const { startMemoryIndex, readMemoryRunState } = await lib();
    await startMemoryIndex("full", "manual");
    const final = await settledMemoryRun(clawkeepDir);
    expect(final.status).toBe("succeeded");

    // Settled for long enough that any late report would have landed.
    await new Promise((r) => setTimeout(r, 120));
    const state = await readState();
    expect(state.status).toBe("succeeded");
    expect(state.progress).toBeNull();
    expect((await readMemoryRunState()).progress).toBeNull();
  });

  it("answers null on the OpenClaw arm at dispatch, before its CLI has counted anything", async () => {
    absent.value = false;
    const { startMemoryIndex } = await lib();
    const started = await startMemoryIndex("full", "manual");
    expect(started.accepted).toBe(true);
    expect(started.run.progress).toBeNull();
    await settledMemoryRun(clawkeepDir);
  });

  it("refuses a bar read off disk that would draw past its own end", async () => {
    // The file is written by another copy of this module while a pass runs, so
    // it is read as untrusted like everything else here: a fraction over 1 is
    // the one value that makes the bar visibly lie.
    const { readMemoryRunState } = await lib();
    await fsp.writeFile(statePath(), JSON.stringify({
      status: "running",
      mode: "full",
      trigger: "manual",
      startedAtMs: Date.now(),
      childPid: process.pid,
      progress: { filesDone: 9_000, filesTotal: 12, chunks: -4 },
    }));
    const run = await readMemoryRunState();
    expect(run.progress).toEqual({ filesDone: 12, filesTotal: 12, chunks: 0 });
  });

  it("ignores a bar on a record that is not running", async () => {
    const { readMemoryRunState } = await lib();
    await fsp.writeFile(statePath(), JSON.stringify({
      status: "succeeded",
      mode: "full",
      trigger: "manual",
      startedAtMs: Date.now() - 1_000,
      finishedAtMs: Date.now(),
      progress: { filesDone: 3, filesTotal: 9, chunks: 40 },
    }));
    expect((await readMemoryRunState()).progress).toBeNull();
  });
});
