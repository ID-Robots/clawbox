/**
 * The Prime Radiant vault as a Memory Shard source: what a page contributes,
 * how hits are ranked (verified first), and the incremental reindex hook —
 * over a REAL vault (git in a tmp dir) with a stub embedder.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { embed } = vi.hoisted(() => ({
  embed: {
    texts: [] as string[],
    fail: false,
    model: "stub-a",
  },
}));

// One dimension per marker word plus a constant, so texts that share a word
// land near each other. Normalised like the real client does.
const MARKERS = ["widget", "invoice", "support", "warranty"];
function stubVector(text: string): Float32Array {
  const lower = text.toLowerCase();
  const raw = [...MARKERS.map((m) => (lower.includes(m) ? 1 : 0)), 0.05];
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return Float32Array.from(raw.map((v) => v / norm));
}

vi.mock("@/lib/memory-embedder", () => ({
  resolveMemoryEmbedder: async () => ({
    source: "local",
    provider: "openai-compatible",
    model: embed.model,
    baseUrl: "http://127.0.0.1/setup-api/local-ai/embed/v1",
    requestUrl: "http://127.0.0.1/setup-api/local-ai/embed/v1/embeddings",
    dimensions: 5,
    token: null,
    labelInputs: true,
  }),
}));
vi.mock("@/lib/memory-index-local", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/memory-index-local")>();
  return {
    ...actual,
    embedMemoryTexts: vi.fn(async (texts: readonly string[]) => {
      if (embed.fail) {
        throw new actual.EmbeddingUnavailableError("HTTP 502");
      }
      embed.texts.push(...texts);
      return texts.map(stubVector);
    }),
  };
});

// Memory Shard's switch: the vault is indexed only while it is on.
const { shardSwitch } = vi.hoisted(() => ({ shardSwitch: { on: true } }));
vi.mock("@/lib/memory-shard", () => ({ getMemoryShardEnabled: async () => shardSwitch.on }));

import { vaultOperation, ensureVault } from "@/lib/prime-radiant/vault";
import {
  MAX_SCORE,
  VAULT_INDEX_BUDGET_BYTES,
  VERIFIED_BOOST,
  _resetVaultIndexCacheForTests,
  _setVaultMaxChunksForTests,
  migrateVaultVectors,
  pageIndexUnits,
  planVaultChunks,
  rankVaultHits,
  readPageVectors,
  reindexPrimeRadiantPaths,
  reindexPrimeRadiantVault,
  scheduleReindexAfterCommit,
  vaultIndexingAllowed,
  searchPrimeRadiant,
  vaultChunkBytes,
  vaultIndexBudgetBytes,
  vaultIndexLimitChanged,
  vaultIndexPathFor,
  vaultIndexStatus,
  vaultMaxChunks,
  type ChunkBudgetPage,
  type RankCandidate,
} from "@/lib/prime-radiant/shard-index";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { writeSettings } from "@/lib/prime-radiant/settings";
import { encodeQ8Blob, q8BlobBytes } from "@/lib/prime-radiant/vector-q8";
import { openSqlite } from "@/lib/openclaw-session-store";
import { claim, pageText } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-shard-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;

beforeEach(() => {
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
  embed.texts = [];
  embed.fail = false;
  embed.model = "stub-a";
  shardSwitch.on = true;
  _resetVaultIndexCacheForTests();
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

const VERIFIED = { at: "2026-02-01T00:00:00.000Z", by: "owner" };

/** Write pages in one commit without the background hook, so each test drives the index itself. */
async function commit(pages: Record<string, string | null>, reindex = false): Promise<void> {
  await vaultOperation(
    "ingest: test",
    async (tx) => {
      for (const [rel, text] of Object.entries(pages)) {
        if (text === null) await tx.remove(rel);
        else await tx.write(rel, text);
      }
    },
    { lint: false, reindex },
  );
}

async function seed(): Promise<void> {
  await commit({
    "entities/acme-widgets.md": pageText(
      { type: "entity", title: "Acme Widgets Ltd", domain: "acme-sales", claims: [claim("acme-sales/acme-widgets/colour", "Acme Widgets Ltd ships blue widgets.")] },
      "Acme Widgets Ltd makes widgets in three sizes.\n",
    ),
    "concepts/support-hours.md": pageText(
      { type: "howto", title: "Support hours", domain: "acme-support" },
      "Support answers on weekdays from nine to five.\n",
    ),
  });
}

describe("what a page contributes", () => {
  it("indexes the body in chunks led by the title, and every claim on its own", () => {
    const text = pageText(
      { type: "entity", title: "Acme Widgets Ltd", claims: [claim("acme-sales/acme-widgets/colour"), claim("acme-sales/acme-widgets/size", "Widgets come in three sizes.", { verified: VERIFIED })] },
      "Acme Widgets Ltd is a synthetic company.\n",
    );
    const page = pageIndexUnits("entities/acme-widgets.md", text)!;
    expect(page).toMatchObject({ pageId: "entities/acme-widgets", title: "Acme Widgets Ltd", type: "entity", verified: false });
    expect(page.units.map((u) => [u.kind, u.refId, u.verified])).toEqual([
      ["page", "entities/acme-widgets", false],
      ["claim", "acme-sales/acme-widgets/colour", false],
      ["claim", "acme-sales/acme-widgets/size", true],
    ]);
    expect(page.units[0].text.startsWith("Acme Widgets Ltd\n\n")).toBe(true);
  });

  it("marks every unit of a page verified at page level", () => {
    const page = pageIndexUnits("concepts/x.md", pageText({ verified: VERIFIED, claims: [claim("acme-sales/x/y")] }))!;
    expect(page.verified).toBe(true);
    expect(page.units.every((u) => u.verified)).toBe(true);
  });

  it("redacts what is embedded", () => {
    const page = pageIndexUnits("concepts/x.md", pageText({}, "Write to orders@example.com for a quote.\n"))!;
    expect(page.units[0].text).not.toContain("orders@example.com");
    expect(page.units[0].text).toContain("[REDACTED:EMAIL]");
  });

  it("uses the page's own id when memory-wiki wrote one, and skips a page that does not parse", () => {
    expect(pageIndexUnits("concepts/x.md", pageText({ id: "concept.widget-pricing" }))?.pageId).toBe("concept.widget-pricing");
    expect(pageIndexUnits("concepts/x.md", "---\ntype: nonsense\n---\nbody\n")).toBeNull();
  });
});

describe("ranking", () => {
  const cand = (extra: Partial<RankCandidate>): RankCandidate => ({
    path: "concepts/a.md", refId: "concepts/a", kind: "page", type: "concept", title: "A", text: "a", verified: false, similarity: 0.5, ...extra,
  });

  it("lifts a verified hit by the boost, above a slightly closer unverified one", () => {
    const hits = rankVaultHits([
      cand({ path: "concepts/plain.md", refId: "concepts/plain", similarity: 0.8 }),
      cand({ path: "concepts/checked.md", refId: "concepts/checked", similarity: 0.75, verified: true }),
    ], 5);
    expect(hits.map((h) => h.id)).toEqual(["concepts/checked", "concepts/plain"]);
    expect(hits[0]).toMatchObject({ score: 0.85, similarity: 0.75, verified: true });
    expect(VERIFIED_BOOST).toBeLessThan(0.5);
  });

  it("does not lift a verified hit over one about something else entirely", () => {
    const hits = rankVaultHits([
      cand({ refId: "concepts/close", similarity: 0.9 }),
      cand({ refId: "concepts/far", similarity: 0.2, verified: true }),
    ], 5);
    expect(hits[0].id).toBe("concepts/close");
  });

  it("never scores above a plain similarity's ceiling, so a merge with the owner's documents stays fair", () => {
    const hits = rankVaultHits([
      cand({ refId: "concepts/near", similarity: 0.97, verified: true }),
      cand({ refId: "concepts/nearer", similarity: 0.99, verified: true }),
      cand({ refId: "concepts/plain", similarity: 1 }),
    ], 5);
    expect(MAX_SCORE).toBe(1);
    expect(hits.every((h) => h.score <= MAX_SCORE)).toBe(true);
    // All three at the ceiling, still in the order the boost gave them: the
    // clamp changes the score handed out, never the ranking.
    expect(hits.map((h) => [h.id, h.score])).toEqual([
      ["concepts/nearer", 1],
      ["concepts/near", 1],
      ["concepts/plain", 1],
    ]);
    expect(hits[0].similarity).toBe(0.99);
  });

  it("keeps the closer chunk of a page when both reach the ceiling", () => {
    const hits = rankVaultHits([
      cand({ similarity: 0.95, verified: true, text: "close" }),
      cand({ similarity: 0.98, verified: true, text: "closer" }),
      cand({ similarity: 0.96, verified: true, text: "between" }),
    ], 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ score: 1, similarity: 0.98, snippet: "closer" });
  });

  it("keeps one hit per page or claim, its best chunk", () => {
    const hits = rankVaultHits([
      cand({ similarity: 0.4, text: "worse" }),
      cand({ similarity: 0.7, text: "better" }),
      cand({ refId: "acme/a/fact", kind: "claim", similarity: 0.6 }),
    ], 5);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ id: "concepts/a", kind: "page", snippet: "better" });
  });
});

describe("the vault as a source", () => {
  it("has no source and no error when there is no vault — and leaves nothing behind", async () => {
    expect(await reindexPrimeRadiantVault()).toBeNull();
    expect(await reindexPrimeRadiantPaths(["concepts/x.md"])).toBeNull();
    expect(await searchPrimeRadiant("widgets", 5)).toEqual([]);
    expect(fs.existsSync(vaultIndexPathFor(vaultDir()))).toBe(false);
    expect(await vaultIndexStatus()).toMatchObject({ exists: false, pages: 0 });
  });

  it("indexes every knowledge page on main, beside the vault and outside it", async () => {
    await seed();
    const result = await reindexPrimeRadiantVault();
    expect(result).toMatchObject({ mode: "full", indexed: 2, removed: 0, pages: 2 });
    expect(vaultIndexPathFor(vaultDir())).toBe(path.join(process.env.PRIME_RADIANT_DIR!, "shard-index.sqlite"));
    expect(await vaultIndexStatus()).toMatchObject({ exists: true, pages: 2, identity: "valid", needsFullScan: false });
    // Bookkeeping (index.md, AGENTS.md) is not a source.
    expect(embed.texts.some((t) => t.includes("How this vault works"))).toBe(false);
  });

  it("answers hits with path, id, kind and type", async () => {
    await seed();
    await reindexPrimeRadiantVault();
    const hits = await searchPrimeRadiant("who makes widgets?", 5);
    expect(hits[0]).toMatchObject({ source: "prime-radiant", path: "entities/acme-widgets.md", type: "entity", title: "Acme Widgets Ltd" });
    expect(hits.map((h) => `${h.kind}:${h.id}`)).toEqual(
      expect.arrayContaining(["page:entities/acme-widgets", "claim:acme-sales/acme-widgets/colour"]),
    );
    expect(hits.every((h) => !path.isAbsolute(h.path))).toBe(true);
  });

  it("keeps enough distinct hits when one page fills more chunks than the limit asks for", async () => {
    // Twelve chunks of one page, every one closer to the query than the other
    // page, must not crowd it out of a request for two.
    const paragraph = `Widget sizes and finishes. ${"Each widget is checked before it ships. ".repeat(26)}`;
    await commit({
      "concepts/widget-catalogue.md": pageText({ title: "Catalogue" }, Array.from({ length: 12 }, () => paragraph).join("\n\n") + "\n"),
      "concepts/widget-invoices.md": pageText({ title: "Billing" }, "Widget orders are billed on the invoice run.\n"),
    });
    await reindexPrimeRadiantVault();
    expect((await vaultIndexStatus()).chunks).toBeGreaterThan(8);
    const hits = await searchPrimeRadiant("widget", 2);
    expect(hits.map((h) => h.path)).toEqual(["concepts/widget-catalogue.md", "concepts/widget-invoices.md"]);
  });

  it("ranks a verified page first among equally close ones", async () => {
    const body = "Warranty claims are answered within two days.\n";
    await commit({
      "concepts/warranty-a.md": pageText({ title: "Warranty A" }, body),
      "concepts/warranty-b.md": pageText({ title: "Warranty B", verified: VERIFIED }, body),
    });
    await reindexPrimeRadiantVault();
    const hits = await searchPrimeRadiant("warranty", 5);
    expect(hits[0]).toMatchObject({ path: "concepts/warranty-b.md", verified: true });
    expect(hits[0].score).toBeCloseTo(Math.min(MAX_SCORE, hits[0].similarity + VERIFIED_BOOST), 3);
    expect(hits[0].score).toBeLessThanOrEqual(MAX_SCORE);
    expect(hits[1]).toMatchObject({ path: "concepts/warranty-a.md", verified: false });
  });
});

describe("only while Memory Shard is on and the vault exists", () => {
  it("is allowed only with both", async () => {
    expect(await vaultIndexingAllowed()).toBe(false);
    await ensureVault();
    expect(await vaultIndexingAllowed()).toBe(true);
    shardSwitch.on = false;
    expect(await vaultIndexingAllowed()).toBe(false);
  });

  it("embeds nothing and makes no store while the switch is off", async () => {
    await seed();
    shardSwitch.on = false;
    expect(await reindexPrimeRadiantVault()).toBeNull();
    expect(await reindexPrimeRadiantPaths(["entities/acme-widgets.md"])).toBeNull();
    expect(embed.texts).toEqual([]);
    expect(fs.existsSync(vaultIndexPathFor(vaultDir()))).toBe(false);
  });

  it("does not index after a commit while the switch is off", async () => {
    await ensureVault();
    shardSwitch.on = false;
    await commit({ "concepts/invoices.md": pageText({ title: "Invoices" }, "Invoice numbers are sequential.\n") }, true);
    await new Promise((r) => setTimeout(r, 200));
    expect(embed.texts).toEqual([]);
    expect(fs.existsSync(vaultIndexPathFor(vaultDir()))).toBe(false);
  });

  it("catches up on what was committed while it was off with one whole-vault run", async () => {
    await seed();
    await reindexPrimeRadiantVault();
    shardSwitch.on = false;
    await commit({ "concepts/invoices.md": pageText({ title: "Invoices" }, "Invoice numbers are sequential.\n") });
    expect(await reindexPrimeRadiantPaths(["concepts/invoices.md"])).toBeNull();
    shardSwitch.on = true;
    embed.texts = [];
    expect(await reindexPrimeRadiantVault()).toMatchObject({ mode: "full", indexed: 1, unchanged: 2, pages: 3 });
    expect(embed.texts.every((t) => t.startsWith("Invoices"))).toBe(true);
  });
});

describe("the incremental reindex hook", () => {
  it("re-embeds only the pages named that changed, and drops removed ones", async () => {
    await seed();
    await reindexPrimeRadiantVault();
    embed.texts = [];

    await commit({ "concepts/support-hours.md": pageText({ type: "howto", title: "Support hours" }, "Support now answers on weekends too.\n") });
    const changed = await reindexPrimeRadiantPaths(["concepts/support-hours.md", "entities/acme-widgets.md", "index.md"]);
    expect(changed).toMatchObject({ mode: "incremental", indexed: 1, unchanged: 1, removed: 0 });
    expect(embed.texts.every((t) => t.startsWith("Support hours"))).toBe(true);
    expect((await searchPrimeRadiant("support", 1))[0].snippet).toContain("weekends");

    await commit({ "concepts/support-hours.md": null });
    expect(await reindexPrimeRadiantPaths(["concepts/support-hours.md"])).toMatchObject({ removed: 1, pages: 1 });
    expect((await searchPrimeRadiant("support", 5)).some((h) => h.path === "concepts/support-hours.md")).toBe(false);
  });

  it("keeps the vectors of a page whose metadata alone changed, asking the embedder nothing, and follows its new blob", async () => {
    await seed();
    await reindexPrimeRadiantVault();
    embed.texts = [];

    const retagged = { type: "howto", title: "Support hours", domain: "billing", owner: "finance-team", privacy: "confidential", status: "stable" } as const;
    await commit({ "concepts/support-hours.md": pageText(retagged, "Support answers on weekdays from nine to five.\n") });
    expect(await reindexPrimeRadiantPaths(["concepts/support-hours.md"])).toMatchObject({ indexed: 0, unchanged: 1, pages: 2 });
    expect(embed.texts).toEqual([]);
    // The row took the new blob: asked again, the page is not even read.
    expect(await reindexPrimeRadiantPaths(["concepts/support-hours.md"])).toMatchObject({ indexed: 0, unchanged: 1 });
    expect((await searchPrimeRadiant("support", 1))[0]).toMatchObject({ path: "concepts/support-hours.md" });

    // A new word in the body is embedded again.
    await commit({ "concepts/support-hours.md": pageText(retagged, "Support answers every day from nine to five.\n") });
    expect(await reindexPrimeRadiantPaths(["concepts/support-hours.md"])).toMatchObject({ indexed: 1, unchanged: 0 });
    expect(embed.texts.length).toBeGreaterThan(0);
  });

  it("ignores paths that are not knowledge pages", async () => {
    await seed();
    expect(await reindexPrimeRadiantPaths(["index.md", ".openclaw-wiki/x.md", "../escape.md"])).toBeNull();
  });

  it("indexes main, not a branch a nightly pass is working on", async () => {
    await seed();
    await reindexPrimeRadiantVault();
    const vault = vaultDir();
    execFileSync("git", ["-C", vault, "checkout", "-q", "-b", "dream/2026-01-16"], {
      env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } as unknown as NodeJS.ProcessEnv,
    });
    await commit({ "concepts/invoices.md": pageText({ title: "Invoices" }, "Invoice numbers are sequential.\n") });
    expect(await reindexPrimeRadiantPaths(["concepts/invoices.md"])).toMatchObject({ indexed: 0, pages: 2 });
    expect(await searchPrimeRadiant("invoice", 5)).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: "concepts/invoices.md" })]));
  });

  it("is what vaultOperation runs after a commit on main, without waiting for it", async () => {
    await ensureVault();
    await commit({ "concepts/invoices.md": pageText({ title: "Invoices" }, "Invoice numbers are sequential.\n") }, true);
    await vi.waitFor(async () => {
      expect((await vaultIndexStatus()).pages).toBe(1);
    });
    expect((await searchPrimeRadiant("invoice", 1))[0]).toMatchObject({ path: "concepts/invoices.md" });
  });

  it("does nothing after a commit that touched no knowledge page", async () => {
    await ensureVault();
    scheduleReindexAfterCommit(vaultDir(), ["index.md"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(vaultIndexPathFor(vaultDir()))).toBe(false);
  });

  it("scans the whole tree after a run the embedder refused", async () => {
    await seed();
    embed.fail = true;
    await expect(reindexPrimeRadiantPaths(["entities/acme-widgets.md"])).rejects.toThrow(/did not answer/);
    expect((await vaultIndexStatus()).needsFullScan).toBe(true);
    embed.fail = false;
    // Named one page; the store asks for the whole tree, so both are indexed.
    expect(await reindexPrimeRadiantPaths(["entities/acme-widgets.md"])).toMatchObject({ mode: "full", indexed: 2 });
    expect((await vaultIndexStatus()).needsFullScan).toBe(false);
  });

  it("answers nothing for an index built with another embedder, then rebuilds it whole", async () => {
    await seed();
    await reindexPrimeRadiantVault();
    embed.model = "stub-b";
    expect((await vaultIndexStatus()).identity).toBe("mismatched");
    expect(await searchPrimeRadiant("widgets", 5)).toEqual([]);
    expect(await reindexPrimeRadiantPaths(["entities/acme-widgets.md"])).toMatchObject({ mode: "full", indexed: 2 });
    expect((await searchPrimeRadiant("widgets", 5)).length).toBeGreaterThan(0);
  });

  it("coalesces paths queued while a run is going", async () => {
    await seed();
    const [a, b] = await Promise.all([
      reindexPrimeRadiantPaths(["entities/acme-widgets.md"]),
      reindexPrimeRadiantPaths(["concepts/support-hours.md"]),
    ]);
    // The first run took what was queued by then; whichever found nothing left answers null.
    const runs = [a, b].filter((r) => r !== null);
    expect(runs.reduce((s, r) => s + r!.indexed, 0)).toBe(2);
  });
});

describe("a full chunk budget: page vectors first", () => {
  afterEach(() => _setVaultMaxChunksForTests(null));

  it("plans every page's page chunks before any claim's, the pages with most claims giving theirs up first", () => {
    const page = (claimChunks: number, extra: Partial<ChunkBudgetPage> = {}): ChunkBudgetPage => ({ pageChunks: 1, claimChunks, held: 0, ...extra });
    // Room for all.
    expect(planVaultChunks([page(6), page(2), page(1)], 12)).toEqual([6, 2, 1]);
    // Three page chunks first, five claims left: up to two each.
    expect(planVaultChunks([page(6), page(2), page(1)], 8)).toEqual([2, 2, 1]);
    // The remainder goes one each to the first pages over the level.
    expect(planVaultChunks([page(6), page(6), page(1)], 9)).toEqual([3, 2, 1]);
    // A page whose page chunks do not fit is capped, and keeps what it holds.
    expect(planVaultChunks([page(0, { pageChunks: 2 }), page(0, { pageChunks: 3, held: 1 })], 3)).toEqual([0, null]);
    // A page the run leaves alone keeps its page chunks; its claims are shared like the others'.
    expect(planVaultChunks([page(6, { held: 7, fixed: true }), page(1)], 0)).toEqual([4, 1]);
    // A page that shrinks frees its room before a page earlier in path order needs it.
    expect(planVaultChunks([page(6, { pageChunks: 2 }), page(0, { held: 7 })], 1)).toEqual([5, 0]);
  });

  it("caps pages the run leaves alone only when a lowered budget cannot hold their page chunks — the biggest first", () => {
    const fixed = (pageChunks: number, claimChunks: number): ChunkBudgetPage => ({ pageChunks, claimChunks, held: pageChunks + claimChunks, fixed: true });
    // 6 page chunks + 6 claims held, a budget of 6 now (free -6): every claim goes, every page vector stays.
    expect(planVaultChunks([fixed(1, 2), fixed(2, 2), fixed(3, 2)], -6)).toEqual([0, 0, 0]);
    // A budget of 4: page chunks alone are 6, so the page with 3 goes whole; the rest keep theirs and one claim is left over.
    expect(planVaultChunks([fixed(1, 2), fixed(2, 2), fixed(3, 2)], -8)).toEqual([1, 0, null]);
    // Equal sizes: a later path goes first.
    expect(planVaultChunks([fixed(1, 0), fixed(1, 0), fixed(1, 0)], -1)).toEqual([0, 0, null]);
    // What a page being re-embedded holds is free again: it does not cap a fixed one.
    expect(planVaultChunks([fixed(2, 0), { pageChunks: 1, claimChunks: 0, held: 4 }], -3)).toEqual([0, 0]);
  });

  /** A page with `claims` claims, its body one chunk. */
  const pageWith = (slug: string, claims: number) =>
    pageText(
      { title: `Widget ${slug}`, claims: Array.from({ length: claims }, (_, i) => claim(`acme-sales/${slug}/fact-${i}`, `Widget ${slug} fact ${i}.`)) },
      `Widget ${slug} in short.\n`,
    );

  it("keeps a page vector for every page when claims would fill the budget, and makes room for a new page", async () => {
    // 3 page chunks + 9 claim chunks into 8: the old path-order walk filled the
    // budget with a-big's claims and left b and c without any vector.
    _setVaultMaxChunksForTests(8);
    await commit({ "concepts/a-big.md": pageWith("a", 6), "concepts/b.md": pageWith("b", 2), "concepts/c.md": pageWith("c", 1) });
    expect(await reindexPrimeRadiantVault()).toMatchObject({ indexed: 3, capped: 0, partial: 1, chunks: 8, withoutPageVector: 0 });
    expect([...(await readPageVectors()).keys()].sort()).toEqual(["concepts/a-big.md", "concepts/b.md", "concepts/c.md"]);
    expect(await vaultIndexStatus()).toMatchObject({ chunks: 8, needsFullScan: false, withoutPageVector: 0 });

    // A new page on a full budget: claims over the share go, the page gets its vector, incrementally.
    await commit({ "concepts/d.md": pageWith("d", 1) });
    expect(await reindexPrimeRadiantPaths(["concepts/d.md"])).toMatchObject({ mode: "incremental", indexed: 1, capped: 0, chunks: 8, withoutPageVector: 0 });
    expect((await readPageVectors()).has("concepts/d.md")).toBe(true);
    expect((await searchPrimeRadiant("widget d", 20)).some((h) => h.path === "concepts/d.md")).toBe(true);
    expect((await vaultIndexStatus()).needsFullScan).toBe(false);

    // Room again: an incremental run reads nothing more; a whole-tree run gives the claims back…
    await commit({ "concepts/d.md": null });
    expect(await reindexPrimeRadiantPaths(["concepts/d.md"])).toMatchObject({ removed: 1, chunks: 6 });
    embed.texts = [];
    expect(await reindexPrimeRadiantVault()).toMatchObject({ mode: "full", indexed: 2, chunks: 8, withoutPageVector: 0 });
    expect(embed.texts.some((t) => t.startsWith("Widget c"))).toBe(false);
    // …and a second one finds nothing to do.
    embed.texts = [];
    expect(await reindexPrimeRadiantVault()).toMatchObject({ indexed: 0, chunks: 8 });
    expect(embed.texts).toEqual([]);
  });

  it("keeps a verified claim longest, when a page is embedded and when its claims are dropped", async () => {
    const claimsOf = async (rel: string) =>
      (await searchPrimeRadiant("widget", 20)).filter((h) => h.kind === "claim" && h.path === rel).map((h) => h.id).sort();
    _setVaultMaxChunksForTests(4);
    // The verified claim comes last on the page.
    await commit({
      "concepts/a.md": pageText(
        { title: "Widget a", claims: [claim("acme-sales/a/fact-0", "Widget a fact 0."), claim("acme-sales/a/fact-1", "Widget a fact 1."), claim("acme-sales/a/fact-2", "Widget a fact 2.", { verified: VERIFIED })] },
        "Widget a in short.\n",
      ),
      "concepts/b.md": pageWith("b", 0),
    });
    // Two page chunks, room for two of a's three claims: the verified one and the first.
    expect(await reindexPrimeRadiantVault()).toMatchObject({ indexed: 2, partial: 1, chunks: 4 });
    expect(await claimsOf("concepts/a.md")).toEqual(["acme-sales/a/fact-0", "acme-sales/a/fact-2"]);
    // A new page takes one of them: the unverified one goes.
    await commit({ "concepts/c.md": pageWith("c", 0) });
    expect(await reindexPrimeRadiantPaths(["concepts/c.md"])).toMatchObject({ indexed: 1, chunks: 4, withoutPageVector: 0 });
    expect(await claimsOf("concepts/a.md")).toEqual(["acme-sales/a/fact-2"]);
  });

  it("lets an incremental run use the room a page that lost claims cannot take back until a whole-tree run", async () => {
    // a keeps 2 of its 6 claims.
    _setVaultMaxChunksForTests(3);
    await commit({ "concepts/a.md": pageWith("a", 6) });
    expect(await reindexPrimeRadiantVault()).toMatchObject({ partial: 1, chunks: 3 });
    // More room, and a new page: an incremental run never reads a, so a asks
    // for no more than it holds and b gets every claim that fits.
    _setVaultMaxChunksForTests(8);
    await commit({ "concepts/b.md": pageWith("b", 4) });
    expect(await reindexPrimeRadiantPaths(["concepts/b.md"])).toMatchObject({ mode: "incremental", indexed: 1, partial: 0, chunks: 8 });
  });

  it("embeds a page that shrinks before one that grows, so the room it frees is there in the same run", async () => {
    // b holds 7 chunks (1 page + 6 claims) of a budget of 8.
    _setVaultMaxChunksForTests(8);
    await commit({ "concepts/b.md": pageWith("b", 6) });
    expect(await reindexPrimeRadiantVault()).toMatchObject({ indexed: 1, chunks: 7 });
    // b shrinks to its one page chunk; a, first in path order, brings 2 page chunks and 6 claims.
    const paragraph = (n: number) => `Widget a part ${n}. `.repeat(42).trim();
    await commit({
      "concepts/a.md": pageText(
        { title: "Widget a", claims: Array.from({ length: 6 }, (_, i) => claim(`acme-sales/a/fact-${i}`, `Widget a fact ${i}.`)) },
        `${paragraph(1)}\n\n${paragraph(2)}\n`,
      ),
      "concepts/b.md": pageWith("b", 0),
    });
    // a gets both page vectors and the 5 claims left of the budget (1 + 2 + 5 = 8), in one run.
    expect(await reindexPrimeRadiantPaths(["concepts/a.md", "concepts/b.md"])).toMatchObject({ indexed: 2, capped: 0, partial: 1, chunks: 8, withoutPageVector: 0 });
    const hits = await searchPrimeRadiant("widget", 20);
    expect(hits.filter((h) => h.path === "concepts/a.md" && h.kind === "claim")).toHaveLength(5);
    expect((await readPageVectors()).has("concepts/a.md")).toBe(true);
    expect((await vaultIndexStatus()).needsFullScan).toBe(false);
  });

  it("follows a lowered limit — claims first, then the biggest pages — and fills back up when it is raised", async () => {
    _setVaultMaxChunksForTests(9);
    await commit({ "concepts/a.md": pageWith("a", 4), "concepts/b.md": pageWith("b", 2), "concepts/c.md": pageWith("c", 1) });
    expect(await reindexPrimeRadiantVault()).toMatchObject({ indexed: 3, capped: 0, chunks: 9 });

    // Lowered to 4: three page vectors and one claim (a's, the page with most claims, gives all of its up).
    _setVaultMaxChunksForTests(4);
    embed.texts = [];
    expect(await vaultIndexLimitChanged()).toMatchObject({ mode: "full", capped: 0, chunks: 4, withoutPageVector: 0 });
    expect(embed.texts).toEqual([]);
    expect([...(await readPageVectors()).keys()].sort()).toEqual(["concepts/a.md", "concepts/b.md", "concepts/c.md"]);

    // Lowered to 2: below the page vectors alone, so one page goes whole (a later path among equals) and shows as capped.
    _setVaultMaxChunksForTests(2);
    expect(await vaultIndexLimitChanged()).toMatchObject({ capped: 1, chunks: 2, withoutPageVector: 1 });
    expect([...(await readPageVectors()).keys()].sort()).toEqual(["concepts/a.md", "concepts/b.md"]);
    expect(await vaultIndexStatus()).toMatchObject({ cappedPages: 1, chunks: 2, needsFullScan: true });

    // Raised again: the capped page and the claims come back, without re-embedding the pages that kept theirs whole.
    _setVaultMaxChunksForTests(9);
    expect(await vaultIndexLimitChanged()).toMatchObject({ capped: 0, chunks: 9, withoutPageVector: 0 });
    expect(await vaultIndexStatus()).toMatchObject({ cappedPages: 0, chunks: 9, needsFullScan: false });
  });

  it("marks the store for a whole-tree run on a limit change even while Memory Shard is off", async () => {
    _setVaultMaxChunksForTests(2);
    await commit({ "concepts/a.md": pageWith("a", 0), "concepts/b.md": pageWith("b", 0), "concepts/c.md": pageWith("c", 0) });
    expect(await reindexPrimeRadiantVault()).toMatchObject({ capped: 1 });
    // A run that fits clears the marks…
    _setVaultMaxChunksForTests(3);
    expect(await reindexPrimeRadiantVault()).toMatchObject({ capped: 0, chunks: 3 });
    expect((await vaultIndexStatus()).needsFullScan).toBe(false);
    // …and a limit change while the switch is off embeds nothing but leaves the mark for the run switching it on starts.
    shardSwitch.on = false;
    expect(await vaultIndexLimitChanged()).toBeNull();
    expect(await vaultIndexStatus()).toMatchObject({ needsFullScan: true, cappedPages: null });
    // No store: nothing is created.
    process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
    expect(await vaultIndexLimitChanged()).toBeNull();
    expect(fs.existsSync(vaultIndexPathFor(vaultDir()))).toBe(false);
  });

  it("counts the pages left without a page vector in the status", async () => {
    // Page chunks alone overrun a budget of one: the second page is capped.
    _setVaultMaxChunksForTests(1);
    await commit({ "concepts/a.md": pageWith("a", 0), "concepts/b.md": pageWith("b", 0) });
    expect(await reindexPrimeRadiantVault()).toMatchObject({ indexed: 1, capped: 1, withoutPageVector: 1 });
    expect(await vaultIndexStatus()).toMatchObject({ needsFullScan: true, withoutPageVector: 1 });
  });
});

describe("vault vector width", () => {
  it("cuts a wide vector to 1,024-d and normalises it again; keeps a narrow one", async () => {
    const { truncateVector, VAULT_INDEX_DIMS, vaultMaxChunks } = await import("@/lib/prime-radiant/shard-index");
    const wide = new Float32Array(3072).fill(1 / Math.sqrt(3072));
    const cut = truncateVector(wide);
    expect(cut.length).toBe(VAULT_INDEX_DIMS);
    expect(cut.reduce((s, x) => s + x * x, 0)).toBeCloseTo(1, 5);
    const narrow = new Float32Array(384).fill(0.1);
    expect(truncateVector(narrow)).toBe(narrow);
    expect(vaultMaxChunks(3072)).toBeGreaterThanOrEqual(25_000);
  });
});

// ─── 8-bit vectors ───────────────────────────────────────────────────────────

/** Every chunk row of this case's store, in id order. */
function storedRows(): Array<{ id: number; text: string; vec: Uint8Array }> {
  const db = openSqlite(vaultIndexPathFor(vaultDir()), true);
  try {
    return (db.prepare("SELECT id, text, vec FROM chunks ORDER BY id").all() as Array<{ id: number; text: string; vec: Uint8Array }>).map((r) => ({
      id: Number(r.id),
      text: r.text,
      vec: new Uint8Array(r.vec),
    }));
  } finally {
    db.close();
  }
}

function storedMeta(key: string): string | null {
  const db = openSqlite(vaultIndexPathFor(vaultDir()), true);
  try {
    return ((db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | undefined)?.value) ?? null;
  } finally {
    db.close();
  }
}

/** Rewrite the store the way a build from before the 8-bit index left it: float32 rows, no 8-bit mark. */
function asFloat32Store(): void {
  const db = openSqlite(vaultIndexPathFor(vaultDir()), false);
  try {
    const put = db.prepare("UPDATE chunks SET vec = ? WHERE id = ?");
    for (const row of db.prepare("SELECT id, text FROM chunks").all() as Array<{ id: number; text: string }>) {
      const v = stubVector(row.text);
      put.run(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), row.id);
    }
    db.prepare("DELETE FROM meta WHERE key = 'vec_q8'").run();
  } finally {
    db.close();
  }
  _resetVaultIndexCacheForTests();
}

describe("8-bit vectors", () => {
  it("stores every vector as int8 codes and one scale: about a byte a dimension", async () => {
    await seed();
    await reindexPrimeRadiantVault();
    const rows = storedRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.vec.byteLength).toBe(q8BlobBytes(5));
      expect(Array.from(row.vec)).toEqual(Array.from(encodeQ8Blob(stubVector(row.text))));
    }
    expect(await vaultIndexStatus()).toMatchObject({
      chunks: rows.length,
      usedBytes: rows.length * q8BlobBytes(5),
      limitBytes: VAULT_INDEX_BUDGET_BYTES,
      migrationPending: false,
      cappedPages: 0,
    });
  });

  it("converts a float32 store in place on the next run: nothing re-embedded, nothing dropped, same identity, same answers", async () => {
    await seed();
    await reindexPrimeRadiantVault();
    const before = await searchPrimeRadiant("who makes widgets?", 5);
    const identity = storedMeta("identity");
    const ids = storedRows().map((r) => r.id);

    asFloat32Store();
    expect(storedRows().every((r) => r.vec.byteLength === 5 * 4)).toBe(true);
    // Read as it is until a run converts it: search and the connect pass's page vectors still answer.
    expect(await vaultIndexStatus()).toMatchObject({ identity: "valid", migrationPending: true, usedBytes: ids.length * 20 });
    expect(await searchPrimeRadiant("who makes widgets?", 5)).toEqual(before);
    expect([...(await readPageVectors()).keys()].sort()).toEqual(["concepts/support-hours.md", "entities/acme-widgets.md"]);

    embed.texts = [];
    expect(await reindexPrimeRadiantVault()).toMatchObject({ mode: "full", indexed: 0, removed: 0, pages: 2, chunks: ids.length });
    expect(embed.texts).toEqual([]);
    const after = storedRows();
    expect(after.map((r) => r.id)).toEqual(ids);
    expect(after.every((r) => r.vec.byteLength === q8BlobBytes(5))).toBe(true);
    expect(storedMeta("identity")).toBe(identity);
    expect(await vaultIndexStatus()).toMatchObject({ identity: "valid", migrationPending: false });
    expect(await searchPrimeRadiant("who makes widgets?", 5)).toEqual(before);
  });

  it("is idempotent, works in batches and picks up where a run cut short stopped", async () => {
    await commit(Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`concepts/widget-${i}.md`, pageText({ title: `Widget ${i}` }, `Widget ${i} ships blue.\n`)])));
    await reindexPrimeRadiantVault();
    const expected = storedRows().map((r) => Array.from(r.vec));
    asFloat32Store();

    const db = openSqlite(vaultIndexPathFor(vaultDir()), false);
    try {
      // An abort before the first batch leaves every row as it was.
      await expect(migrateVaultVectors(db, AbortSignal.abort(), 2)).rejects.toThrow();
      expect(storedRows().every((r) => r.vec.byteLength === 20)).toBe(true);
      // A crash after some batches: the first three rows are already 8-bit.
      const put = db.prepare("UPDATE chunks SET vec = ? WHERE id = ?");
      for (const row of storedRows().slice(0, 3)) put.run(encodeQ8Blob(stubVector(row.text)), row.id);
      // The next pass converts only the rest, two rows a transaction, to the same bytes a straight conversion writes.
      expect(await migrateVaultVectors(db, undefined, 2)).toBe(expected.length - 3);
      expect(storedRows().map((r) => Array.from(r.vec))).toEqual(expected);
      // Done: the mark says so, and a second pass is a meta read.
      expect(await migrateVaultVectors(db, undefined, 2)).toBe(0);
    } finally {
      db.close();
    }
    expect(storedMeta("vec_q8")).toBe(storedMeta("generation"));
    expect((await vaultIndexStatus()).migrationPending).toBe(false);
  });

  it("looks again when something else wrote float32 rows after the mark (a build from before, run once more)", async () => {
    await seed();
    await reindexPrimeRadiantVault();
    const db = openSqlite(vaultIndexPathFor(vaultDir()), false);
    try {
      const row = db.prepare("SELECT id, text FROM chunks ORDER BY id LIMIT 1").get() as { id: number; text: string };
      const v = stubVector(row.text);
      db.prepare("UPDATE chunks SET vec = ? WHERE id = ?").run(new Uint8Array(v.buffer), row.id);
      // That build moves the generation, not the mark.
      db.prepare("UPDATE meta SET value = CAST(value + 1 AS TEXT) WHERE key = 'generation'").run();
    } finally {
      db.close();
    }
    expect((await vaultIndexStatus()).migrationPending).toBe(true);
    await reindexPrimeRadiantVault();
    expect(storedRows().every((r) => r.vec.byteLength === q8BlobBytes(5))).toBe(true);
    expect((await vaultIndexStatus()).migrationPending).toBe(false);
  });
});

describe("the index size budget", () => {
  it("counts real bytes a chunk: the default 160 MB holds ~4x the float32 index's 40,960 chunks", () => {
    expect(VAULT_INDEX_BUDGET_BYTES).toBe(160 * 1024 * 1024);
    expect(vaultChunkBytes(1024)).toBe(1029);
    expect(vaultMaxChunks(1024)).toBe(Math.floor(VAULT_INDEX_BUDGET_BYTES / 1029));
    expect(vaultMaxChunks(1024)).toBeGreaterThan(3.9 * 40_960);
    // A wider embedder is cut to 1,024-d, so it holds the same.
    expect(vaultMaxChunks(3072)).toBe(vaultMaxChunks(1024));
    expect(vaultMaxChunks(1024) * vaultChunkBytes(1024)).toBeLessThanOrEqual(VAULT_INDEX_BUDGET_BYTES);
    expect(vaultMaxChunks(1024, 32 * 1024 * 1024)).toBe(32_608);
    expect(vaultMaxChunks(1024, 4096 * 1024 * 1024)).toBe(Math.floor((4096 * 1024 * 1024) / 1029));
    expect(vaultMaxChunks(768)).toBe(Math.floor(VAULT_INDEX_BUDGET_BYTES / 773));
    // A nonsense budget falls back to the default.
    expect(vaultMaxChunks(1024, Number.NaN)).toBe(vaultMaxChunks(1024));
  });

  it("is the owner's searchIndexLimitMb, read at every run and shown in the status", async () => {
    expect(vaultIndexBudgetBytes()).toBe(VAULT_INDEX_BUDGET_BYTES);
    writeSettings({ search: { indexLimitMb: 64 } });
    expect(vaultIndexBudgetBytes()).toBe(64 * 1024 * 1024);
    expect(await vaultIndexStatus()).toMatchObject({ exists: false, limitBytes: 64 * 1024 * 1024, maxChunks: Math.floor((64 * 1024 * 1024) / 1029) });
    await seed();
    await reindexPrimeRadiantVault();
    expect(await vaultIndexStatus()).toMatchObject({ limitBytes: 64 * 1024 * 1024, maxChunks: Math.floor((64 * 1024 * 1024) / q8BlobBytes(5)) });
    writeSettings({ search: null });
    expect(vaultIndexBudgetBytes()).toBe(VAULT_INDEX_BUDGET_BYTES);
  });
});
