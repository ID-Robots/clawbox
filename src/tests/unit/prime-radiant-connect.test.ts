/**
 * The connect pass and memory-wiki's frontmatter: entity links (and entity
 * pages for names that recur), related pages, dated hubs over one-per-thing
 * leaves, a lint-clean result, and the plugin's id / pageType / sourceIds /
 * updatedAt on every page. Fixtures are synthetic.
 */
import { describe, expect, it } from "vitest";
import { createHashEmbedder } from "@/lib/prime-radiant/contradictions";
import { candidateNames, leafInfo, planConnections, RELATED_DIMS, RELATED_END, RELATED_K, RELATED_MIN_SIMILARITY, RELATED_START, runConnectPass, stripRelatedBlock } from "@/lib/prime-radiant/connect";
import { decodeVectorBlob, dequantizeQ8, encodeQ8Blob } from "@/lib/prime-radiant/vector-q8";
import { parsePage, serializePage } from "@/lib/prime-radiant/frontmatter";
import { lintVault } from "@/lib/prime-radiant/lint";
import { migratePluginFrontmatter, needsPluginFields, withPluginFields } from "@/lib/prime-radiant/plugin-compat";
import type { VaultSnapshot, VaultTx } from "@/lib/prime-radiant/vault";
import { claim, frontmatter, snapshot, vaultPage } from "../helpers/prime-radiant-fixtures";

const NOW = new Date("2026-10-01T10:00:00.000Z");

function page(title: string, opts: { type?: "entity" | "concept" | "reference"; body?: string; claims?: string[]; domain?: string; source?: string } = {}): string {
  const source = opts.source ?? `sources/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
  return serializePage(
    frontmatter({
      type: opts.type ?? "concept",
      title,
      domain: opts.domain ?? "acme-ops",
      sources: [source],
      generated: { at: "2026-09-20T10:00:00.000Z", by: "flash" },
      claims: (opts.claims ?? []).map((t, i) => claim(`acme-ops/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}/fact-${i}`, t, { updatedAt: "2026-09-20T10:00:00.000Z" })),
    }),
    opts.body ?? `${title} in short.\n`,
  );
}

function vault(): VaultSnapshot {
  const pages: Record<string, string> = {
    "entities/acme-widgets-ltd.md": page("Acme Widgets Ltd", { type: "entity", body: "Acme Widgets Ltd makes widgets.\n" }),
  };
  for (let i = 0; i < 8; i++) {
    pages[`concepts/widget-topic-${i}.md`] = page(`Widget topic ${i}`, {
      claims: [`Acme Widgets Ltd ships widget model ${i} to Globex Trading Corp.`, `The Northwind Depot stores widget model ${i}.`],
      body: `Widget topic ${i} covers widget model ${i} for Acme Widgets Ltd and Globex Trading Corp.\n`,
    });
  }
  for (let d = 1; d <= 5; d++) {
    const day = `2026-09-0${d}`;
    pages[`concepts/speedex-waybill-10544321${d}.md`] = page(`Speedex waybill 10544321${d}`, {
      type: "reference",
      claims: [`Waybill 10544321${d} for Acme Widgets Ltd was delivered on ${day}.`],
    });
  }
  for (let d = 1; d <= 4; d++) {
    pages[`concepts/daily-sales-report-2026-09-1${d}.md`] = page(`Daily sales report 2026-09-1${d}`, { type: "reference", claims: [`Total sales on 2026-09-1${d} were ${d} orders.`] });
  }
  const index = `# Index\n\n${Object.keys(pages).map((p) => `- [[${p.replace(/\.md$/, "")}]]`).join("\n")}\n`;
  return snapshot(pages, index);
}

async function vectorsFor(snap: VaultSnapshot): Promise<Map<string, Float32Array>> {
  const embedder = createHashEmbedder(256);
  const ok = snap.pages.filter((p) => p.parsed.ok);
  const vs = await embedder.embed(ok.map((p) => (p.parsed.ok ? `${p.parsed.frontmatter.title} ${stripRelatedBlock(p.parsed.body)}` : "")));
  return new Map(ok.map((p, i) => [p.path, vs[i]]));
}

/** Apply writes to a snapshot the way vaultOperation would. */
function fakeRun(snap: VaultSnapshot) {
  const commits: string[] = [];
  const run = async (message: string, fn: (tx: VaultTx) => Promise<void>) => {
    const tx = {
      vault: "/nonexistent",
      touched: new Set<string>(),
      async read(rel: string) {
        return snap.pages.find((p) => p.path === rel) ?? null;
      },
      async write(rel: string, text: string) {
        if (rel === "index.md") snap.indexBody = text;
        else {
          snap.pages = snap.pages.filter((p) => p.path !== rel);
          snap.pages.push(vaultPage(rel, text));
        }
        return rel;
      },
      async writePage(rel: string, fm: never, body: string) {
        return tx.write(rel, serializePage(withPluginFields(rel, fm), body));
      },
      async remove(rel: string) {
        return rel;
      },
    } as unknown as VaultTx;
    await fn(tx);
    commits.push(message);
    return { commit: `c${commits.length}` };
  };
  return { run, commits };
}

describe("names and leaves", () => {
  it("finds companies, proper names and CamelCase names, not sentence openers", () => {
    const n = candidateNames("Acme Widgets Ltd ships to Globex Trading Corp. The Parcel was sent. ClawPad is new. Total Sales rose.");
    expect(n.has("Acme Widgets Ltd")).toBe(true);
    expect(n.has("Globex Trading Corp")).toBe(true);
    expect(n.has("ClawPad")).toBe(true);
    expect(n.has("Parcel")).toBe(false);
    expect([...n].some((x) => x.startsWith("Total"))).toBe(false);
  });

  it("tells a leaf by a kind word and an identifier or date", () => {
    expect(leafInfo("Speedex waybill 1054432101", ["Delivered on 2026-09-03."])).toMatchObject({ kind: "shipments", qualifier: "Speedex", month: "2026-09" });
    expect(leafInfo("Daily sales report 2026-09-14")).toMatchObject({ kind: "daily-reports", month: "2026-09", sortKey: "2026-09-14" });
    // A month-name date in the title is a date too.
    expect(leafInfo("Adnet receipt email 0.05 4 jun 2026 21:59")).toMatchObject({ kind: "invoices", month: "2026-06", sortKey: "2026-06-04" });
    expect(leafInfo("Invoice process")).toBeNull();
    expect(leafInfo("Daily standup notes")).toBeNull();
  });

  it("takes no street or city of a postal address for a name, and still finds the names around it", () => {
    const n = candidateNames("The order ships to 12 Maple Grove Drive, Springfield, AB T4N 1A1, Canada.");
    expect(n.has("Maple Grove Drive")).toBe(false);
    expect(n.has("Springfield")).toBe(false);
    // With no commas, the region code reads like a legal suffix ("… Springfield AB").
    const bare = candidateNames("Deliver to 12 Maple Grove Drive Springfield AB T4N 1A1 by Friday.");
    expect([...bare].filter((x) => x.includes("Springfield") || x.includes("Maple"))).toEqual([]);
    // A two-word city, a US ZIP.
    const us = candidateNames("Returns go to 500 Old Mill Road, Elm Ridge, CA 95999. Stock is at 7 Harbour St, Port Wells, NY.");
    expect([...us].filter((x) => /Mill|Elm|Harbour|Port Wells/.test(x))).toEqual([]);
    // Names that end in a street word, or are near an address, are still names.
    const kept = candidateNames("Acme Widgets Ltd keeps files in Google Drive. The Northwind Depot ships to 12 Maple Grove Drive, Springfield, AB T4N 1A1.");
    expect(kept.has("Google Drive")).toBe(true);
    expect(kept.has("Northwind Depot")).toBe(true);
    expect(kept.has("Acme Widgets Ltd")).toBe(true);
    // A street with no city is one where a punctuation mark ends it; a count before a name is no house number.
    expect(candidateNames("Deliver to 77 Lakeview Road. Ask for Contoso Labs.").has("Lakeview Road")).toBe(false);
    const counted = candidateNames("We moved 200 Google Drive files to Northwind Depot.");
    expect(counted.has("Google Drive")).toBe(true);
    expect(counted.has("Northwind Depot")).toBe(true);
  });

  it("creates no entity page for the street or city of an address many pages carry", async () => {
    const pages: Record<string, string> = {};
    for (let i = 1; i <= 6; i++) {
      pages[`concepts/order-4410${i}-contoso.md`] = page(`Order 4410${i} for Contoso Pharmacy`, {
        claims: [`Order 4410${i} for Contoso Pharmacy ships to 12 Maple Grove Drive, Springfield, AB T4N 1A1, Canada.`],
        body: `Order 4410${i} goes to 12 Maple Grove Drive Springfield AB T4N 1A1.\n`,
      });
    }
    const plan = await planConnections(snapshot(pages, "# Index\n"), { now: NOW, vectors: new Map() });
    const created = plan.writes.map((w) => w.path).filter((p) => p.startsWith("entities/"));
    expect(created).toContain("entities/contoso-pharmacy.md");
    expect(created.filter((p) => /maple|grove|springfield/.test(p))).toEqual([]);
  });
});

describe("planConnections", () => {
  it("links entities, creates recurring ones, builds hubs, and leaves the vault lint-clean with ≥5 links a page", async () => {
    const snap = vault();
    const lintBefore = lintVault(snap, { now: NOW });
    expect(lintBefore.errors).toBe(0);
    const { run, commits } = fakeRun(snap);
    const result = await runConnectPass(snap, run, { now: NOW, vectors: await vectorsFor(snap), minSimilarity: 0.1 });
    expect(commits.length).toBeGreaterThan(0);
    expect(result.entitiesCreated).toBeGreaterThanOrEqual(2); // Globex Trading Corp, Northwind Depot
    expect(result.hubs).toBe(2);
    expect(result.leaves).toBe(9);
    expect(result.linksMedian).toBeGreaterThanOrEqual(5);

    const paths = snap.pages.map((p) => p.path);
    expect(paths).toContain("entities/globex-trading-corp.md");
    expect(paths).toContain("syntheses/speedex-shipments-2026-09.md");
    expect(paths).toContain("syntheses/daily-reports-2026-09.md");
    const leaf = snap.pages.find((p) => p.path === "concepts/speedex-waybill-105443213.md")!;
    expect(leaf.parsed.body).toContain(RELATED_START);
    expect(leaf.parsed.body).toContain("[[syntheses/speedex-shipments-2026-09]]");
    expect(leaf.parsed.body).toContain("[[entities/acme-widgets-ltd]]");

    const lint = lintVault(snap, { now: NOW });
    expect(lint.findings).toEqual([]);

    // Plugin fields on every page written.
    const hub = snap.pages.find((p) => p.path === "syntheses/speedex-shipments-2026-09.md")!;
    expect(hub.parsed.ok && hub.parsed.frontmatter).toMatchObject({ id: "syntheses/speedex-shipments-2026-09", pageType: "synthesis", type: "synthesis" });
    expect(hub.parsed.ok && (hub.parsed.frontmatter.sourceIds as string[]).length).toBeGreaterThan(0);

    // A second run changes nothing.
    const again = await planConnections(snap, { now: NOW, vectors: await vectorsFor(snap), minSimilarity: 0.1 });
    expect(again.writes).toEqual([]);
  });

  /** Warranty pages that share words, widget pages that share others, one page that shares none; every page in index.md. */
  function wordVault(extra: { claimsVerified?: boolean; repairsBody?: string } = {}): VaultSnapshot {
    const pages: Record<string, string> = {
      "concepts/widget-assembly.md": page("Widget assembly line", { claims: ["The widget assembly line runs two shifts."] }),
      "concepts/widget-paint.md": page("Widget paint shop", { claims: ["The widget paint shop runs one shift."] }),
      "concepts/warranty-claims.md": serializePage(
        frontmatter({
          type: "concept",
          title: "Warranty claims handling",
          domain: "acme-ops",
          sources: ["sources/warranty-claims.md"],
          verified: extra.claimsVerified ? { at: "2026-09-01T00:00:00.000Z", by: "owner" } : null,
          claims: [claim("acme-ops/warranty-claims/answer", "Warranty claims are answered within two days."), claim("acme-ops/warranty-claims/receipt", "Warranty returns need the original receipt.")],
        }),
        "How warranty claims and returns are handled.\n",
      ),
      "concepts/warranty-returns.md": page("Warranty returns policy", {
        claims: ["Warranty returns are accepted within thirty days.", "Returns need the original receipt and the serial number."],
        body: "The warranty returns policy.\n",
      }),
      "concepts/warranty-repairs.md": page("Warranty repairs", { claims: ["Warranty repairs take a week."], body: extra.repairsBody }),
      "concepts/zqx.md": page("Zqx", { body: "Qq.\n" }),
    };
    const index = `# Index\n\n${Object.keys(pages).map((p) => `- [[${p.replace(/\.md$/, "")}]]`).join("\n")}\n`;
    return snapshot(pages, index);
  }

  it("links a page the search index has no vector for by its words, and gets it an inbound link", async () => {
    const snap = wordVault();
    const vectors = await vectorsFor(snap);
    vectors.delete("concepts/warranty-returns.md");
    vectors.delete("concepts/zqx.md");
    const plan = await planConnections(snap, { now: NOW, vectors });
    const body = (p: string) => plan.writes.find((w) => w.path === p)?.body ?? "";

    // Its "Similar pages" by words, nearest first.
    expect(body("concepts/warranty-returns.md")).toMatch(/### Similar pages\n\n- \[\[concepts\/warranty-claims\]\]/);
    expect(body("concepts/warranty-returns.md")).not.toContain("widget");
    // Another content page links it (index.md listing it does not count).
    expect(plan.writes.some((w) => w.path !== "concepts/warranty-returns.md" && w.body.includes("[[concepts/warranty-returns]]"))).toBe(true);
    expect(plan.stats.pagesLexical).toBe(1);
    // The page whose words tie it to nothing is left as it is, and counted:
    // index.md lists it, and it is still the one orphan.
    expect(plan.writes.some((w) => w.path === "concepts/zqx.md")).toBe(false);
    expect(plan.stats).toMatchObject({ orphansAfter: 1, isolatedAfter: 1, unlinkable: 1 });

    // Every other content page links somewhere and is linked from somewhere.
    const { run } = fakeRun(snap);
    await runConnectPass(snap, run, { now: NOW, vectors });
    expect(lintVault(snap, { now: NOW }).findings.filter((f) => f.rule === "orphan").map((f) => f.path)).toEqual(["concepts/zqx.md"]);
    // The same plan twice: nothing more to write.
    expect((await planConnections(snap, { now: NOW, vectors })).writes).toEqual([]);
  });

  it("never rewrites a verified page or overfills a block to reach a page: it stays an orphan, counted", async () => {
    const full = `Warranty repairs.\n\n${"Repairs are booked by phone and collected by courier. ".repeat(105)}\n`;
    const snap = wordVault({ claimsVerified: true, repairsBody: full });
    const vectors = new Map<string, Float32Array>();
    const plan = await planConnections(snap, { now: NOW, vectors });
    // The verified page is its owner's; the repairs page has no room left.
    expect(plan.writes.some((w) => w.path === "concepts/warranty-claims.md")).toBe(false);
    expect(plan.writes.find((w) => w.path === "concepts/warranty-repairs.md")?.body ?? "").not.toContain("[[concepts/warranty-returns]]");
    // It still links out, to the verified page among others.
    expect(plan.writes.find((w) => w.path === "concepts/warranty-returns.md")?.body).toContain("[[concepts/warranty-claims]]");
    expect(plan.stats.orphansAfter).toBeGreaterThanOrEqual(2);
    expect(plan.stats.unlinkable).toBe(1);
  });

  it("puts a page nobody lists among its similar pages into its nearest page's, within that page's budget", async () => {
    // Six pages alike: each one's five nearest are the other five, so none
    // lists the questions page, though it is near them all.
    const pages: Record<string, string> = {};
    for (const name of ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"]) {
      pages[`concepts/tariff-${name.toLowerCase()}.md`] = page(`Pallet tariff ${name}`, {
        claims: ["Pallet courier tariff is charged per pallet and zone.", "Fuel surcharge applies to the pallet tariff."],
        body: "Pallet tariff.\n",
      });
    }
    pages["concepts/pallet-questions.md"] = page("Pallet tariff questions", { claims: ["Customers ask how the pallet tariff is charged."], body: "Questions.\n" });
    pages["concepts/office-holidays.md"] = page("Office holidays", { claims: ["The office closes in August."] });
    const plan = await planConnections(snapshot(pages, "# Index\n"), { now: NOW, vectors: new Map() });
    const linking = plan.writes.filter((w) => w.body.includes("[[concepts/pallet-questions]]")).map((w) => w.path);
    // The nearest (ties by path), and only it.
    expect(linking).toEqual(["concepts/tariff-alpha.md"]);
    expect(plan.writes.find((w) => w.path === "concepts/tariff-alpha.md")?.body).toMatch(/### Similar pages\n\n(- .*\n){5}- \[\[concepts\/pallet-questions\]\]/);
    expect(plan.stats).toMatchObject({ pagesLexical: 7, orphansAfter: 1, isolatedAfter: 1, unlinkable: 1 });
  });

  it("links pages in no hub that share a rare entity (only leaves of one hub are left out)", async () => {
    const pages: Record<string, string> = { "entities/globex-ltd.md": page("Globex Ltd", { type: "entity", body: "Globex Ltd is a supplier.\n" }) };
    for (const name of ["alpha", "bravo", "charlie"]) {
      pages[`concepts/${name}-notes.md`] = page(`${name} notes`, { claims: [`The ${name} notes mention Globex Ltd.`], body: `${name} notes in short.\n` });
    }
    const snap = snapshot(pages, null);
    // Orthogonal vectors: no page is "similar" to another, so a shared entity is the only tie between them.
    const vectors = new Map<string, Float32Array>([
      ["concepts/alpha-notes.md", Float32Array.from([1, 0, 0, 0])],
      ["concepts/bravo-notes.md", Float32Array.from([0, 1, 0, 0])],
      ["concepts/charlie-notes.md", Float32Array.from([0, 0, 1, 0])],
      ["entities/globex-ltd.md", Float32Array.from([0, 0, 0, 1])],
    ]);
    const plan = await planConnections(snap, { now: NOW, vectors });
    const alpha = plan.writes.find((w) => w.path === "concepts/alpha-notes.md")!;
    expect(alpha.body).toContain("### Shares entities with");
    expect(alpha.body).toContain("[[concepts/bravo-notes]]");
    expect(alpha.body).toContain("[[concepts/charlie-notes]]");
  });

  it("replaces its block, never duplicates it", () => {
    const body = `Summary.\n\n${RELATED_START}\n## Related\n\n- [[a]] — A\n${RELATED_END}\n`;
    expect(stripRelatedBlock(body)).toBe("Summary.\n");
  });
});

describe("memory-wiki frontmatter", () => {
  it("adds id, pageType, sourceIds and updatedAt; keeps Prime Radiant's own fields", () => {
    const fm = frontmatter({ type: "reference", sources: ["sources/a.md"], claims: [claim("acme-sales/widget/price", "Acme Widgets Ltd sells widgets.", { updatedAt: "2026-02-01T00:00:00.000Z" })] });
    const out = withPluginFields("concepts/widget-pricing.md", fm);
    expect(out).toMatchObject({ id: "concepts/widget-pricing", pageType: "concept", type: "reference", sourceIds: ["sources/a.md"], updatedAt: "2026-02-01T00:00:00.000Z" });
    expect(needsPluginFields("concepts/widget-pricing.md", fm)).toBe(true);
    expect(needsPluginFields("concepts/widget-pricing.md", out)).toBe(false);
    const reparsed = parsePage(serializePage(out, "Body.\n"));
    expect(reparsed.ok).toBe(true);
  });

  it("migrates every page that lacks the fields, body untouched", async () => {
    const snap = vault();
    const { run } = fakeRun(snap);
    const dry = await migratePluginFrontmatter(snap, run, { dryRun: true });
    expect(dry.updated).toBe(snap.pages.length);
    const done = await migratePluginFrontmatter(snap, run);
    expect(done.updated).toBe(dry.updated);
    expect(snap.pages.every((p) => p.parsed.ok && !needsPluginFields(p.path, p.parsed.frontmatter))).toBe(true);
    expect(lintVault(snap, { now: NOW }).errors).toBe(0);
  });
});

// ── 8-bit page vectors (the search index stores vectors in 8 bits) ────────

/** A vector the way the index hands it to the pass: stored in 8 bits, read back cut to `dims` and at unit length (readPageVectors). */
function viaIndex(v: Float32Array, dims = v.length): Float32Array {
  const back = dequantizeQ8(decodeVectorBlob(encodeQ8Blob(v))!).slice(0, dims);
  return unitLength(back);
}

function unitLength(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** The pass's rule: the RELATED_K closest pages at RELATED_MIN_SIMILARITY or more. */
function neighbours(sims: number[], self: number): number[] {
  return sims
    .map((s, j) => [s, j] as const)
    .filter(([s, j]) => j !== self && s >= RELATED_MIN_SIMILARITY)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .slice(0, RELATED_K)
    .map(([, j]) => j);
}

describe("8-bit page vectors", () => {
  it("give the pass the same links as float32 on the fixture vault, at the default threshold and a low one", async () => {
    for (const minSimilarity of [undefined, 0.1]) {
      const exact = await vectorsFor(vault());
      const stored = new Map([...exact].map(([p, v]) => [p, viaIndex(v)]));
      const a = await planConnections(vault(), { now: NOW, vectors: exact, minSimilarity });
      const b = await planConnections(vault(), { now: NOW, vectors: stored, minSimilarity });
      expect(b.writes.length).toBeGreaterThan(0);
      expect(b.writes).toEqual(a.writes);
    }
  });

  it("keep recall@10 at 1 on the fixture vault's vectors", async () => {
    const exact = [...(await vectorsFor(vault())).values()];
    const stored = exact.map((v) => viaIndex(v));
    let recall = 0;
    exact.forEach((q) => {
      const top = (vs: Float32Array[]) => vs.map((v, j) => [cosine(q, v), j] as const).sort((x, y) => y[0] - x[0] || x[1] - y[1]).slice(0, 10).map(([, j]) => j);
      const truth = new Set(top(exact));
      recall += top(stored).filter((j) => truth.has(j)).length / 10;
    });
    expect(recall / exact.length).toBe(1);
  });

  it("keep the same neighbours over the threshold on a seeded set, but for pairs within 0.01 of a boundary", () => {
    // 240 pages in 24 topics, each page a different mix of its topic and its own noise, so
    // similarities spread across the threshold (1,024-d stored, RELATED_DIMS compared).
    let seed = 1234;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
    const D = 1024;
    const topics = Array.from({ length: 24 }, () => unitLength(Float32Array.from({ length: D }, gauss)));
    const pages = Array.from({ length: 240 }, (_, i) => {
      const mix = 0.3 + 0.5 * rand();
      const noise = unitLength(Float32Array.from({ length: D }, gauss));
      return unitLength(Float32Array.from(topics[i % 24], (x, d) => mix * x + (1 - mix) * noise[d]));
    });
    const exact = pages.map((v) => unitLength(v.slice(0, RELATED_DIMS)));
    const stored = pages.map((v) => viaIndex(v, RELATED_DIMS));
    let same = 0;
    let linked = 0;
    let maxError = 0;
    exact.forEach((_, i) => {
      const fs32 = exact.map((v) => cosine(exact[i], v));
      const fs8 = stored.map((v) => cosine(stored[i], v));
      fs32.forEach((s, j) => (maxError = Math.max(maxError, Math.abs(s - fs8[j]))));
      const a = neighbours(fs32, i);
      const b = neighbours(fs8, i);
      linked += a.length;
      if (a.join() === b.join()) same += 1;
      // Any page that is a neighbour one way and not the other sits on a boundary: the threshold or the K-th place.
      const kth = [...fs32].filter((_, j) => j !== i).sort((x, y) => y - x)[RELATED_K - 1];
      for (const j of [...a.filter((j) => !b.includes(j)), ...b.filter((j) => !a.includes(j))]) {
        expect(Math.min(Math.abs(fs32[j] - RELATED_MIN_SIMILARITY), Math.abs(fs32[j] - kth)), `page ${i} → ${j}`).toBeLessThan(0.01);
      }
    });
    // The set exercises the threshold: plenty of links, not every pair.
    expect(linked).toBeGreaterThan(200);
    expect(linked).toBeLessThan(240 * RELATED_K);
    expect(maxError).toBeLessThan(0.01);
    expect(same / exact.length).toBeGreaterThanOrEqual(0.95);
  });
});
