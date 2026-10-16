/**
 * The Prime Radiant vault as a Memory Shard source: what a page contributes,
 * how hits are ranked (verified first), and the incremental reindex hook —
 * over a REAL vault (git in a tmp dir) with a stub embedder.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  VERIFIED_BOOST,
  _resetVaultIndexCacheForTests,
  pageIndexUnits,
  rankVaultHits,
  reindexPrimeRadiantPaths,
  reindexPrimeRadiantVault,
  scheduleReindexAfterCommit,
  vaultIndexingAllowed,
  searchPrimeRadiant,
  vaultIndexPathFor,
  vaultIndexStatus,
  type RankCandidate,
} from "@/lib/prime-radiant/shard-index";
import { vaultDir } from "@/lib/prime-radiant/paths";
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
