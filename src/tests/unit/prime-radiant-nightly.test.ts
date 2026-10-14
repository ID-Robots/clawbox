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
import { createHashEmbedder } from "@/lib/prime-radiant/contradictions";
import type { FlashClient } from "@/lib/prime-radiant/flash-client";
import { git, headCommit } from "@/lib/prime-radiant/git";
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

  it("runs one pass at a time", async () => {
    await ensureVault();
    const first = await startNightly("manual", deps({ online: async () => false }));
    await expect(startNightly("manual", deps())).rejects.toBeInstanceOf(NightlyBusyError);
    await first.done;
    const next = await startNightly("manual", deps({ online: async () => false }));
    await next.done;
  });
});
