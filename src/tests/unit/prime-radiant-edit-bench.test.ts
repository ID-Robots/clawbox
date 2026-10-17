/**
 * How long one page edit takes on a LARGE vault — a benchmark, not a test.
 *
 * Skipped unless PRIME_RADIANT_BENCH is set:
 *
 *   PRIME_RADIANT_BENCH=1 npx vitest run --project unit src/tests/unit/prime-radiant-edit-bench.test.ts
 *
 * It builds a synthetic vault (PRIME_RADIANT_BENCH_PAGES pages, default 8000:
 * frontmatter with claims, a body with links, every page listed in index.md,
 * one commit), then times what a metadata edit is made of and the edits
 * themselves: the vault snapshot, the scoped lint, one PATCH-style
 * `{ domain, owner }` edit, a bulk edit of 500 pages (dry run and real), a
 * merge dry run and a merge. With
 * PRIME_RADIANT_BENCH_OUT=<file> the timings are written there as JSON too.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializePage } from "@/lib/prime-radiant/frontmatter";
import { git } from "@/lib/prime-radiant/git";
import { lintVault } from "@/lib/prime-radiant/lint";
import { withPluginFields } from "@/lib/prime-radiant/plugin-compat";
import type { PageFrontmatter, PageType } from "@/lib/prime-radiant/schema";
import { ensureVault, readVaultSnapshot } from "@/lib/prime-radiant/vault";
import * as edit from "@/lib/prime-radiant/edit";

const ENABLED = !!process.env.PRIME_RADIANT_BENCH;
const PAGES = Math.max(50, Number(process.env.PRIME_RADIANT_BENCH_PAGES) || 8000);
const RUNS = Math.max(1, Number(process.env.PRIME_RADIANT_BENCH_RUNS) || 5);

const TYPES: Array<[PageType, string]> = [
  ["entity", "entities"],
  ["concept", "concepts"],
  ["howto", "howtos"],
  ["reference", "references"],
];
const DOMAINS = ["acme-widgets", "billing", "infrastructure", "people", "sales", "support"];
const WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango".split(" ");

const owner = { by: "owner", person: true } as const;

function words(seed: number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[(seed * 7 + i * 13) % WORDS.length]);
  return out.join(" ");
}

function pagePath(i: number): string {
  const [, folder] = TYPES[i % TYPES.length];
  return `${folder}/page-${String(i).padStart(5, "0")}.md`;
}

function pageText(i: number): string {
  const [type] = TYPES[i % TYPES.length];
  const domain = DOMAINS[i % DOMAINS.length];
  const entity = `page-${String(i).padStart(5, "0")}`;
  const at = "2026-09-01T10:00:00Z";
  const fm: PageFrontmatter = {
    type,
    title: `Page ${i} ${words(i, 3)}`,
    domain,
    owner: "owner",
    status: "draft",
    generated: { at, by: "ingest" },
    verified: null,
    stale_after: null,
    sources: [`notes/source-${i % 400}.md`],
    privacy: "internal",
    checked_by: "flash",
    opus_pending: false,
    claims: [0, 1, 2].map((k) => ({
      id: `${domain}/${entity}/fact-${k}`,
      text: `Fact ${k} about page ${i}: ${words(i + k, 8)}.`,
      confidence: 0.8,
      status: "proposed",
      updatedAt: at,
      evidence: [{ kind: "source", path: `notes/source-${i % 400}.md`, updatedAt: at }],
    })),
    retiredClaimIds: [],
  };
  const links = [1, 2, 3].map((d) => `[[${pagePath((i + d * 97) % PAGES).replace(/\.md$/, "")}]]`).join(", ");
  const body = [
    `Page ${i} is about ${words(i, 12)}.`,
    "## Details",
    Array.from({ length: 6 }, (_, k) => `${words(i + k, 18)}.`).join(" "),
    `See also ${links}.`,
  ].join("\n\n");
  return serializePage(withPluginFields(pagePath(i), fm), body);
}

async function time<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: Math.round(performance.now() - t0), value };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

describe.runIf(ENABLED)(`Prime Radiant edit benchmark (${PAGES} pages)`, () => {
  let root: string;
  let vault: string;
  const results: Record<string, number | string> = { pages: PAGES };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-bench-"));
    vault = path.join(root, "vault");
    await ensureVault(vault);
    for (const [, folder] of TYPES) fs.mkdirSync(path.join(vault, folder), { recursive: true });
    const index = ["# Index", "", "Every page of this wiki is listed here, one line each.", ""];
    for (let i = 0; i < PAGES; i++) {
      fs.writeFileSync(path.join(vault, pagePath(i)), pageText(i));
      index.push(`- [[${pagePath(i).replace(/\.md$/, "")}|Page ${i}]]`);
    }
    fs.writeFileSync(path.join(vault, "index.md"), `${index.join("\n")}\n`);
    await git(vault, ["add", "-A"], { timeoutMs: 300_000 });
    await git(vault, ["commit", "--quiet", "-m", "bench: seed"], { timeoutMs: 300_000 });
  }, 600_000);

  afterAll(() => {
    console.log(`\n[prime-radiant bench]\n${Object.entries(results).map(([k, v]) => `  ${k.padEnd(34)} ${v}`).join("\n")}\n`);
    if (process.env.PRIME_RADIANT_BENCH_OUT) fs.writeFileSync(process.env.PRIME_RADIANT_BENCH_OUT, `${JSON.stringify(results, null, 2)}\n`);
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("times the parts a metadata edit used to be made of", async () => {
    const snap = await time(() => readVaultSnapshot(vault));
    expect(snap.value.pages.length).toBe(PAGES);
    results["readVaultSnapshot ms"] = snap.ms;
    const lint = await time(async () => lintVault(snap.value, { scope: [pagePath(5)] }));
    expect(lint.value.findings.filter((f) => f.blocksCommit)).toEqual([]);
    results["lintVault (one page in scope) ms"] = lint.ms;
  }, 600_000);

  it("times one { domain, owner } page edit", async () => {
    const ms: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const target = pagePath(10 + run);
      const r = await time(() => edit.editPage(target, { domain: `retagged-${run}`, owner: `team-${run}` }, owner, { vault }));
      expect(r.value.commit).not.toBeNull();
      expect(r.value.changed.sort()).toEqual(["domain", "owner"]);
      ms.push(r.ms);
    }
    results["editPage {domain, owner} median ms"] = median(ms);
    results["editPage runs ms"] = ms.join(", ");
  }, 600_000);

  it("times a bulk edit of 500 pages, dry run and real", async () => {
    if (!("bulkEditPages" in edit)) return;
    const input = { edits: Array.from({ length: 500 }, (_, k) => ({ edit: { path: pagePath(1000 + k), domain: "bulk-retagged" } })), dryRun: true };
    const dry = await time(() => edit.bulkEditPages(input, owner, { vault }));
    expect(dry.value.changed).toHaveLength(500);
    results["bulkEditPages 500 dry run ms"] = dry.ms;
    const real = await time(() => edit.bulkEditPages({ ...input, dryRun: false }, owner, { vault }));
    expect(real.value.commit).not.toBeNull();
    expect(real.value.changed).toHaveLength(500);
    results["bulkEditPages 500 ms"] = real.ms;
  }, 600_000);

  it("times a merge dry run and a merge", async () => {
    const input = { into: pagePath(100), from: [pagePath(104)], dryRun: true, keepIntoBody: false };
    const dry = await time(() => edit.mergePages(input, owner, { vault }));
    expect(dry.value.commit).toBeNull();
    results["mergePages dry run ms"] = dry.ms;
    const merge = await time(() => edit.mergePages({ ...input, dryRun: false }, owner, { vault }));
    expect(merge.value.commit).not.toBeNull();
    results["mergePages ms"] = merge.ms;
  }, 600_000);
});
