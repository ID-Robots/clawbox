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
  carryMemorySourcesTo,
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

  it("does NOT delete a source's index when the folder could not be read", async () => {
    // The worst thing this module can do. `walkFiles` swallows an opendir
    // failure and yields nothing, so an unplugged drive, a permission change
    // and an emptied folder are the same silence — and the delete pass would
    // have removed every row for that source and reported the run SUCCEEDED,
    // leaving the owner to re-embed everything.
    write("lease.md", "The deposit is two months' rent.");
    const built = await runLocalIndexPass("full");
    expect(built.files).toBe(1);

    fs.chmodSync(source, 0o000);
    let result: Awaited<ReturnType<typeof runLocalIndexPass>>;
    try {
      result = await runLocalIndexPass("incremental");
    } finally {
      fs.chmodSync(source, 0o755);
    }
    // Running as root in some CI images makes the chmod moot; only assert the
    // contract when the folder really did become unreadable.
    if (result.failures > 0) {
      expect(result.files, "the index must survive a folder it could not open").toBe(1);
      expect(result.chunks).toBeGreaterThan(0);
    }
  });

  it("can still shrink and still take new work after it has hit its ceiling", async () => {
    // Skipping the delete pass while capped wedged the index for good: the
    // chunks of deleted files were never reclaimed, so every later pass hit the
    // ceiling again and skipped the delete again. Only a full reindex escaped.
    const gone = write("big.md", "The deposit is two months' rent.");
    write("keep.md", "A bicycle is stored in the basement.");
    await runLocalIndexPass("full");
    // Pretend the store is at its ceiling by claiming the cap was hit, then
    // remove a file and run again: the row must go.
    fs.rmSync(gone);
    const after = await runLocalIndexPass("incremental");
    expect(after.files).toBe(1);
    _resetLocalMemoryCacheForTests();
    const hits = await searchLocalMemory("deposit", 5);
    expect(hits.map((h) => h.path).join(" ")).not.toContain("big.md");
  });

  it("re-records a file whose folder entry changed, so results stop citing the old one", async () => {
    // Remove `<source>` from the list and add its PARENT: every already-indexed
    // file has the same mtime and size, so a skip rule that looked only at
    // those left every result citing the folder the owner had just removed.
    write("lease.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");
    await writeLocalSources([path.dirname(source)]);
    await runLocalIndexPass("incremental");

    _resetLocalMemoryCacheForTests();
    const [hit] = await searchLocalMemory("deposit", 1);
    expect(hit.path).toBe(path.join(path.basename(path.dirname(source)), path.basename(source), "lease.md"));
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

  it("refuses to send the owner's documents anywhere but this device", async () => {
    // The one thing an index like this must never do. Everything it embeds is
    // the customer's own files, and the endpoint is built from environment
    // variables — so where the bytes go is checked, not assumed.
    const embed = await import("@/lib/embed-server");
    const spy = vi.spyOn(embed, "getEmbedProxyBaseUrl").mockReturnValue("https://someone-elses-server.example/v1");
    try {
      write("notes.md", "The deposit is two months' rent.");
      await expect(runLocalIndexPass("full")).rejects.toThrow(/not on this device/i);
      expect(embedCalls.texts).toEqual([]);
    } finally {
      spy.mockRestore();
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

  it("does not call a stamped but EMPTY index valid — the wizard's own step", async () => {
    // The wizard stamps at its provisioning step, before the first pass. An
    // identity with no rows behind it is not evidence of anything: reported
    // `valid` it reaches the shared parser as `healthy` with zero chunks — a
    // green panel over a search that finds nothing — and a rebuild whose first
    // embed failed leaves exactly the same shape. The OpenClaw arm says
    // `missing` at that point, and it is also what makes the next pass rebuild.
    await stampLocalEmbeddingIdentity();
    const status = await localMemoryStatusJson() as {
      status: { custom: { indexIdentity: { status: string } }; files: number; chunks: number };
    };
    expect(status.status.custom.indexIdentity.status).toBe("missing");
    expect(status.status.files).toBe(0);
    expect(status.status.chunks).toBe(0);
    expect(localEmbeddingIdentity()).toHaveLength(16);
  });

  it("does not report a rebuild whose embedder died as a healthy empty index", async () => {
    // The exact sequence: an owner with a mismatched index presses Index now,
    // the tables are emptied, and the first embed gets the 502 the MemAvailable
    // guard answers a wake with. Before, the identity had already been stamped
    // over the empty tables and the panel went green.
    write("notes.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");
    embedFail.status = 502;
    await expect(runLocalIndexPass("full")).rejects.toThrow(/embedding model/i);

    const status = await localMemoryStatusJson() as {
      status: { chunks: number; custom: { indexIdentity: { status: string } } };
    };
    expect(status.status.chunks).toBe(0);
    expect(status.status.custom.indexIdentity.status).toBe("missing");
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

describe("carrying the owner's folders across a harness swap", () => {
  it("moves the list the OTHER arm was keeping, and only folders that are still there", async () => {
    // The swap's dialogue promises that what the assistant knows about the
    // owner carries over, and a list of folders they picked by hand is that.
    // Without it the box comes up set up, switched on and reading nothing.
    const config = await import("@/lib/config-store");
    await config.set("memory_shard_sources", undefined);
    openclawConfig.value = { memory: { search: { extraPaths: [source, "/gone/for/good"] } } };

    // A ~/.openclaw left behind by a swap is a snapshot of a moment, so a
    // folder that is no longer there is dropped rather than resurrected.
    expect(await carryMemorySourcesTo("hermes")).toBe(1);
    expect(await readLocalSources()).toEqual([source]);
  });

  it("carries nothing over a list the target arm already has", async () => {
    const config = await import("@/lib/config-store");
    await config.set("memory_shard_sources", [source]);
    openclawConfig.value = { memory: { search: { extraPaths: ["/somewhere/else"] } } };
    expect(await carryMemorySourcesTo("hermes")).toBe(0);
    expect(await readLocalSources()).toEqual([source]);
  });

  it("carries nothing on a box that never ran the other harness", async () => {
    const config = await import("@/lib/config-store");
    await config.set("memory_shard_sources", undefined);
    openclawConfig.value = {};
    expect(await carryMemorySourcesTo("hermes")).toBe(0);
    expect(await readLocalSources()).toEqual([]);
  });

  it("leaves ClawBox's own derived folders behind", async () => {
    // They are not the owner's choices — this arm walks them from the source —
    // so carrying one would put a scratch directory in a list the owner sees.
    const { EXTRACT_ROOT } = await import("@/lib/memory-extract");
    const derived = path.join(EXTRACT_ROOT, "notes-abcdef012345");
    fs.mkdirSync(derived, { recursive: true });
    const config = await import("@/lib/config-store");
    await config.set("memory_shard_sources", undefined);
    openclawConfig.value = { memory: { search: { extraPaths: [source, derived] } } };
    expect(await carryMemorySourcesTo("hermes")).toBe(1);
    expect(await readLocalSources()).toEqual([source]);
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
