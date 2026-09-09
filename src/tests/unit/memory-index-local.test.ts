import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * src/lib/memory-index-local.ts — Memory Shard's index on the edition that has
 * no OpenClaw.
 *
 * The thing under test is the promise the panel makes on that box: the counts
 * are real, a second pass costs nothing over an unchanged folder, a document
 * the owner deleted stops being findable, and the store never outlives the
 * model it was built for. Those are the four ways an index quietly lies while
 * still reporting "healthy", which is exactly what the OpenClaw arm gets from
 * the core for free and this arm has to earn.
 *
 * The embedder is stubbed at `fetch`, one deterministic vector per text, so a
 * ranking assertion is about the code and not about Qwen3. Everything else is
 * real: a real sqlite store on a real temp DATA_DIR, real files on disk.
 */

const { dataDir, embedCalls, embedFail, openclawConfig } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("node:path") as typeof import("node:path");
  return {
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "memory-index-data-")),
    /** Every text that reached the embedder, in order, across the run. */
    embedCalls: { texts: [] as string[], types: [] as string[] },
    /** When set, the next embeddings request answers this HTTP status. */
    embedFail: { status: 0 },
    /** What openclaw.json holds, for the one-time carry-over after a swap. */
    openclawConfig: { value: {} as unknown },
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
    __store: store,
  };
});
vi.mock("@/lib/embed-server", () => ({
  getEmbedProxyBaseUrl: () => "http://127.0.0.1/setup-api/local-ai/embed/v1",
  getEmbedProvisioningStatus: async () => ({ installed: true, binaryAvailable: true, modelAvailable: true, modelBytes: 1, binPath: "", modelPath: "" }),
}));
vi.mock("@/lib/local-ai-token", () => ({ getLocalAiToken: () => "t".repeat(64) }));
vi.mock("@/lib/openclaw-config", () => ({ readConfig: async () => openclawConfig.value }));

import {
  LOCAL_INDEX_PATH,
  _resetLocalMemoryCacheForTests,
  chunkText,
  localEmbeddingIdentity,
  localMemoryStatusJson,
  readLocalSources,
  runLocalIndexPass,
  searchLocalMemory,
  stampLocalEmbeddingIdentity,
  writeLocalSources,
} from "@/lib/memory-index-local";

/**
 * A stand-in embedder with the one property the ranking test needs: texts that
 * share words land near each other.
 *
 * Four dimensions, one per marker word, plus a constant so a text with no
 * marker still has a direction. Normalisation is the module's own job, which is
 * part of what this exercises.
 */
const MARKERS = ["deposit", "bicycle", "quarterly", "lasagne"];
function stubVector(text: string): number[] {
  const lower = text.toLowerCase();
  return [...MARKERS.map((m) => (lower.includes(m) ? 1 : 0)), 0.05];
}

function installFetchStub(): void {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    if (embedFail.status) {
      const status = embedFail.status;
      embedFail.status = 0;
      return new Response("nope", { status });
    }
    const body = JSON.parse(init.body) as { input: string[]; input_type: string };
    embedCalls.texts.push(...body.input);
    embedCalls.types.push(body.input_type);
    return Response.json({
      data: body.input.map((text, index) => ({ index, embedding: stubVector(text) })),
    });
  }));
}

let source: string;

beforeEach(async () => {
  source = fs.mkdtempSync(path.join(os.tmpdir(), "memory-index-src-"));
  embedCalls.texts = [];
  embedCalls.types = [];
  embedFail.status = 0;
  openclawConfig.value = {};
  installFetchStub();
  _resetLocalMemoryCacheForTests();
  fs.rmSync(path.dirname(LOCAL_INDEX_PATH), { recursive: true, force: true });
  await writeLocalSources([source]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(source, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function write(name: string, body: string): string {
  const file = path.join(source, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

/** What the index recorded as this file's mtime, for the skip rules. */
function storedMtime(file: string): number {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(LOCAL_INDEX_PATH, { readOnly: true });
  try {
    const row = db.prepare("SELECT mtime_ms FROM files WHERE path = ?").get(file) as { mtime_ms?: number };
    return Number(row?.mtime_ms ?? 0);
  } finally {
    db.close();
  }
}

/** Move a file's mtime forward, since two writes in one millisecond do not. */
function touchLater(file: string): void {
  const when = new Date(Date.now() + 5_000);
  fs.utimesSync(file, when, when);
}

describe("indexing the owner's folders", () => {
  it("reads the Markdown under a source and records what it found", async () => {
    write("notes.md", "The deposit is two months' rent.\n\nIt is returned within 30 days.");
    write("nested/more.md", "A bicycle is stored in the basement.");
    const result = await runLocalIndexPass("full");
    expect(result.files).toBe(2);
    expect(result.chunks).toBeGreaterThanOrEqual(2);
    expect(result.failures).toBe(0);
    // Documents are embedded as documents; only a SEARCH is a query, because
    // the proxy prefixes the Qwen3 instruction from that label alone.
    expect(new Set(embedCalls.types)).toEqual(new Set(["document"]));
  });

  it("costs no embedding at all when nothing changed", async () => {
    write("notes.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");
    const first = embedCalls.texts.length;
    expect(first).toBeGreaterThan(0);

    embedCalls.texts = [];
    const second = await runLocalIndexPass("incremental");
    expect(second.files).toBe(1);
    // The whole point of incremental: an unchanged file is not even read, let
    // alone re-embedded, so a nightly pass over a stable folder is free.
    expect(embedCalls.texts).toEqual([]);
  });

  it("re-embeds only the file that changed", async () => {
    write("a.md", "A bicycle is stored in the basement.");
    const b = write("b.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");

    embedCalls.texts = [];
    fs.writeFileSync(b, "The deposit is now three months' rent.");
    touchLater(b);
    await runLocalIndexPass("incremental");
    expect(embedCalls.texts).toHaveLength(1);
    expect(embedCalls.texts[0]).toContain("three months");
  });

  it("does not re-embed a file that was touched but not edited", async () => {
    const file = write("a.md", "A bicycle is stored in the basement.");
    await runLocalIndexPass("full");
    const before = storedMtime(file);

    embedCalls.texts = [];
    touchLater(file);
    await runLocalIndexPass("incremental");
    expect(embedCalls.texts).toEqual([]);
    // And it really did go through the expensive path rather than the cheap
    // skip: the stat no longer matched, the file WAS read, and it is the
    // content hash that stopped the work — which is why the recorded mtime has
    // moved on and the next pass will skip it for free.
    expect(storedMtime(file)).toBeGreaterThan(before);
  });

  it("forgets a document the owner deleted", async () => {
    write("keep.md", "A bicycle is stored in the basement.");
    const gone = write("gone.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");

    fs.rmSync(gone);
    const after = await runLocalIndexPass("incremental");
    expect(after.files).toBe(1);

    _resetLocalMemoryCacheForTests();
    const hits = await searchLocalMemory("deposit", 5);
    expect(hits.map((h) => h.path).join(" ")).not.toContain("gone.md");
  });

  it("counts a file it cannot read instead of failing the pass", async () => {
    write("fine.md", "A bicycle is stored in the basement.");
    const unreadable = write("locked.md", "The deposit is two months' rent.");
    fs.chmodSync(unreadable, 0o000);
    try {
      const result = await runLocalIndexPass("full");
      // Running as root in some CI images makes the chmod moot; only assert
      // the contract when the file really did become unreadable.
      if (result.failures > 0) {
        expect(result.files).toBe(1);
        expect(result.failures).toBe(1);
      }
    } finally {
      fs.chmodSync(unreadable, 0o644);
    }
  });

  it("ends the pass when the EMBEDDER will not answer, rather than reporting success", async () => {
    // The difference that matters: a file nobody can read is one file's
    // problem, and an embedder that is down is every file's. A pass that
    // counted the second as 40 failures and finished would leave the owner a
    // healthy-looking panel over an empty index.
    write("notes.md", "The deposit is two months' rent.");
    embedFail.status = 502;
    await expect(runLocalIndexPass("full")).rejects.toThrow(/embedding model/i);
  });
});

describe("finding things again", () => {
  it("ranks the document that actually answers the question first", async () => {
    write("lease.md", "The deposit is two months' rent, returned within 30 days.");
    write("shed.md", "A bicycle is stored in the basement.");
    write("recipe.md", "Lasagne needs three layers.");
    await runLocalIndexPass("full");
    _resetLocalMemoryCacheForTests();

    const hits = await searchLocalMemory("how much was the deposit", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].snippet).toContain("deposit");
    expect(hits[0].score).toBeGreaterThan(0);
    expect(embedCalls.types.at(-1)).toBe("query");
  });

  it("names the file the way the owner does, never by its absolute path", async () => {
    write("lease.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");
    _resetLocalMemoryCacheForTests();
    const [hit] = await searchLocalMemory("deposit", 1);
    expect(hit.path).toBe(path.join(path.basename(source), "lease.md"));
    expect(hit.path).not.toContain(source);
    expect(hit.path.startsWith("/")).toBe(false);
  });

  it("answers nothing at all when there is no index yet", async () => {
    expect(await searchLocalMemory("deposit", 5)).toEqual([]);
    // And asks the embedder nothing: there is nothing to compare against.
    expect(embedCalls.texts).toEqual([]);
  });

  it("honours the limit", async () => {
    for (let i = 0; i < 6; i += 1) write(`note-${i}.md`, `The deposit note number ${i}.`);
    await runLocalIndexPass("full");
    _resetLocalMemoryCacheForTests();
    expect(await searchLocalMemory("deposit", 2)).toHaveLength(2);
  });
});

describe("the index knows what it was built for", () => {
  it("reports a stamped, current index as valid", async () => {
    write("notes.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");
    const status = await localMemoryStatusJson() as { status: { custom: { indexIdentity: { status: string } } } };
    expect(status.status.custom.indexIdentity.status).toBe("valid");
  });

  it("reports MISSING before anything has been built", async () => {
    const status = await localMemoryStatusJson() as { status: { custom: { indexIdentity: { status: string } } } };
    expect(status.status.custom.indexIdentity.status).toBe("missing");
  });

  it("reports MISMATCHED once the embedder it was built for has changed", async () => {
    // The failure this exists to catch is silent: vectors from another model
    // are still vectors, so search goes on answering — badly — while every
    // count on the panel stays green.
    write("notes.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");
    const { openSqlite } = await import("@/lib/openclaw-session-store");
    const db = openSqlite(LOCAL_INDEX_PATH, false);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'identity'").run("a-different-embedder");
    db.close();

    const status = await localMemoryStatusJson() as { status: { custom: { indexIdentity: { status: string } } } };
    expect(status.status.custom.indexIdentity.status).toBe("mismatched");
  });

  it("rebuilds from scratch on the next pass after a mismatch, and comes back valid", async () => {
    write("notes.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");
    const { openSqlite } = await import("@/lib/openclaw-session-store");
    const db = openSqlite(LOCAL_INDEX_PATH, false);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'identity'").run("a-different-embedder");
    db.close();

    embedCalls.texts = [];
    const result = await runLocalIndexPass("incremental");
    // An INCREMENTAL pass, upgraded to a rebuild because the stored vectors
    // belong to somebody else — so the file is embedded again rather than
    // skipped as unchanged.
    expect(result.mode).toBe("full");
    expect(embedCalls.texts.length).toBeGreaterThan(0);
    const status = await localMemoryStatusJson() as { status: { custom: { indexIdentity: { status: string } } } };
    expect(status.status.custom.indexIdentity.status).toBe("valid");
  });

  it("can be stamped before a single vector exists — the wizard's own step", async () => {
    await stampLocalEmbeddingIdentity();
    const status = await localMemoryStatusJson() as {
      status: { custom: { indexIdentity: { status: string } }; files: number; chunks: number };
    };
    expect(status.status.custom.indexIdentity.status).toBe("valid");
    expect(status.status.files).toBe(0);
    expect(status.status.chunks).toBe(0);
    expect(localEmbeddingIdentity()).toHaveLength(16);
  });
});

describe("the status it hands to the shared parser", () => {
  it("carries every field parseMemoryStatus reads", async () => {
    write("notes.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");
    const row = await localMemoryStatusJson() as Record<string, never>;
    const status = (row as unknown as { status: Record<string, unknown> }).status;
    expect((row as unknown as { agentId: string }).agentId).toBe("main");
    expect((row as unknown as { scan: { totalFiles: number } }).scan.totalFiles).toBe(1);
    expect(status.provider).toBe("openai-compatible");
    expect(status.model).toBe("qwen3-embedding-0.6b");
    expect(status.dbPath).toBe(LOCAL_INDEX_PATH);
    expect(status.sources).toEqual([source]);
    expect((status.vector as { semanticAvailable: boolean }).semanticAvailable).toBe(true);
    expect((status.batch as { failures: number }).failures).toBe(0);
    expect((status.custom as { providerState: { mode: string } }).providerState.mode).toBe("active");
  });
});

describe("a box that was just swapped from OpenClaw", () => {
  it("carries the owner's folders over, once", async () => {
    // The swap dialogue promises that what the assistant knows about the owner
    // carries over, and a list of folders they picked by hand is that. Without
    // this the box comes up set up, switched on and reading nothing, which
    // looks like a broken feature rather than a setting to redo.
    const config = await import("@/lib/config-store");
    await config.set("memory_shard_sources", undefined);
    openclawConfig.value = { memory: { search: { extraPaths: [source, "/gone/for/good"] } } };

    // The folder that is still there is kept; the one that is not is dropped,
    // because a ~/.openclaw left behind by a swap is a snapshot of a moment.
    expect(await readLocalSources()).toEqual([source]);

    // And it happens exactly once: an owner who then removes every folder does
    // not get them back on the next read.
    await writeLocalSources([]);
    expect(await readLocalSources()).toEqual([]);
  });

  it("carries nothing on a box that never ran OpenClaw", async () => {
    const config = await import("@/lib/config-store");
    await config.set("memory_shard_sources", undefined);
    openclawConfig.value = {};
    expect(await readLocalSources()).toEqual([]);
  });
});

describe("chunking", () => {
  it("keeps a short document whole", () => {
    expect(chunkText("One paragraph.\n\nAnd another.")).toEqual(["One paragraph.\n\nAnd another."]);
  });

  it("splits on paragraph boundaries rather than mid-sentence", () => {
    const paragraph = `${"word ".repeat(200).trim()}.`;
    const chunks = chunkText(`${paragraph}\n\n${paragraph}\n\n${paragraph}`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.endsWith(".")).toBe(true);
  });

  it("windows a single paragraph too long to fit, with an overlap", () => {
    const runOn = "x".repeat(3_000);
    const chunks = chunkText(runOn);
    expect(chunks.length).toBeGreaterThan(2);
    // Overlapping, so a fact that straddles a cut survives whole in one half.
    const joined = chunks.join("").length;
    expect(joined).toBeGreaterThan(runOn.length);
  });

  it("has nothing to say about an empty document", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });
});
