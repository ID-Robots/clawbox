/**
 * The nightly Opus tier is gone (TASK-2181): a nightly pass over a REAL git
 * vault, on a box whose settings.json still switches the second opinion on,
 * whose account pool holds a usable Claude sign-in and whose PATH holds a
 * `claude` — everything the removed tier needed to run Claude Code headless —
 * starts every process it needs (git) and never `claude`: no Opus call, no
 * Opus bookkeeping. Every child process the pass starts is recorded at
 * `child_process` itself. Fixtures are synthetic.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => {
  const commands: string[] = [];
  /** `child_process` with every way of starting a process recording what it starts. */
  async function recording(importOriginal: () => Promise<typeof import("child_process")>) {
    const actual = await importOriginal();
    const { promisify } = await import("util");
    const wrap = (name: keyof typeof actual) => {
      const fn = actual[name] as unknown as (...args: unknown[]) => unknown;
      const wrapped = (...args: unknown[]) => {
        commands.push(String(args[0]));
        return fn(...args);
      };
      const custom = (fn as unknown as Record<symbol, ((...args: unknown[]) => unknown) | undefined>)[promisify.custom];
      if (custom) {
        Object.defineProperty(wrapped, promisify.custom, {
          value: (...args: unknown[]) => {
            commands.push(String(args[0]));
            return custom(...args);
          },
        });
      }
      return wrapped;
    };
    const names = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;
    const mocked = { ...actual, ...Object.fromEntries(names.map((n) => [n, wrap(n)])) };
    return { ...mocked, default: mocked };
  }
  return { commands, recording };
});
vi.mock("child_process", (importOriginal) => seen.recording(importOriginal as () => Promise<typeof import("child_process")>));
vi.mock("node:child_process", (importOriginal) => seen.recording(importOriginal as () => Promise<typeof import("child_process")>));
// A Claude sign-in that is usable now, and no API key: the removed tier's subscription path.
vi.mock("@/lib/anthropic-accounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/anthropic-accounts")>()),
  readAccounts: async () => [{ id: "acct-login", kind: "login", label: "Claude" }],
  isUsable: () => true,
  readUsableApiKey: async () => null,
}));
vi.mock("@/lib/claude-login", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/claude-login")>()),
  hasAnthropicLogin: () => true,
}));

import { createHashEmbedder } from "@/lib/prime-radiant/contradictions";
import { createStubFlashClient } from "@/lib/prime-radiant/flash-stub";
import { listNightlyRuns, runNightly, type NightlySummary } from "@/lib/prime-radiant/nightly";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { listReviewItems } from "@/lib/prime-radiant/review-store";
import { readCostSummary } from "@/lib/prime-radiant/runs";
import { DEFAULT_COST_RATES } from "@/lib/prime-radiant/cost-rates";
import { readSettings } from "@/lib/prime-radiant/settings";
import { ensureVault, readVaultSnapshot } from "@/lib/prime-radiant/vault";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-no-claude-"));
const prev = { dir: process.env.PRIME_RADIANT_DIR, files: process.env.FILES_ROOT, path: process.env.PATH };
const NOW = new Date(2026, 4, 20, 3, 0);
let caseDir = "";
let marker = "";

beforeEach(() => {
  caseDir = fs.mkdtempSync(path.join(base, "case-"));
  const docs = path.join(caseDir, "home", "Documents");
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, "pricing.md"), "The blue widget costs 10 EUR per unit.");
  fs.writeFileSync(path.join(docs, "catalogue.txt"), "The blue widget costs 12 EUR per unit.");
  process.env.FILES_ROOT = path.join(caseDir, "home");
  process.env.PRIME_RADIANT_DIR = path.join(caseDir, "prime-radiant");
  // A `claude` first on PATH that leaves a mark if anything ever runs it.
  const bin = path.join(caseDir, "bin");
  marker = path.join(caseDir, "claude-ran");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "$@" >> '${marker}'\necho '{"result":"[]"}'\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${prev.path ?? ""}`;
  // The settings an older box saved with the second opinion switched on.
  fs.mkdirSync(process.env.PRIME_RADIANT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.PRIME_RADIANT_DIR, "settings.json"),
    JSON.stringify({
      opus: { enabled: true, capUsd: 1000, sampleRate: 1, model: "claude-opus-5-5", maxPages: 2000 },
      ingest: { folders: [docs] },
    }),
  );
  seen.commands.length = 0;
});

afterAll(() => {
  for (const [key, value] of [["PRIME_RADIANT_DIR", prev.dir], ["FILES_ROOT", prev.files], ["PATH", prev.path]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(base, { recursive: true, force: true });
});

describe("the nightly pass without the Opus tier", () => {
  it("never starts `claude`, even with the old Opus settings on and a `claude` on PATH", async () => {
    await ensureVault();
    expect("opus" in readSettings()).toBe(false);
    const run = await runNightly("manual", { client: createStubFlashClient(), embedder: createHashEmbedder(), online: async () => true, now: () => NOW });
    expect(run).not.toBeNull();
    expect(run!.status).not.toBe("failed");
    expect(listNightlyRuns()[0]).toMatchObject({ id: run!.id });
    const summary = run!.summary as unknown as NightlySummary;
    // The pass did its work: it imported the folder and ran git for it.
    expect(summary.ingest).toMatchObject({ status: "done" });
    expect(seen.commands.some((c) => path.basename(c) === "git")).toBe(true);

    // ...and never anything Claude.
    expect(seen.commands.filter((c) => /claude/i.test(path.basename(c)))).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
    expect(summary).not.toHaveProperty("opus");
    expect(JSON.stringify(summary)).not.toMatch(/opus/i);
    const costs = readCostSummary(vaultDir(), DEFAULT_COST_RATES);
    expect(costs.byOperation.map((o) => o.operation)).not.toContain("opus-review");
    expect(costs.byModel.map((m) => m.model).filter((m) => /claude|opus/i.test(m))).toEqual([]);
    expect(costs).not.toHaveProperty("byBasis");
    expect(listReviewItems(vaultDir(), { status: "all", kind: "opus" }).items).toEqual([]);
    const pages = (await readVaultSnapshot(vaultDir())).pages;
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) expect(page.text, page.path).not.toMatch(/opus/i);
  });
});
