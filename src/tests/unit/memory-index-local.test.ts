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

const { dataDir, embedCalls, embedFail, refusalNotes, openclawConfig, boxState } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("node:path") as typeof import("node:path");
  return {
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "memory-index-data-")),
    /** Every text that reached the embedder, in order, across the run. */
    embedCalls: { texts: [] as string[], types: [] as string[], urls: [] as string[], bearers: [] as string[] },
    /**
     * When `status` is set, an embeddings request answers it instead of a
     * vector. `after` lets that many requests through first, which is how a
     * test reaches the embedder dying PART WAY through a rebuild — the one
     * state where the store really has been emptied.
     */
    embedFail: {
      status: 0,
      after: 0,
      retryAfter: null as string | null,
      /** The refusal envelope the ClawBox AI proxy sends with a 401 or a 403. */
      body: null as string | null,
      /**
       * The socket itself failing, which is what a Wi-Fi drop, a DNS blip, a
       * reset connection or the embed timeout look like from here. `status`
       * cannot express it: those never reach an HTTP status at all.
       */
      throwTimes: 0,
    },
    /** What `noteClawaiCredentialRefused` was told, if anything. */
    refusalNotes: [] as number[],
    /** What openclaw.json holds, for the one-time carry-over after a swap. */
    openclawConfig: { value: {} as unknown },
    /** The box's ClawBox AI credential, and whether the GGUF is on disk. */
    boxState: {
      clawaiToken: "claw_test" as string | null,
      gguf: true,
      /** The status the ClawBox AI proxy refused this box's credential with. */
      clawaiRefusedStatus: null as number | null,
    },
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
  getEmbedProvisioningStatus: async () => ({ installed: boxState.gguf, binaryAvailable: boxState.gguf, modelAvailable: boxState.gguf, modelBytes: 1, binPath: "", modelPath: "" }),
}));
// The cloud half of the same index: where the ClawBox AI embedder is, and the
// box's own credential for it. Both are read per request by the real resolver.
vi.mock("@/lib/harness/credentials", () => ({
  CLAWBOX_AI_PROXY_URL: "https://clawbox.test/api/ai",
  resolveClawaiToken: async () => boxState.clawaiToken,
  // The proxy's own verdict on this box's credential. A lapsed subscription
  // leaves the token in place and refuses the request, which is the state the
  // status read must not call `semanticAvailable`.
  clawaiCredentialRefused: () => boxState.clawaiRefusedStatus,
  // The generation guard the real store keeps, so a verdict on a credential the
  // box no longer holds is dropped rather than remembered.
  clawaiCredentialGeneration: () => 1,
  // The PROXY'S OWN identification of the credential as the problem — never the
  // status alone, which an edge rule or a plan gate can also send.
  //
  // A DELIBERATE MIRROR of `proxyRefusedClawaiCredential` in
  // `@/lib/harness/credentials`, down to the status table and the envelope it
  // parses, and not a convenience stand-in: a mock that accepted one status
  // more than the helper does had this suite proving a behaviour the product
  // does not have. The real module cannot be imported here — it re-exports from
  // `@/lib/hermes-clawai`, which is the whole Hermes adapter graph and imports
  // this module's own dependencies back — so the contract is pinned where the
  // real helper runs instead (`harness-credentials.test.ts`, "the statuses the
  // helper accepts"), and this copy is checked against it there.
  proxyRefusedClawaiCredential: async (res: Response) => {
    if (res.status !== 401 && res.status !== 403) return false;
    const text = await res.text().catch(() => "");
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return false;
    }
    const code = (payload as { error?: { code?: unknown } } | null)?.error?.code;
    return code === "invalid_token" || code === "missing_token";
  },
  noteClawaiCredentialRefused: async (status: number) => { refusalNotes.push(status); },
}));
vi.mock("@/lib/clawai-cloud-defaults", () => ({
  readCloudDefaultsFacts: async () => ({
    linked: boxState.clawaiToken !== null,
    entitlement: "pro",
    embeddingsSupported: true,
    embeddingsRouteReady: boxState.clawaiToken !== null,
  }),
}));
vi.mock("@/lib/local-ai-token", () => ({ getLocalAiToken: () => "t".repeat(64) }));
vi.mock("@/lib/openclaw-config", () => ({ readConfig: async () => openclawConfig.value }));

import { writeEmbedderPin } from "@/lib/memory-embedder";
import {
  EMBED_RETRY_MIN_WAIT_MS,
  IndexRebuildRequiredError,
  LOCAL_INDEX_PATH,
  _resetLocalMemoryCacheForTests,
  chunkText,
  localEmbeddingIdentity,
  carryMemorySourcesTo,
  localMemoryStatusJson,
  maxIndexChunks,
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
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
    if (embedFail.throwTimes > 0) {
      embedFail.throwTimes -= 1;
      throw new TypeError("fetch failed");
    }
    if (embedFail.status) {
      if (embedFail.after > 0) embedFail.after -= 1;
      else {
        const status = embedFail.status;
        embedFail.status = 0;
        return new Response(embedFail.body ?? "nope", {
          status,
          headers: embedFail.retryAfter === null ? {} : { "retry-after": embedFail.retryAfter },
        });
      }
    }
    const body = JSON.parse(init.body) as { input: string[]; input_type?: string; model: string };
    embedCalls.texts.push(...body.input);
    embedCalls.types.push(body.input_type as string);
    embedCalls.urls.push(String(url));
    embedCalls.bearers.push(init.headers.authorization);
    return Response.json({
      data: body.input.map((text, index) => ({ index, embedding: stubVector(text) })),
    });
  }));
}

let sourceParent: string;
let source: string;

beforeEach(async () => {
  // The source folder gets a temp PARENT of its own rather than sitting
  // directly under the OS tmpdir: one test below removes `<source>` from the
  // list and registers `path.dirname(source)`, and with that dirname being
  // /tmp the pass walked every stray Markdown file another process had left
  // there. The stub embedder gives two texts that share a marker word the
  // same vector, so a leftover /tmp/*.md containing "deposit" tied with — and
  // beat — the file the test wrote (observed on beta, 2026-09-12).
  sourceParent = fs.mkdtempSync(path.join(os.tmpdir(), "memory-index-parent-"));
  source = path.join(sourceParent, "memory-index-src");
  fs.mkdirSync(source, { recursive: true });
  embedCalls.texts = [];
  embedCalls.types = [];
  embedCalls.urls = [];
  embedCalls.bearers = [];
  // No subscription unless a test says otherwise, so every case below that is
  // about the model on this box stays about it. The default-is-cloud rule has
  // its own tests, here and in memory-embedder.test.ts.
  boxState.clawaiToken = null;
  boxState.gguf = true;
  boxState.clawaiRefusedStatus = null;
  // The store is module-level in the mock, so a pin one case writes would
  // otherwise decide the embedder for every case after it.
  ((await import("@/lib/config-store")) as unknown as { __store: Map<string, unknown> }).__store.clear();
  embedFail.status = 0;
  embedFail.after = 0;
  embedFail.retryAfter = null;
  embedFail.body = null;
  embedFail.throwTimes = 0;
  refusalNotes.length = 0;
  openclawConfig.value = {};
  installFetchStub();
  _resetLocalMemoryCacheForTests();
  fs.rmSync(path.dirname(LOCAL_INDEX_PATH), { recursive: true, force: true });
  await writeLocalSources([source]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(sourceParent, { recursive: true, force: true });
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

  it("still forgets a deleted note in a folder whose only PDF was too large to read", async () => {
    // The derived folder is NAMED as soon as a source holds one extractable
    // document and WRITTEN only when a conversion is about to be put in it. A
    // folder whose every extractable document was passed over first — one over
    // MAX_DOCUMENT_BYTES here — therefore names a folder that is not there, and
    // failing to walk it used to be charged to the OWNER'S folder: a failure
    // they cannot act on, and — because `unreadableSources` protects a whole
    // source from the delete pass — a document they deleted that stayed in the
    // index and went on being found, on every later pass, for ever.
    const { MAX_DOCUMENT_BYTES } = await import("@/lib/memory-extract");
    write("keep.md", "A bicycle is stored in the basement.");
    const gone = write("gone.md", "The deposit is two months' rent.");
    // Sparse, so this costs no disk: the extractor stats it and steps over it.
    fs.truncateSync(write("scan.pdf", ""), MAX_DOCUMENT_BYTES + 1);

    const built = await runLocalIndexPass("full");
    expect(built.files).toBe(2);
    // One failure, and only one: the PDF the extractor could not read. The
    // owner's folder was read perfectly.
    expect(built.failures, "the owner's folder must not be counted as unreadable").toBe(1);

    fs.rmSync(gone);
    const after = await runLocalIndexPass("incremental");
    expect(after.files, "the deleted note must leave the index").toBe(1);
    expect(after.failures).toBe(1);

    _resetLocalMemoryCacheForTests();
    const hits = await searchLocalMemory("deposit", 5);
    expect(hits.map((h) => h.path).join(" ")).not.toContain("gone.md");
  });

  it("still protects a source whose derived folder IS there and cannot be read", async () => {
    // The other half of the rule above: a derived folder that exists and will
    // not open is a real shortfall — its rows may only LOOK stale — so the
    // source keeps every row it has.
    const { derivedFolderFor } = await import("@/lib/memory-extract");
    write("keep.md", "A bicycle is stored in the basement.");
    // A .txt is extractable, so the folder is really written and really walked.
    write("lease.txt", "The deposit is two months' rent.");
    const built = await runLocalIndexPass("full");
    expect(built.files).toBe(2);

    fs.chmodSync(derivedFolderFor(source), 0o000);
    let after: Awaited<ReturnType<typeof runLocalIndexPass>>;
    try {
      after = await runLocalIndexPass("incremental");
    } finally {
      fs.chmodSync(derivedFolderFor(source), 0o755);
    }
    // Running as root in some CI images makes the chmod moot; only assert the
    // contract when the folder really did become unreadable.
    if (after.failures > 0) {
      expect(after.files, "a derived folder that will not open keeps its rows").toBe(2);
    }
  });

  it("walks a derived folder it could not stat rather than calling it absent", async () => {
    // Only ENOENT means "no derived folder". A stat that fails for any other
    // reason — a permission refused, an I/O error — is "could not look", and
    // folded into "absent" it skipped the walk, left the source unflagged, and
    // let the stale sweep delete every derived document it had not seen: the
    // owner's converted files gone from the index over a folder ClawBox could
    // not open for a moment. Refused at the stat only, so the walk itself —
    // the thing that decides what is kept — still sees the folder.
    const { derivedFolderFor } = await import("@/lib/memory-extract");
    write("keep.md", "A bicycle is stored in the basement.");
    write("lease.txt", "The deposit is two months' rent.");
    expect((await runLocalIndexPass("full")).files).toBe(2);

    const derived = derivedFolderFor(source);
    const fsp = (await import("node:fs/promises")).default;
    const realStat = fsp.stat.bind(fsp);
    const spy = vi.spyOn(fsp, "stat").mockImplementation((async (target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target) === derived) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return (realStat as (...args: unknown[]) => Promise<fs.Stats>)(target, ...rest);
    }) as typeof fsp.stat);
    let after: Awaited<ReturnType<typeof runLocalIndexPass>>;
    try {
      after = await runLocalIndexPass("incremental");
    } finally {
      spy.mockRestore();
    }
    expect(after.files, "a derived folder that could not be stat'd keeps its rows").toBe(2);

    _resetLocalMemoryCacheForTests();
    const hits = await searchLocalMemory("deposit", 5);
    expect(hits.map((h) => h.path).join(" ")).toContain("lease.txt");
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

  it("refuses a REDIRECT on the embedding request rather than following it with the body", async () => {
    // THE FENCE CHECKS THE ADDRESS THIS BOX RESOLVED, and `fetch` follows a
    // 307/308 by itself — with the METHOD and the BODY intact, and the body on
    // this path is the owner's document text. `redirect: "manual"` is what makes
    // such an answer land in the `!res.ok` branch below instead of on somebody
    // else's server.
    const elsewhere: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string; redirect?: string }) => {
      if (init.redirect === "manual") {
        return new Response(null, {
          status: 307,
          headers: { location: "https://elsewhere.example/v1/embeddings" },
        });
      }
      // What the DEFAULT `fetch` does with that answer, spelled out: the same
      // POST, the same body, at the address the redirect named.
      elsewhere.push(...(JSON.parse(init.body) as { input: string[] }).input);
      return Response.json({ data: [{ index: 0, embedding: [1, 0, 0, 0, 0.05] }] });
    }));
    write("notes.md", "The deposit is two months' rent.");
    await expect(runLocalIndexPass("full")).rejects.toThrow(/HTTP 307/);
    expect(elsewhere).toEqual([]);
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

describe("the ClawBox AI cloud embedder", () => {
  it("embeds in the cloud with the box's own credential, and never through the proxy", async () => {
    boxState.clawaiToken = "claw_test";
    await writeEmbedderPin("cloud");
    write("notes.md", "The deposit is two months' rent.");
    const result = await runLocalIndexPass("full");

    expect(result.files).toBe(1);
    expect(embedCalls.urls.length).toBeGreaterThan(0);
    for (const url of embedCalls.urls) expect(url).toBe("https://clawbox.test/api/ai/embeddings");
    for (const bearer of embedCalls.bearers) expect(bearer).toBe("Bearer claw_test");
    // `input_type` is the loopback proxy's field — it restores Qwen3's query
    // instruction from it — and an unknown one on an OpenAI-shaped route.
    expect(embedCalls.types.every((type) => type === undefined)).toBe(true);
  });

  it("is what a box with a subscription and no pin uses, without being told", async () => {
    // The owner's ruling of 2026-09-18: the cloud is the DEFAULT, not a
    // preselection in a wizard. Nothing is stored here at all.
    boxState.clawaiToken = "claw_test";
    write("notes.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");
    expect(embedCalls.urls).not.toHaveLength(0);
    for (const url of embedCalls.urls) expect(url).toBe("https://clawbox.test/api/ai/embeddings");
  });

  it("indexes on the box itself when nothing links it to a subscription", async () => {
    write("notes.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");
    for (const url of embedCalls.urls) expect(url).toBe("http://127.0.0.1/setup-api/local-ai/embed/v1/embeddings");
  });

  it("ends the pass rather than quietly embedding on the box when the credential is gone", async () => {
    // A subscription that lapsed, or a credential the portal revoked. Falling
    // back to the model on this box would write vectors from another model into
    // an index stamped for the cloud one — a healthy panel over a search that
    // ranks nothing.
    await writeEmbedderPin("cloud");
    boxState.clawaiToken = null;
    write("notes.md", "The deposit is two months' rent.");
    await expect(runLocalIndexPass("full")).rejects.toThrow(/ClawBox AI credential/i);
    expect(embedCalls.texts).toEqual([]);
  });

  it("searches with the same embedder the index was built by", async () => {
    boxState.clawaiToken = "claw_test";
    await writeEmbedderPin("cloud");
    write("notes.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");
    embedCalls.urls = [];
    embedCalls.types = [];
    const hits = await searchLocalMemory("deposit", 3);
    expect(hits).not.toHaveLength(0);
    expect(embedCalls.urls).toEqual(["https://clawbox.test/api/ai/embeddings"]);
    expect(embedCalls.types).toEqual([undefined]);
  });

  it("survives one transient refusal mid-rebuild instead of leaving the box with no index", async () => {
    // A full rebuild is ~1,250 requests to a rate-limited endpoint and it
    // starts by emptying the store. A single 429 at request 500 used to end the
    // pass with the tables already wiped, and memory search then answered
    // nothing until some later scheduled pass happened to succeed — on a box
    // with no armed slot, indefinitely.
    boxState.clawaiToken = "claw_test";
    await writeEmbedderPin("cloud");
    for (let i = 0; i < 40; i += 1) write(`note-${i}.md`, `The deposit is two months' rent, note ${i}.`);
    // Past the rebuild probe and into the owner's own documents.
    embedFail.status = 429;
    embedFail.after = 2;
    embedFail.retryAfter = "0";

    const result = await runLocalIndexPass("full");
    expect(result.files).toBe(40);
    expect(result.chunks).toBeGreaterThan(0);
    const hits = await searchLocalMemory("deposit", 3);
    expect(hits).not.toHaveLength(0);
  });

  it("survives a dropped CONNECTION mid-rebuild, not only a refused one", async () => {
    // `retryable` was set from an HTTP STATUS only, so a reset connection, a DNS
    // blip, a TLS error or the 120 s embed timeout ended the pass — with the
    // tables already emptied. Over the network those are at least as common as a
    // 429 and they are the ones a Wi-Fi box actually sees.
    boxState.clawaiToken = "claw_test";
    await writeEmbedderPin("cloud");
    for (let i = 0; i < 40; i += 1) write(`note-${i}.md`, `The deposit is two months' rent, note ${i}.`);
    embedFail.throwTimes = 1;

    const result = await runLocalIndexPass("full");
    expect(result.files).toBe(40);
    expect(result.chunks).toBeGreaterThan(0);
    expect(await searchLocalMemory("deposit", 3)).not.toHaveLength(0);
  });

  it("remembers a credential the PROXY named as the problem during an embed", async () => {
    // L-1's residual. `localMemoryStatusJson` requires `clawaiCredentialRefused()
    // === null` on the cloud arm, and nothing on the EMBEDDING path ever armed
    // it — only the picture and voice paths did. So a box whose credential the
    // proxy refuses — revoked, re-minted elsewhere, corrupted in a migration —
    // and whose owner uses neither of those features kept reporting a healthy
    // cloud index while every pass failed and every search threw.
    //
    // 403 AND NOT 402, which is what `proxyRefusedClawaiCredential` accepts and
    // what the ClawBox AI proxy actually sends: 402 is spoken by ClawBox's own
    // routes (`refusePaidPlan`) and by the portal, never by the proxy.
    boxState.clawaiToken = "claw_test";
    await writeEmbedderPin("cloud");
    write("notes.md", "The deposit is two months' rent.");
    embedFail.status = 403;
    embedFail.body = JSON.stringify({ error: { code: "invalid_token" } });
    await expect(runLocalIndexPass("full")).rejects.toThrow(/HTTP 403/);
    expect(refusalNotes).toEqual([403]);
  });

  it("does not arm the refusal over a status the proxy did not claim as its own", async () => {
    // A bare 401/403 on the wire can be an edge rule, a rate-limit page or an
    // interception proxy, and remembering one of those would tell a customer
    // with a perfectly good credential to re-pair their device.
    boxState.clawaiToken = "claw_test";
    await writeEmbedderPin("cloud");
    write("notes.md", "The deposit is two months' rent.");
    embedFail.status = 403;
    embedFail.body = "<html>Access denied</html>";
    await expect(runLocalIndexPass("full")).rejects.toThrow(/HTTP 403/);
    expect(refusalNotes).toEqual([]);
  });

  it("does not arm the refusal over the proxy's PLAN gate, which is not a credential", async () => {
    // THE OTHER 403 THE PROXY SENDS, and the reason the guard may never read a
    // status alone: cloud capabilities are sold per tier and the proxy refuses
    // an unentitled one with 403 (`clawai-cloud-defaults-state.ts` — "TTS is
    // Max-only on the proxy, which answers 403 to Free and Pro"). That is a
    // fact about the PLAN, not about the credential, and recording it as a
    // refused credential would tell an owner whose token is perfectly good to
    // re-link the device. The index pass still ends, which is the honest half:
    // what does not happen is the box concluding its credential is dead.
    boxState.clawaiToken = "claw_test";
    await writeEmbedderPin("cloud");
    write("notes.md", "The deposit is two months' rent.");
    embedFail.status = 403;
    embedFail.body = JSON.stringify({ error: { code: "paid_plan_required" } });
    await expect(runLocalIndexPass("full")).rejects.toThrow(/HTTP 403/);
    expect(refusalNotes).toEqual([]);
  });

  it("asks ONCE for a search query, however transient the refusal", async () => {
    // The rebuild's retry budget is right for a rebuild and wrong for a person
    // waiting: three attempts of up to 120 s with two waits of up to 30 s is
    // ~7 minutes inside a search the MCP tool abandons at 60. A query that
    // cannot be embedded now is answered now.
    boxState.clawaiToken = "claw_test";
    await writeEmbedderPin("cloud");
    write("notes.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");
    embedCalls.urls = [];
    embedFail.status = 429;
    embedFail.retryAfter = "0";
    await expect(searchLocalMemory("deposit", 3)).rejects.toThrow(/HTTP 429/);
    expect(embedCalls.urls).toHaveLength(0);
  });

  it("waits a real interval when the far side asks for `Retry-After: 0`", async () => {
    // `err.retryAfterMs ?? wait` reads `0` as a number, not as absent, so a
    // rate-limited endpoint answering `Retry-After: 0` was asked three times
    // with no pause at all — the hammer the backoff exists to prevent.
    //
    // ON A FAKE CLOCK, and a partly fake one on purpose. Measuring the pause by
    // the wall clock put a real second on every `test:unit` run for one
    // assertion, and answered a weaker question besides — "at least a second
    // passed" is true of a pass that slept for any reason. `setTimeout` alone is
    // faked (`pauseBeforeRetry` is the only timer this pass arms), so the sqlite
    // and filesystem work either side of it still completes on the real event
    // loop, which `setImmediate` is kept real to pump.
    boxState.clawaiToken = "claw_test";
    await writeEmbedderPin("cloud");
    write("notes.md", "The deposit is two months' rent.");
    embedFail.status = 429;
    embedFail.retryAfter = "0";
    // What is asserted is the REQUEST, not that the pass is unfinished: a pass
    // released early still has its sqlite and filesystem work to do, so "not
    // settled yet" is true of a retry that has already gone out.
    const pump = async (turns: number) => {
      for (let i = 0; i < turns; i += 1) {
        await new Promise<void>((resolve) => { setImmediate(resolve); });
      }
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let settled = false;
      const pass = runLocalIndexPass("full").finally(() => { settled = true; });
      // Let the pass get as far as arming its retry pause. Bounded, so a pass
      // that never arms one fails on the assertion below rather than hanging.
      for (let i = 0; i < 200 && vi.getTimerCount() === 0 && !settled; i += 1) {
        await new Promise<void>((resolve) => { setImmediate(resolve); });
      }
      expect(vi.getTimerCount()).toBe(1);
      const asked = embedCalls.urls.length;
      // A tick SHORT of the floor, and time for a request released early to
      // actually reach the stub: nothing may have been asked again yet.
      await vi.advanceTimersByTimeAsync(EMBED_RETRY_MIN_WAIT_MS - 1);
      await pump(5);
      expect(embedCalls.urls.length).toBe(asked);
      expect(settled).toBe(false);
      // …and the floor itself releases it.
      await vi.advanceTimersByTimeAsync(1);
      const result = await pass;
      expect(embedCalls.urls.length).toBeGreaterThan(asked);
      expect(result.files).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a refusal that is not transient rather than asking three times", async () => {
    // A 403 is a lapsed plan or a bad credential: the next attempt is refused
    // the same way, and retrying would make the pass three times as slow to say
    // so. The pass ends, and the index it was going to replace is still there.
    boxState.clawaiToken = "claw_test";
    await writeEmbedderPin("cloud");
    write("notes.md", "The deposit is two months' rent.");
    embedFail.status = 403;
    await expect(runLocalIndexPass("full")).rejects.toThrow(/HTTP 403/);
  });

  it("calls semantic search available in the cloud without the 639 MB model on disk", async () => {
    boxState.clawaiToken = "claw_test";
    boxState.gguf = false;
    await writeEmbedderPin("cloud");
    const status = await localMemoryStatusJson() as {
      status: { provider: string; model: string; vector: { semanticAvailable: boolean }; custom: { providerState: { mode: string } } };
    };
    expect(status.status.model).toBe("text-embedding-3-large");
    expect(status.status.provider).toBe("openai-compatible");
    expect(status.status.vector.semanticAvailable).toBe(true);
    expect(status.status.custom.providerState.mode).toBe("active");
  });

  it("does NOT call semantic search available when the proxy has refused this box's credential", async () => {
    // FALSE SUCCESS, the exact shape. A credential the proxy has rejected —
    // revoked, re-minted on another device, lost in a migration — sits in the
    // store looking exactly like a working one, so "a token is present"
    // reported a healthy cloud index while every pass failed and every search
    // threw. The refusal the rest of the box already records for the picture
    // and microphone paths is the fact that answers.
    boxState.clawaiToken = "claw_test";
    boxState.clawaiRefusedStatus = 403;
    await writeEmbedderPin("cloud");
    const status = await localMemoryStatusJson() as {
      status: { vector: { semanticAvailable: boolean }; custom: { providerState: { mode: string } } };
    };
    expect(status.status.vector.semanticAvailable).toBe(false);
    expect(status.status.custom.providerState.mode).not.toBe("active");
  });

  it("reports the index as mismatched the moment the embedder moves, and valid again after the rebuild", async () => {
    write("notes.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");
    const read = async () => ((await localMemoryStatusJson()) as { status: { custom: { indexIdentity: { status: string } } } })
      .status.custom.indexIdentity.status;
    expect(await read()).toBe("valid");

    boxState.clawaiToken = "claw_test";
    await writeEmbedderPin("cloud");
    expect(await read()).toBe("mismatched");
    await runLocalIndexPass("full");
    expect(await read()).toBe("valid");
  });

  it("never stamps the new embedder over an index the other one built", async () => {
    // The stamp is for an index about to be built — the wizard's provisioning
    // step. Over one that HOLDS vectors it would report `valid` for rows every
    // query misses, which is the one lie this whole identity exists to stop.
    write("notes.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");
    boxState.clawaiToken = "claw_test";
    await writeEmbedderPin("cloud");
    await stampLocalEmbeddingIdentity();
    const status = await localMemoryStatusJson() as { status: { custom: { indexIdentity: { status: string } } } };
    expect(status.status.custom.indexIdentity.status).toBe("mismatched");
  });

  it("leaves no database behind on a box whose owner never switched the feature on", async () => {
    // `openIndexForRead`'s stated invariant, and the boot promotion is what
    // started reaching this path unattended: on beta the stamp was owner-
    // initiated only, and it opens the store FOR WRITE, which creates it. With
    // no index there is nothing to stamp either — the identity reads `missing`
    // and the first pass stamps what it wrote.
    expect(fs.existsSync(LOCAL_INDEX_PATH)).toBe(false);
    await stampLocalEmbeddingIdentity();
    expect(fs.existsSync(LOCAL_INDEX_PATH)).toBe(false);
  });
});

describe("the chunk ceiling, which is a memory budget", () => {
  it("is the same ~78 MiB of vectors whichever embedder the box uses", () => {
    // The flat 20,000 was sized against Qwen3's 1,024 dimensions — 4 KB a
    // chunk, ~80 MB of float32 that fits beside the agent on an Orin. The cloud
    // model is 3,072 dimensions, so the same 20,000 chunks would have been
    // ~234 MiB, allocated contiguously by `loadVectors` on the agent's first
    // search after a restart and pinned for ten minutes after every search.
    const bytes = (chunks: number, dim: number) => chunks * dim * 4;
    expect(maxIndexChunks(1024)).toBe(20_000);
    expect(maxIndexChunks(3072)).toBe(6_666);
    expect(bytes(maxIndexChunks(3072), 3072)).toBeLessThanOrEqual(bytes(20_000, 1024));
    // Within one chunk's worth of the budget, not merely under it.
    expect(bytes(maxIndexChunks(3072), 3072)).toBeGreaterThan(bytes(20_000, 1024) - 3072 * 4);
  });

  it("falls back to the on-device ceiling for a width it cannot use, never to zero", () => {
    // A ceiling of zero is an index that refuses every file.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(maxIndexChunks(bad), String(bad)).toBe(20_000);
    }
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

  it("never names a file by ClawBox's own scratch folder", async () => {
    // The derived folder OUTLIVES a run, so it can hold a `.md` copy of a
    // document the owner has since deleted, or one an extraction cut short by
    // its file budget never reached. Such a file has no name in the owner's
    // terms, and the relative path to it is a `../../…/data/memory-extracted/…`
    // chain — which would be handed to the agent as if it were their document.
    const { EXTRACT_ROOT, derivedFolderFor } = await import("@/lib/memory-extract");
    const derived = derivedFolderFor(source);
    fs.mkdirSync(derived, { recursive: true });
    // A leftover with no origin: nothing in `source` produced it.
    fs.writeFileSync(path.join(derived, "gone__lease.pdf-0123456789ab.md"), "The deposit is two months' rent.");
    // …and one real document, so the folder is walked at all.
    write("real.txt", "A bicycle is stored in the basement.");
    await runLocalIndexPass("full");
    _resetLocalMemoryCacheForTests();

    const hits = await searchLocalMemory("deposit bicycle basement", 10);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      // `path.basename(EXTRACT_ROOT)` and not the whole path: `path.join`
      // collapses the `..` segments, so what actually reaches the agent is a
      // clean-looking `memory-extracted/<folder>/<flat>-<digest>.md` — which is
      // why an assertion on "starts with .." would have passed either way.
      expect(hit.path).not.toContain(path.basename(EXTRACT_ROOT));
      expect(hit.path).not.toContain("0123456789ab");
      expect(path.isAbsolute(hit.path)).toBe(false);
    }
    // The real document is still there — the refusal drops the leftover, not
    // the folder.
    expect(hits.some((h) => h.path.endsWith("real.txt.md") || h.path.includes("real"))).toBe(true);
  });

  it("indexes a document whose own name starts with dots", async () => {
    // `path.relative` answers `..notes.md` for a file called that INSIDE the
    // folder, and a `startsWith("..")` escape test would have refused to index
    // it. The walk skips dot-prefixed entries today, so this reaches the rule
    // through `displayName` directly — which is the rule that has to be right.
    const { _displayNameForTests } = await import("@/lib/memory-index-local");
    expect(_displayNameForTests(source, path.join(source, "..notes.md"), {}))
      .toBe(path.join(path.basename(source), "..notes.md"));
    // …and the escape it exists for is still refused.
    expect(_displayNameForTests(source, "/tmp/elsewhere/leak.md", {})).toBeNull();
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

  // TASK-1197: the same mismatch, met by a pass that may not discard — the
  // unattended schedule. It stops before a single row or embedding is spent.
  it("does NOT rebuild after a mismatch when the pass may not discard, and leaves every row", async () => {
    write("notes.md", "The deposit is two months' rent.");
    const built = await runLocalIndexPass("full");
    const { openSqlite } = await import("@/lib/openclaw-session-store");
    const db = openSqlite(LOCAL_INDEX_PATH, false);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'identity'").run("a-different-embedder");
    db.close();

    embedCalls.texts = [];
    await expect(runLocalIndexPass("incremental", undefined, undefined, { mayDiscard: false }))
      .rejects.toBeInstanceOf(IndexRebuildRequiredError);
    // A `full` request from the same caller is held to the same rule.
    await expect(runLocalIndexPass("full", undefined, undefined, { mayDiscard: false }))
      .rejects.toBeInstanceOf(IndexRebuildRequiredError);
    // Not even the readiness probe a rebuild opens with.
    expect(embedCalls.texts).toEqual([]);
    const status = await localMemoryStatusJson() as {
      status: { chunks: number; custom: { indexIdentity: { status: string } } };
    };
    expect(status.status.chunks).toBe(built.chunks);
    expect(status.status.custom.indexIdentity.status).toBe("mismatched");
  });

  it("runs a no-discard pass that was planned as full, over an index that is valid now, incrementally", async () => {
    // The plan read an empty index; by the time the pass opened the store a
    // manual pass had filled it. Nothing needs rebuilding any more.
    write("notes.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");
    embedCalls.texts = [];
    const result = await runLocalIndexPass("full", undefined, undefined, { mayDiscard: false });
    expect(result.mode).toBe("incremental");
    expect(result.files).toBe(1);
    expect(embedCalls.texts).toEqual([]);
  });

  it("still builds an index that holds nothing when the pass may not discard — there is nothing to throw away", async () => {
    write("notes.md", "The deposit is two months' rent.");
    const result = await runLocalIndexPass("full", undefined, undefined, { mayDiscard: false });
    expect(result.mode).toBe("full");
    expect(result.files).toBe(1);
    expect(result.chunks).toBeGreaterThan(0);
  });

  it("does not call a stamped but EMPTY index valid — the wizard's own step", async () => {
    // The wizard stamps at its provisioning step, before the first pass. An
    // identity with no rows behind it is not evidence of anything: reported
    // `valid` it reaches the shared parser as `healthy` with zero chunks — a
    // green panel over a search that finds nothing — and a rebuild whose first
    // embed failed leaves exactly the same shape. No pass has recorded a scan
    // here, so nothing yet says the folders are empty.
    await stampLocalEmbeddingIdentity();
    const status = await localMemoryStatusJson() as {
      status: { custom: { indexIdentity: { status: string } }; files: number; chunks: number };
    };
    expect(status.status.custom.indexIdentity.status).toBe("missing");
    expect(status.status.files).toBe(0);
    expect(status.status.chunks).toBe(0);
    expect(await localEmbeddingIdentity()).toHaveLength(16);
  });

  it("keeps the index it was going to replace when the embedder will not answer", async () => {
    // A full reindex is the remedy the amber banner names, and it used to
    // DESTROY what it was asked to repair: the tables were emptied on the first
    // statement, and the commonest refusal on this box is the embedder
    // declining to wake — the 502 `ensureLocalAiReady` answers below its
    // MemAvailable floor, a busy Orin saying "not now". The owner pressed the
    // one button the card offered and lost every vector until some later pass
    // happened to succeed. The rebuild asks for one embedding before it deletes
    // anything, so a refusal now costs nothing at all.
    write("notes.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");
    const before = await localMemoryStatusJson() as { status: { chunks: number } };
    expect(before.status.chunks).toBeGreaterThan(0);

    embedFail.status = 502;
    await expect(runLocalIndexPass("full")).rejects.toThrow(/embedding model/i);

    const status = await localMemoryStatusJson() as {
      status: { files: number; chunks: number; custom: { indexIdentity: { status: string } } };
    };
    expect(status.status.files).toBe(1);
    expect(status.status.chunks).toBe(before.status.chunks);
    expect(status.status.custom.indexIdentity.status).toBe("valid");

    _resetLocalMemoryCacheForTests();
    expect(await searchLocalMemory("deposit", 5)).not.toHaveLength(0);
  });

  it("does not report a rebuild whose embedder died as a healthy empty index", async () => {
    // The other half, which the readiness check above cannot cover: the model
    // answered, the tables were emptied, and it stopped answering part way
    // through. The identity is stamped at the END of a pass precisely so this
    // leaves an index that reads as needing a rebuild rather than as a green
    // panel over a search that finds nothing.
    write("notes.md", "The deposit is two months' rent.");
    await runLocalIndexPass("full");
    embedFail.status = 502;
    // The readiness check is the request that gets through; the first document
    // is the one that is refused.
    embedFail.after = 1;
    await expect(runLocalIndexPass("full")).rejects.toThrow(/embedding model/i);

    const status = await localMemoryStatusJson() as {
      status: { chunks: number; custom: { indexIdentity: { status: string } } };
    };
    expect(status.status.chunks).toBe(0);
    expect(status.status.custom.indexIdentity.status).toBe("missing");
  });

  it("calls an index a finished pass found NOTHING to fill valid, not missing", async () => {
    // The Memory Shard card on a box whose folders hold no memory file yet said
    // "Memory index ON … Needs attention — the index fingerprint is missing. Run
    // a full reindex", four hours after a full reindex that had succeeded in
    // 19 ms. The remedy it named could not work: another full pass scans the
    // same zero files and leaves the same zero chunks, so the banner came back
    // unchanged every time. Zero chunks is TWO states and the pass that ended
    // wrote down which one this is — an index that is empty because there was
    // nothing to put in it is correct and up to date.
    await runLocalIndexPass("full");
    const row = await localMemoryStatusJson() as {
      scan: { totalFiles: number };
      status: { files: number; chunks: number; custom: { indexIdentity: { status: string } } };
    };
    expect(row.scan.totalFiles).toBe(0);
    expect(row.status.files).toBe(0);
    expect(row.status.chunks).toBe(0);
    expect(row.status.custom.indexIdentity.status).toBe("valid");
  });

  it("calls an index VALID when the pass read every file and they held nothing", async () => {
    // Zero chunks over FILES is two states as well, and this is the finished
    // one: both documents were read and both were blank, so there is nothing
    // owed and nothing a reindex could do. Called `missing`, the card carried
    // "the index fingerprint is missing. Run a full reindex" for ever — the
    // reindex reads the same two files, writes the same nothing, and the banner
    // comes straight back. A scanned PDF with no text layer lands here too.
    write("blank.md", "   \n\n  ");
    write("also-blank.md", "\t\n");
    const result = await runLocalIndexPass("full");
    expect(result.chunks).toBe(0);
    const row = await localMemoryStatusJson() as {
      scan: { totalFiles: number };
      status: { files: number; custom: { indexIdentity: { status: string } } };
    };
    expect(row.scan.totalFiles).toBe(2);
    // Both have a row: the pass FINISHED with them. That is the whole
    // difference from a pass that could not do the work, and it is the same
    // subtraction the card prints as `pendingFiles`.
    expect(row.status.files).toBe(2);
    expect(row.status.custom.indexIdentity.status).toBe("valid");
  });

  it("keeps MISSING when the pass could not FINISH the files it scanned", async () => {
    // The other empty, and the one the zero-chunk rule exists for: there were
    // documents to index and the pass left work owed on them. The reindex the
    // panel offers is the right advice there, so it has to stay. A file it
    // could not read leaves no row, which is exactly what says so.
    write("blank.md", "   \n\n  ");
    const unreadable = write("locked.md", "The deposit is two months' rent.");
    fs.chmodSync(unreadable, 0o000);
    let result: Awaited<ReturnType<typeof runLocalIndexPass>>;
    try {
      result = await runLocalIndexPass("full");
    } finally {
      fs.chmodSync(unreadable, 0o644);
    }
    // Running as root in some CI images makes the chmod moot; only assert the
    // contract when the file really did become unreadable.
    if (result.failures > 0) {
      const row = await localMemoryStatusJson() as {
        scan: { totalFiles: number };
        status: { files: number; chunks: number; custom: { indexIdentity: { status: string } } };
      };
      expect(row.status.chunks).toBe(0);
      expect(row.scan.totalFiles).toBeGreaterThan(row.status.files);
      expect(row.status.custom.indexIdentity.status).toBe("missing");
    }
  });

  it("keeps MISSING when a file it indexed before cannot be read now", async () => {
    // A row is not proof the pass finished with a file. One indexed on an
    // earlier pass keeps its old row when this pass cannot read it — it is
    // still in the scan, so the stale sweep rightly leaves it — and "rows ==
    // files scanned" then balanced over work that did not happen: an empty
    // index calling itself valid, which the shared parser draws as healthy.
    // Refused at `open` for that one file, so the test does not depend on
    // whether the suite runs as root.
    const blank = write("blank.md", "   \n\n  ");
    await runLocalIndexPass("full");
    const first = await localMemoryStatusJson() as { status: { custom: { indexIdentity: { status: string } } } };
    expect(first.status.custom.indexIdentity.status).toBe("valid");

    touchLater(blank);
    const fsp = (await import("node:fs/promises")).default;
    const realOpen = fsp.open.bind(fsp);
    const spy = vi.spyOn(fsp, "open").mockImplementation((async (target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target) === blank) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return (realOpen as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
    }) as typeof fsp.open);
    let result: Awaited<ReturnType<typeof runLocalIndexPass>>;
    try {
      result = await runLocalIndexPass("incremental");
    } finally {
      spy.mockRestore();
    }
    expect(result.failures).toBe(1);

    const row = await localMemoryStatusJson() as {
      scan: { totalFiles: number };
      status: { files: number; chunks: number; custom: { indexIdentity: { status: string } } };
    };
    // The trap: the counts balance, because the old row is still there.
    expect(row.status.files).toBe(row.scan.totalFiles);
    expect(row.status.chunks).toBe(0);
    expect(row.status.custom.indexIdentity.status).toBe("missing");
  });

  it("still calls it empty when a registered folder is not there any more", async () => {
    // The state the captured OpenClaw payload is in — its memory directory does
    // not exist and it reports `valid` with no failed items. A folder that
    // cannot be opened IS a fault, but it is not a fault of the fingerprint and
    // no reindex can clear it, so it must not come back as "run a full
    // reindex"; the pass counts it where the card has a Failed tile.
    fs.rmSync(source, { recursive: true, force: true });
    const result = await runLocalIndexPass("full");
    const row = await localMemoryStatusJson() as {
      status: { chunks: number; custom: { indexIdentity: { status: string } } };
    };
    expect(result.failures).toBeGreaterThan(0);
    expect(row.status.chunks).toBe(0);
    expect(row.status.custom.indexIdentity.status).toBe("valid");
  });

  it("stops calling it up to date once the owner adds a folder the pass never saw", async () => {
    // "There is nothing to index" is a claim about NOW, and the count behind it
    // is one a finished pass wrote down. Adding a folder starts no pass and the
    // schedule is off until the owner arms it, so trusting that count would
    // leave a folder of documents reading as healthy and empty indefinitely.
    await runLocalIndexPass("full");
    const added = fs.mkdtempSync(path.join(os.tmpdir(), "memory-index-added-"));
    try {
      fs.writeFileSync(path.join(added, "lease.md"), "The deposit is two months' rent.");
      await writeLocalSources([source, added]);
      const status = await localMemoryStatusJson() as { status: { custom: { indexIdentity: { status: string } } } };
      expect(status.status.custom.indexIdentity.status).toBe("missing");
    } finally {
      fs.rmSync(added, { recursive: true, force: true });
    }
  });

  it("counts a document it could not convert instead of reporting nothing to index", async () => {
    // A PDF the converter refuses never becomes an indexable file, so the walk
    // is complete, the index is empty and — counted nowhere — the card said
    // "Nothing to index yet" over a document the box could not read. The
    // extractor's own notes are dropped here, so the pass is the only place
    // that can carry it: once as a failure, and once as work this pass had to
    // account for and did not, which is what keeps the empty index from calling
    // itself up to date.
    write("scan.pdf", "this is not a PDF");
    const result = await runLocalIndexPass("full");
    expect(result.failures).toBe(1);
    const row = await localMemoryStatusJson() as {
      scan: { totalFiles: number };
      status: { files: number; chunks: number; batch: { failures: number }; custom: { indexIdentity: { status: string } } };
    };
    expect(row.status.batch.failures).toBe(1);
    // `pendingFiles` on the card is totalFiles - files, so this is PENDING 1,
    // which is what takes "Nothing to index yet" off the panel.
    expect(row.scan.totalFiles).toBe(1);
    expect(row.status.files).toBe(0);
    expect(row.status.chunks).toBe(0);
    expect(row.status.custom.indexIdentity.status).toBe("missing");
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

/**
 * The bar the owner watches. The point of the feature is that indexing stops
 * being a screen with nothing on it: the pass has to say how many files its
 * scan found and how many it has finished with, from the moment it knows, and
 * it has to be telling the truth about both — a fraction over 1, or a
 * denominator that grows, is worse than the nothing this replaces.
 */
describe("what a pass reports about its own progress", () => {
  function reports() {
    const seen: { filesDone: number; filesTotal: number; chunks: number }[] = [];
    return { seen, report: (p: { filesDone: number; filesTotal: number; chunks: number }) => { seen.push({ ...p }); } };
  }

  it("names the total the scan found, and counts up to it without passing it", async () => {
    for (let i = 0; i < 5; i += 1) write(`note-${i}.md`, `Paragraph ${i} about the deposit.`);
    const { seen, report } = reports();
    await runLocalIndexPass("full", undefined, report);

    expect(seen.length).toBeGreaterThan(0);
    // Every report is about the same walk: the denominator the scan settled on
    // before the first file was opened.
    for (const r of seen) {
      expect(r.filesTotal).toBe(5);
      expect(r.filesDone).toBeLessThanOrEqual(r.filesTotal);
    }
    // Monotone, or the bar would go backwards under the owner.
    const done = seen.map((r) => r.filesDone);
    expect([...done].sort((a, b) => a - b)).toEqual(done);
    // The first report is the denominator arriving — the bar exists before any
    // file has been read — and the last one is the whole walk.
    expect(done[0]).toBe(0);
    expect(done[done.length - 1]).toBe(5);
  });

  it("counts a file it SKIPPED as done, so an unchanged folder still moves the bar", async () => {
    // The commonest pass there is: nothing changed, every file is skipped on
    // its stat. Counted only on the files it re-embedded, the bar would have
    // sat at 0 of 900 for the whole length of exactly that pass.
    for (let i = 0; i < 4; i += 1) write(`note-${i}.md`, `Paragraph ${i} about the bicycle.`);
    await runLocalIndexPass("full");
    const before = embedCalls.texts.length;

    const { seen, report } = reports();
    await runLocalIndexPass("incremental", undefined, report);
    expect(embedCalls.texts.length).toBe(before);
    expect(seen[seen.length - 1]).toEqual({ filesDone: 4, filesTotal: 4, chunks: expect.any(Number) });
  });

  it("carries the chunks the index holds, growing as the pass writes them", async () => {
    for (let i = 0; i < 4; i += 1) write(`note-${i}.md`, `Paragraph ${i} about the lasagne.`);
    const { seen, report } = reports();
    await runLocalIndexPass("full", undefined, report);
    const chunks = seen.map((r) => r.chunks);
    expect(chunks[0]).toBe(0);
    expect(chunks[chunks.length - 1]).toBeGreaterThan(0);
    expect([...chunks].sort((a, b) => a - b)).toEqual(chunks);
  });

  it("reports a total of zero for a box with nothing to index, rather than pretending", async () => {
    // No files: the honest answer is a denominator of nothing, which the card
    // draws as a bar with no percentage instead of an instant 100%.
    const { seen, report } = reports();
    await runLocalIndexPass("full", undefined, report);
    expect(seen.every((r) => r.filesTotal === 0 && r.filesDone === 0)).toBe(true);
  });

  it("indexes exactly as it always did when nobody is watching", async () => {
    write("notes.md", "The deposit is two months' rent.");
    const result = await runLocalIndexPass("full");
    expect(result.files).toBe(1);
    expect(result.chunks).toBeGreaterThan(0);
  });
});
