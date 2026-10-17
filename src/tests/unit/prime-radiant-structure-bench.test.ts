/**
 * The structure pass on a 10,000-page synthetic vault (8,000 record leaves of
 * seven types over a year, stub entities, topics in four domains, decisions).
 *
 * The PLAN always runs — under a bound a CI runner keeps — and is planned a
 * second time over its own result to show it settles (nothing left to write).
 *
 * The whole run ON DISK — the snapshot, the first night's commits, a second
 * night that writes nothing — is a benchmark, skipped unless PRIME_RADIANT_BENCH
 * is set:
 *
 *   PRIME_RADIANT_BENCH=1 npx vitest run --project unit src/tests/unit/prime-radiant-structure-bench.test.ts
 *
 * PRIME_RADIANT_BENCH_PAGES changes the size (default 10000);
 * PRIME_RADIANT_BENCH_OUT=<file> writes the timings there as JSON.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { serializePage } from "@/lib/prime-radiant/frontmatter";
import { git } from "@/lib/prime-radiant/git";
import { withPluginFields } from "@/lib/prime-radiant/plugin-compat";
import { defaultSettings } from "@/lib/prime-radiant/settings";
import { planStructure } from "@/lib/prime-radiant/structure";
import { runStructure } from "@/lib/prime-radiant/structure-run";
import { DEFAULT_COST_RATES } from "@/lib/prime-radiant/cost-rates";
import { ensureVault, readVaultSnapshot, vaultOperation } from "@/lib/prime-radiant/vault";
import { snapshot, vaultPage } from "../helpers/prime-radiant-fixtures";
import { DOMAINS, OWN_COMPANY, syntheticVault } from "../helpers/prime-radiant-structure-fixtures";

const ENABLED = !!process.env.PRIME_RADIANT_BENCH;
const PAGES = Math.max(100, Number(process.env.PRIME_RADIANT_BENCH_PAGES) || 10_000);
const NOW = new Date("2026-10-01T10:00:00.000Z");
const OPTIONS = { now: NOW, domains: DOMAINS, company: OWN_COMPANY };

/** The bound the 10k plan must keep: generous for a shared CI runner (it takes about a second on a laptop). */
const PLAN_BOUND_MS = 30_000;

const results: Record<string, number | string> = { pages: PAGES };

afterAll(() => {
  console.log(`\n[prime-radiant structure bench]\n${Object.entries(results).map(([k, v]) => `  ${k.padEnd(36)} ${v}`).join("\n")}\n`);
  if (process.env.PRIME_RADIANT_BENCH_OUT) fs.writeFileSync(process.env.PRIME_RADIANT_BENCH_OUT, `${JSON.stringify(results, null, 2)}\n`);
});

function ms(t0: number): number {
  return Math.round(performance.now() - t0);
}

describe(`the structure plan on ${PAGES} pages`, () => {
  it("stays within its bound and settles: a second plan over its result writes nothing", () => {
    const snap = snapshot(syntheticVault(PAGES), "# Index\n");
    const t0 = performance.now();
    const plan = planStructure(snap, OPTIONS);
    const planMs = ms(t0);
    results.planMs = planMs;
    results.plannedWrites = plan.writes.length;
    results.recordHubs = plan.stats.recordHubs;
    results.linksMedianBefore = plan.stats.linksMedianBefore;
    results.linksMedianAfter = plan.stats.linksMedianAfter;
    expect(planMs).toBeLessThan(PLAN_BOUND_MS);
    expect(plan.stats.leavesInHubs).toBe(plan.stats.leaves);

    const pages = new Map(snap.pages.map((p) => [p.path, p]));
    for (const w of plan.writes) pages.set(w.path, vaultPage(w.path, serializePage(withPluginFields(w.path, w.frontmatter), w.body)));
    const t1 = performance.now();
    const again = planStructure({ ...snap, pages: [...pages.values()] }, { ...OPTIONS, now: new Date("2026-10-02T10:00:00.000Z") });
    results.replanMs = ms(t1);
    expect(again.writes).toEqual([]);
  }, 120_000);
});

describe.runIf(ENABLED)(`the structure pass on disk (${PAGES} pages)`, () => {
  it("first night, then a second night that writes nothing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-structure-bench-"));
    const vault = path.join(root, "vault");
    try {
      await ensureVault(vault);
      const pages = syntheticVault(PAGES);
      const index = ["# Index", ""];
      for (const [rel, text] of Object.entries(pages)) {
        fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
        fs.writeFileSync(path.join(vault, rel), text);
        index.push(`- [[${rel.replace(/\.md$/, "")}]]`);
      }
      fs.writeFileSync(path.join(vault, "index.md"), `${index.join("\n")}\n`);
      await git(vault, ["add", "-A"], { timeoutMs: 300_000 });
      await git(vault, ["commit", "--quiet", "-m", "bench: seed"], { timeoutMs: 300_000 });

      const settings = { ...defaultSettings(), domains: DOMAINS, structure: { ...defaultSettings().structure, company: OWN_COMPANY } };
      const run = async (message: string, fn: Parameters<typeof vaultOperation>[1]) => ({ commit: (await vaultOperation(message, fn, { vault, now: NOW, reindex: false })).commit });
      const opts = { stateVault: vault, settings, rates: DEFAULT_COST_RATES, online: false, now: () => NOW };

      let t0 = performance.now();
      const snap = await readVaultSnapshot(vault);
      results.snapshotMs = ms(t0);
      t0 = performance.now();
      const first = await runStructure(snap, run, opts);
      results.firstNightMs = ms(t0);
      results.firstNightWritten = first.written;
      results.firstNightCommits = first.commits.length;

      t0 = performance.now();
      const second = await runStructure(await readVaultSnapshot(vault), run, opts);
      results.secondNightMs = ms(t0);
      results.secondNightWritten = second.written;
      expect(first.written).toBeGreaterThan(0);
      expect(second.written).toBe(0);
      expect(second.commits).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 1_800_000);
});
