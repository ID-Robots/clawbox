import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

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

/** Build a small real index in the temp DATA_DIR. */
async function buildIndex(): Promise<void> {
  const local = await import("@/lib/memory-index-local");
  fs.writeFileSync(path.join(source, "notes.md"), "The deposit is two months' rent.");
  await local.writeLocalSources([source]);
  await local.runLocalIndexPass("full");
}

/** Wait for the run-state file to settle out of "running". */
async function settled(readState: () => Promise<{ status: string }>): Promise<{ status: string }> {
  for (let i = 0; i < 200; i += 1) {
    const state = await readState();
    if (state.status !== "running") return state;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the run never settled");
}

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
    await buildIndex();
    const { getMemoryStatus } = await lib();
    const status = await getMemoryStatus();
    expect(status.location).toBe("local");
    expect(status.provider).toBe("openai-compatible");
    expect(status.model).toBe("qwen3-embedding-0.6b");
  });

  it("is healthy, with real counts and a fingerprint", async () => {
    await buildIndex();
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
    await buildIndex();
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

  it("draws the existing amber banner when the embedder it was built for changed", async () => {
    await buildIndex();
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

    const { startMemoryIndex, readMemoryRunState } = await lib();
    const started = await startMemoryIndex("full", "manual");
    expect(started.accepted).toBe(true);
    // There is no openclaw binary on this SKU; spawning one is the bug this
    // guards against, and it would fail in a way that reads like a broken
    // embedder rather than like a missing arm.
    expect(spawned).toEqual([]);

    const final = await settled(readMemoryRunState);
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
    const { startMemoryIndex, readMemoryRunState } = await lib();
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
    await settled(readMemoryRunState);
  });

  it("declines a second start while one is going", async () => {
    for (let i = 0; i < 40; i += 1) {
      fs.writeFileSync(path.join(source, `note-${i}.md`), `Paragraph ${i}.\n\n`.repeat(40));
    }
    const local = await import("@/lib/memory-index-local");
    await local.writeLocalSources([source]);
    const { startMemoryIndex, readMemoryRunState } = await lib();

    const first = await startMemoryIndex("full", "manual");
    expect(first.accepted).toBe(true);
    const second = await startMemoryIndex("full", "manual");
    expect(second.accepted).toBe(false);
    expect(second.declined).toBe("running");
    await settled(readMemoryRunState);
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
    absent.value = false;
    const { startMemoryIndex, readMemoryRunState } = await lib();
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
    await settled(readMemoryRunState);
  });
});
