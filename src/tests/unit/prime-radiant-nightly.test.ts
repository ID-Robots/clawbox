/**
 * The nightly pass end to end over a REAL git vault: the dream branch in its
 * own worktree, the nightly ingest with the model replaced, the lint hold, the
 * contradiction pass, the gate, the merge and the owner's merge of a held
 * night. Offline and "no vault yet" never throw. Fixtures are synthetic.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHashEmbedder, fullComparisonDone, readComparedThrough, readDeferredClaims } from "@/lib/prime-radiant/contradictions";
import type { FlashClient } from "@/lib/prime-radiant/flash-client";
import { git, headCommit } from "@/lib/prime-radiant/git";
import { stubGoldenVerdict } from "@/lib/prime-radiant/flash-stub";
import { readGoldenItems } from "@/lib/prime-radiant/golden";
import { goldenStatus } from "@/lib/prime-radiant/golden-score";
import { addGoldenQuestion } from "@/lib/prime-radiant/golden-store";
import { readJudgeItems } from "@/lib/prime-radiant/judge";
import {
  dreamBranchName,
  HeldNightError,
  listNightlyRuns,
  localDate,
  mergeHeldNight,
  NightlyBusyError,
  runNightly,
  safeDreamBranch,
  startNightly,
  worktreePath,
  type NightlySummary,
} from "@/lib/prime-radiant/nightly";
import type { OpusClient } from "@/lib/prime-radiant/opus";
import { stateDbPath, vaultDir } from "@/lib/prime-radiant/paths";
import { setVaultReindexHook } from "@/lib/prime-radiant/reindex-hook";
import { resolveReviewItem } from "@/lib/prime-radiant/review";
import { listReviewItems } from "@/lib/prime-radiant/review-store";
import { defaultSettings, type PrimeRadiantSettings } from "@/lib/prime-radiant/settings";
import { withStateDb } from "@/lib/prime-radiant/state-db";
import { ensureVault, readVaultSnapshot, vaultOperation } from "@/lib/prime-radiant/vault";
import { readWriterItems } from "@/lib/prime-radiant/writer";
import { claim, pageText } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-nightly-"));
const prev = { dir: process.env.PRIME_RADIANT_DIR, files: process.env.FILES_ROOT };
let n = 0;
let filesRoot = "";
const NOW = new Date(2026, 4, 20, 3, 0);

/** The writer: one card per document; the judge: prices of the same widget that differ contradict. */
const client: FlashClient = {
  model: "deepseek-v4-flash",
  async complete(request) {
    const pairs = readJudgeItems(request.user);
    if (pairs) {
      const text = JSON.stringify(pairs.map((p) => ({ i: p.i, verdict: /widget costs/.test(p.a) && /widget costs/.test(p.b) ? "contradiction" : "compatible", why: "prices differ" })));
      return { text, model: "deepseek-v4-flash", usage: { promptTokens: 100, completionTokens: 20, cacheHitTokens: 0 } };
    }
    const items = readWriterItems(request.user) ?? [];
    const cards = items.map((it) => ({
      i: it.i,
      useful: true,
      type: "concept",
      title: `Acme ${path.basename(it.path).replace(/\.\w+$/, "")}`,
      domain: "acme-sales",
      summary: "A synthetic Acme document.",
      facts: [{ fact: it.text.trim().slice(0, 200), confidence: 0.7 }],
      sensitivity: "internal",
      confidence: 0.7,
    }));
    return { text: JSON.stringify(cards), model: "deepseek-v4-flash", usage: { promptTokens: 100, completionTokens: 50, cacheHitTokens: 0 } };
  },
};

function settings(extra: Partial<PrimeRadiantSettings> = {}): PrimeRadiantSettings {
  const s = defaultSettings();
  return { ...s, ...extra, ingest: { ...s.ingest, folders: [path.join(filesRoot, "Documents")], ...(extra.ingest ?? {}) } };
}

const deps = (extra: Record<string, unknown> = {}) => ({
  client,
  embedder: createHashEmbedder(),
  online: async () => true,
  now: () => NOW,
  settings: settings(),
  ...extra,
});

beforeEach(() => {
  const caseDir = path.join(base, `case-${++n}`);
  filesRoot = path.join(caseDir, "home");
  fs.mkdirSync(path.join(filesRoot, "Documents"), { recursive: true });
  fs.writeFileSync(path.join(filesRoot, "Documents", "pricing.md"), "The blue widget costs 10 EUR per unit.");
  fs.writeFileSync(path.join(filesRoot, "Documents", "catalogue.txt"), "The blue widget costs 12 EUR per unit.");
  process.env.FILES_ROOT = filesRoot;
  process.env.PRIME_RADIANT_DIR = path.join(caseDir, "prime-radiant");
});

afterEach(() => setVaultReindexHook(null));

afterAll(() => {
  for (const [key, value] of [["PRIME_RADIANT_DIR", prev.dir], ["FILES_ROOT", prev.files]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(base, { recursive: true, force: true });
});

async function branches(): Promise<string[]> {
  return (await git(vaultDir(), ["branch", "--format=%(refname:short)"])).stdout.split("\n").filter(Boolean).sort();
}

describe("nightly pass", () => {
  it("does nothing, creates nothing and never throws before the vault exists", async () => {
    expect(await runNightly("schedule", deps())).toBeNull();
    expect(fs.existsSync(stateDbPath())).toBe(false);
    expect(listNightlyRuns()).toEqual([]);
  });

  it("names its branch dream/<local date>, and the next free one on a second run that day", async () => {
    await ensureVault();
    expect(localDate(NOW)).toBe("2026-05-20");
    expect(await dreamBranchName(vaultDir(), NOW)).toBe("dream/2026-05-20");
    await git(vaultDir(), ["branch", "dream/2026-05-20"]);
    expect(await dreamBranchName(vaultDir(), NOW)).toBe("dream/2026-05-20-2");
    expect(safeDreamBranch("dream/2026-05-20-02")).toBe("dream/2026-05-20-2");
    for (const bad of ["main", "dream/x", "dream/2026-05-20;rm", "../dream/2026-05-20"]) expect(safeDreamBranch(bad)).toBeNull();
  });

  it("ingests on the branch, finds the contradiction, merges, cleans up and tells the reindex hook", async () => {
    await ensureVault();
    const hook = vi.fn();
    setVaultReindexHook(hook);
    const before = (await headCommit(vaultDir()))!.sha;
    const run = await runNightly("manual", deps());
    expect(run).toMatchObject({ status: "merged", trigger: "manual", branch: "dream/2026-05-20" });
    const summary = run!.summary as unknown as NightlySummary;
    expect(summary.ingest).toMatchObject({ status: "done", pages: 2 });
    expect(summary.merged).toBe(true);
    expect(summary.contradictions.findings).toBe(1);
    expect(summary.gate.touched).toEqual([]);
    expect(run!.usdEstimate).toBeGreaterThan(0);

    // main has the pages; the branch and the worktree are gone.
    const snap = await readVaultSnapshot();
    expect(snap.pages).toHaveLength(2);
    expect((await headCommit(vaultDir()))!.sha).not.toBe(before);
    expect(await branches()).toEqual(["main"]);
    expect(fs.existsSync(worktreePath(vaultDir()))).toBe(false);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0]).toEqual(snap.pages.map((p) => p.path));

    const items = listReviewItems(vaultDir());
    expect(items.items.map((i) => i.kind)).toEqual(["contradiction"]);
    expect(items.items[0].runId).toBe(run!.id);
    expect(listNightlyRuns()[0]).toMatchObject({ id: run!.id, status: "merged" });

    // A second night with nothing new: no branch is left behind.
    const second = await runNightly("schedule", deps({ now: () => new Date(2026, 4, 21, 3, 0) }));
    expect(second?.status).toBe("nothing");
    expect(await branches()).toEqual(["main"]);
  });

  // The live test: memory-wiki compiled into main's checkout — a Related
  // block on every page, its own <folder>/index.md with no frontmatter — and
  // the night was held. Now the first night repairs it, and a block the
  // plugin writes later never makes main "dirty".
  it("is not held by what memory-wiki wrote into main, and repairs it once", async () => {
    await ensureVault();
    const page = pageText({ title: "Terms", claims: [claim("acme-sales/terms/net", "Acme Widgets Ltd pays suppliers within 30 days.")] }, "Acme terms.\n");
    await vaultOperation("seed: terms", async (tx) => {
      await tx.write("concepts/terms.md", page);
      await tx.write("index.md", "# Index\n\n- [[concepts/terms]]\n");
    });
    const v = vaultDir();
    const related = (text: string) =>
      `${text.trimEnd()}\n\n## Related\n<!-- openclaw:wiki:related:start -->\n- [Index](../index.md)\n<!-- openclaw:wiki:related:end -->\n`;
    const compile = () => {
      fs.writeFileSync(path.join(v, "concepts", "terms.md"), related(page));
      fs.mkdirSync(path.join(v, "entities"), { recursive: true });
      fs.writeFileSync(path.join(v, "entities", "index.md"), "# Entities\n\n## Generated\n<!-- openclaw:wiki:entities:index:start -->\n- No entities yet.\n<!-- openclaw:wiki:entities:index:end -->\n");
    };
    compile();

    const run = await runNightly("manual", deps());
    expect(run).toMatchObject({ status: "merged" });
    const summary = run!.summary as unknown as NightlySummary;
    expect(summary.held).toEqual([]);
    expect(summary.notes.join(" ")).toMatch(/memory-wiki's generated blocks and files were taken out of the vault \(1 page\(s\), 1 file\(s\)\)/);
    expect(fs.readFileSync(path.join(v, "concepts", "terms.md"), "utf8")).toBe(page);
    expect(fs.existsSync(path.join(v, "entities", "index.md"))).toBe(false);

    // The plugin compiles again during the day; the next night still merges.
    compile();
    fs.writeFileSync(path.join(filesRoot, "Documents", "shipping.md"), "Orders ship within three working days.");
    const second = await runNightly("schedule", deps({ now: () => new Date(2026, 4, 21, 3, 0) }));
    expect(second).toMatchObject({ status: "merged" });
    expect((second!.summary as unknown as NightlySummary).notes.join(" ")).not.toMatch(/memory-wiki/);
    expect(fs.readFileSync(path.join(v, "concepts", "terms.md"), "utf8")).toBe(page);
    expect((await git(v, ["status", "--porcelain"])).stdout.trim()).toBe("");
  });

  it("offline: skips the ingest and the judge, still lints and gates, and finds nothing to merge", async () => {
    await ensureVault();
    const run = await runNightly("schedule", deps({ online: async () => false }));
    expect(run?.status).toBe("nothing");
    const summary = run!.summary as unknown as NightlySummary;
    expect(summary.ingest).toEqual({ skipped: "offline" });
    expect(summary.contradictions.skipped).toBe("offline");
    expect(summary.notes.join(" ")).toMatch(/not reachable/);
  });

  it("holds a night whose change carries a lint error; the owner merges it once its items are resolved", async () => {
    await ensureVault();
    // A page over the hard size cap: any change to it is a lint error.
    await vaultOperation("seed: long page", async (tx) => {
      await tx.write("concepts/long.md", pageText({ title: "Long", claims: [claim("acme-sales/long/fact", "A long page fact.")] }, `${"Acme widgets. ".repeat(1000)}\n`));
      await tx.write("index.md", "# Index\n\n- [[concepts/long]]\n");
    });
    const opus: OpusClient = {
      model: "claude-opus-5-5",
      complete: async () => ({ text: '[{"k":0,"verdict":"ok","claims":[],"note":"fine"}]', model: "claude-opus-5-5", usage: { promptTokens: 1000, completionTokens: 50, cacheHitTokens: 0 } }),
    };
    const s = settings({ opus: { ...defaultSettings().opus, enabled: true, capUsd: 5 } });
    const run = await runNightly("manual", deps({ settings: { ...s, ingest: { ...s.ingest, folders: [] } }, opus, online: async () => false, random: () => 0 }));
    expect(run?.status).toBe("held");
    const summary = run!.summary as unknown as NightlySummary;
    expect(summary.held).toEqual(["lint"]);
    expect(summary.opus).toMatchObject({ reviewed: 1 });
    expect(await branches()).toEqual(["dream/2026-05-20", "main"]);
    expect(fs.existsSync(worktreePath(vaultDir()))).toBe(false);
    const lint = listReviewItems(vaultDir(), { kind: "lint" }).items;
    expect(lint.length).toBeGreaterThan(0);

    await expect(mergeHeldNight("dream/2026-05-20")).rejects.toMatchObject({ code: "open_items" });
    for (const item of lint) await resolveReviewItem(item.id, { action: "dismiss" }, { by: "owner" });
    const merged = await mergeHeldNight("dream/2026-05-20");
    expect(merged.changed).toEqual(["concepts/long.md"]);
    expect(await branches()).toEqual(["main"]);
    expect(listNightlyRuns()[0]).toMatchObject({ status: "merged" });
    await expect(mergeHeldNight("dream/2026-05-20")).rejects.toBeInstanceOf(HeldNightError);
  });

  it("a second held night gets its own lint items: an item an earlier night raised cannot clear it", async () => {
    await ensureVault();
    await vaultOperation("seed: long page", async (tx) => {
      await tx.write("concepts/long.md", pageText({ title: "Long", claims: [claim("acme-sales/long/fact", "A long page fact.")] }, `${"Acme widgets. ".repeat(1000)}\n`));
      await tx.write("index.md", "# Index\n\n- [[concepts/long]]\n");
    });
    const opus: OpusClient = {
      model: "claude-opus-5-5",
      complete: async () => ({ text: '[{"k":0,"verdict":"ok","claims":[],"note":"fine"}]', model: "claude-opus-5-5", usage: { promptTokens: 1000, completionTokens: 50, cacheHitTokens: 0 } }),
    };
    const s = settings({ opus: { ...defaultSettings().opus, enabled: true, capUsd: 5 } });
    const night = (day: number) =>
      runNightly("manual", deps({ settings: { ...s, ingest: { ...s.ingest, folders: [] } }, opus, online: async () => false, random: () => 0, now: () => new Date(2026, 4, day, 3, 0) }));
    const first = await night(20);
    const second = await night(21);
    expect(first?.status).toBe("held");
    expect(second?.status).toBe("held");
    const lint = listReviewItems(vaultDir(), { kind: "lint" }).items;
    expect(lint.some((i) => i.runId === first!.id)).toBe(true);
    expect(lint.some((i) => i.runId === second!.id)).toBe(true);
    // The first night's items are still open; the second night's are its own.
    await expect(mergeHeldNight("dream/2026-05-21")).rejects.toMatchObject({ code: "open_items" });
  });

  it("a night whose judge failed is not the full comparison: the next night judges its pairs and raises the item", async () => {
    await ensureVault();
    // The judge answers prose with no verdict; the writer still works, so the pages land on main.
    const brokenJudge: FlashClient = {
      model: "deepseek-v4-flash",
      async complete(request) {
        if (readJudgeItems(request.user)) return { text: "I could not decide.", model: "deepseek-v4-flash", usage: { promptTokens: 100, completionTokens: 5, cacheHitTokens: 0 } };
        return client.complete(request);
      },
    };
    const first = await runNightly("schedule", deps({ client: brokenJudge }));
    expect(first?.status).toBe("merged");
    const s1 = first!.summary as unknown as NightlySummary;
    expect(s1.contradictions.queried).toBeGreaterThan(0);
    expect(s1.contradictions.deferredPairs).toBeGreaterThan(0);
    expect(s1.contradictions.complete).toBe(false);
    expect(s1.notes.join(" ")).toMatch(/judged next pass/);
    expect(readDeferredClaims(vaultDir()).size).toBeGreaterThan(0);
    expect(fullComparisonDone(vaultDir())).toBe(false);
    expect(listReviewItems(vaultDir(), { kind: "contradiction" }).items).toEqual([]);

    // The next night changes no page (the same documents are skipped), and still judges what was owed.
    const second = await runNightly("schedule", deps({ now: () => new Date(2026, 4, 21, 3, 0) }));
    const s2 = second!.summary as unknown as NightlySummary;
    expect(s2.contradictions.skipped).toBeNull();
    expect(s2.contradictions.queried).toBeGreaterThan(0);
    expect(s2.contradictions.findings).toBe(1);
    expect(s2.contradictions.deferredPairs).toBe(0);
    expect(s2.contradictions.complete).toBe(true);
    expect(listReviewItems(vaultDir(), { kind: "contradiction" }).items).toHaveLength(1);
    expect(readDeferredClaims(vaultDir()).size).toBe(0);
    expect(fullComparisonDone(vaultDir())).toBe(true);

    // Now the nights are scoped: a quiet one compares nothing.
    const third = await runNightly("schedule", deps({ now: () => new Date(2026, 4, 22, 3, 0) }));
    const s3 = third!.summary as unknown as NightlySummary;
    expect(s3.contradictions).toMatchObject({ queried: 0, carried: 0, skipped: "nothing_to_compare" });
  });

  it("compares what reached main by day: the scope is everything changed since the last finished comparison", async () => {
    await ensureVault();
    const first = await runNightly("schedule", deps());
    expect((first!.summary as unknown as NightlySummary).contradictions.complete).toBe(true);
    const mark = readComparedThrough(vaultDir());
    const items = () => listReviewItems(vaultDir(), { kind: "contradiction" }).items;
    expect(items()).toHaveLength(1);

    // By day: Add documents (or an edit) commits straight to main, not to a dream branch.
    await vaultOperation("ingest: 1 document", async (tx) => {
      await tx.write("concepts/daytime-price.md", pageText({ title: "Daytime price", claims: [claim("acme-sales/daytime-price/blue", "The blue widget costs 15 EUR per unit.")] }));
    });
    // An offline night compares nothing and does not move the mark.
    const offline = await runNightly("schedule", deps({ online: async () => false, now: () => new Date(2026, 4, 21, 3, 0) }));
    expect((offline!.summary as unknown as NightlySummary).contradictions.skipped).toBe("offline");
    expect(readComparedThrough(vaultDir())).toBe(mark);

    // The next night ingests nothing new (its branch changes nothing), and still compares the daytime page.
    const second = await runNightly("schedule", deps({ now: () => new Date(2026, 4, 22, 3, 0) }));
    const s2 = second!.summary as unknown as NightlySummary;
    expect(s2.commits).toBe(0);
    expect(s2.contradictions.queried).toBe(1);
    expect(s2.contradictions.findings).toBeGreaterThan(0);
    expect(s2.notes.join(" ")).toMatch(/1 page\(s\) changed since the last comparison outside this night's branch were compared too/);
    expect(items().filter((i) => i.pages.includes("concepts/daytime-price.md")).length).toBeGreaterThan(0);
    expect(mark).toMatch(/^[0-9a-f]{40}$/);
    const after = readComparedThrough(vaultDir());
    expect(after).not.toBe(mark);
    expect(after).toBe((await headCommit(vaultDir()))!.sha);

    // Compared once is compared: the night after is quiet again.
    const third = await runNightly("schedule", deps({ now: () => new Date(2026, 4, 23, 3, 0) }));
    expect((third!.summary as unknown as NightlySummary).contradictions).toMatchObject({ queried: 0, skipped: "nothing_to_compare" });
  });

  it("compares every claim when the recorded comparison's commit is gone", async () => {
    await ensureVault();
    await runNightly("schedule", deps());
    withStateDb(vaultDir(), (db) => db.prepare("UPDATE pass_state SET value = ? WHERE key = 'compared_through'").run("0".repeat(40)));
    const second = await runNightly("schedule", deps({ now: () => new Date(2026, 4, 21, 3, 0) }));
    const s2 = second!.summary as unknown as NightlySummary;
    expect(s2.contradictions.queried).toBe(s2.contradictions.claims);
    expect(s2.contradictions.queried).toBeGreaterThan(0);
    expect(readComparedThrough(vaultDir())).toBe((await headCommit(vaultDir()))!.sha);
  });

  it("never hands git a recorded mark that is no commit id, and compares every claim instead", async () => {
    await ensureVault();
    await runNightly("schedule", deps());
    for (const bad of ["HEAD", "--all", "main~1", "0123456789abcdef", ""]) {
      withStateDb(vaultDir(), (db) => db.prepare("UPDATE pass_state SET value = ? WHERE key = 'compared_through'").run(bad));
      expect(readComparedThrough(vaultDir())).toBeNull();
    }
    const second = await runNightly("schedule", deps({ now: () => new Date(2026, 4, 21, 3, 0) }));
    const s2 = second!.summary as unknown as NightlySummary;
    expect(s2.contradictions.queried).toBe(s2.contradictions.claims);
    expect(readComparedThrough(vaultDir())).toMatch(/^[0-9a-f]{40}$/);
  });

  it("an offline night does not count as the full comparison", async () => {
    await ensureVault();
    await runNightly("schedule", deps({ online: async () => false }));
    expect(fullComparisonDone(vaultDir())).toBe(false);
  });

  it("checks the golden questions against main once the night is merged, under the night's run", async () => {
    await ensureVault();
    await addGoldenQuestion({ question: "What does the blue widget cost?", expected: "10 EUR per unit", domain: "acme-sales" }, { domains: [] });
    const asked: string[] = [];
    const withGolden: FlashClient = {
      model: client.model,
      async complete(request) {
        const golden = readGoldenItems(request.user);
        if (!golden) return client.complete(request);
        asked.push(...golden.map((g) => g.question));
        const text = JSON.stringify(golden.map((g) => ({ i: g.i, verdict: stubGoldenVerdict(g.expected, g.facts), why: "fake" })));
        return { text, model: client.model, usage: { promptTokens: 80, completionTokens: 10, cacheHitTokens: 0 } };
      },
    };
    const search = vi.fn(async () => []);
    const run = await runNightly("manual", deps({ client: withGolden, goldenSearch: search }));
    expect(run?.status).toBe("merged");
    const summary = run!.summary as unknown as NightlySummary;
    // The night's own import is on main by then: the wiki answers with it.
    expect(summary.golden).toMatchObject({ scoreId: run!.id, tally: { asked: 1, correct: 1, percent: 100 }, capped: 0, calls: 1, regressions: [] });
    expect(asked).toEqual(["What does the blue widget cost?"]);
    expect(search).toHaveBeenCalledTimes(1);
    expect((await goldenStatus()).last).toMatchObject({ runId: run!.id, percent: 100 });
  });

  it("skips the golden check offline or when it is switched off, and says why", async () => {
    await ensureVault();
    await addGoldenQuestion({ question: "What does the blue widget cost?", expected: "10 EUR", domain: "acme-sales" }, { domains: [] });
    const offline = await runNightly("schedule", deps({ online: async () => false }));
    expect((offline!.summary as unknown as NightlySummary).golden).toEqual({ skipped: "offline" });
    const off = await runNightly("schedule", deps({ online: async () => false, settings: { ...settings(), golden: { enabled: false, maxQuestions: 50 } } }));
    expect((off!.summary as unknown as NightlySummary).golden).toEqual({ skipped: "disabled" });
    expect((await goldenStatus()).last).toBeNull();
  });

  it("runs one pass at a time", async () => {
    await ensureVault();
    const first = await startNightly("manual", deps({ online: async () => false }));
    await expect(startNightly("manual", deps())).rejects.toBeInstanceOf(NightlyBusyError);
    await first.done;
    const next = await startNightly("manual", deps({ online: async () => false }));
    await next.done;
  });
});
