/**
 * The nightly pass's parts with every model replaced: the contradiction pass
 * (kNN blocking, the judge, its caches), what the removed Opus tier left on
 * pages, the scheduler's clock and the settings sections.
 * Fixtures are synthetic.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectClaims,
  createHashEmbedder,
  nearestPairs,
  nearestPairsYielding,
  pairHash,
  runContradictionPass,
  SAME_SUBJECT_PARTNERS,
  type ClaimEmbedder,
} from "@/lib/prime-radiant/contradictions";
import { DEFAULT_COST_RATES } from "@/lib/prime-radiant/cost-rates";
import { FlashCallError, type FlashClient } from "@/lib/prime-radiant/flash-client";
import { createStubFlashClient, stubVerdict } from "@/lib/prime-radiant/flash-stub";
import { buildJudgePrompt, JudgeParseError, parseJudgeResponse, readJudgeItems } from "@/lib/prime-radiant/judge";
import { computeNextNightlyMs } from "@/lib/prime-radiant/nightly-scheduler";
import { parsePage, serializePage } from "@/lib/prime-radiant/frontmatter";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { listReviewItems } from "@/lib/prime-radiant/review-store";
import { readCostSummary } from "@/lib/prime-radiant/runs";
import { readSettings, readSettingsPatch, SettingsError, writeSettings } from "@/lib/prime-radiant/settings";
import { runInTransaction } from "@/lib/prime-radiant/state-db";
import { readVaultSnapshot, vaultOperation } from "@/lib/prime-radiant/vault";
import { claim, pageText, snapshot } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-passes-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;

beforeEach(() => {
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

const PAGES = {
  "concepts/pricing.md": pageText({ claims: [claim("acme-sales/pricing/blue-widget", "The blue widget costs 10 EUR per unit.")] }),
  "concepts/catalogue.md": pageText({
    title: "Catalogue",
    claims: [
      claim("acme-sales/catalogue/blue-widget", "The blue widget costs 12 EUR per unit."),
      claim("acme-sales/catalogue/support", "Support answers mail at help@example.com on weekdays."),
    ],
  }),
  "concepts/shipping.md": pageText({ title: "Shipping", claims: [claim("acme-ops/shipping/days", "Orders ship within three working days.")] }),
};

function judge(verdict: (a: string, b: string) => string, onCall?: (user: string) => void): FlashClient & { calls: number } {
  const c = {
    model: "deepseek-v4-flash",
    calls: 0,
    async complete(request: { user: string }) {
      c.calls += 1;
      onCall?.(request.user);
      const items = readJudgeItems(request.user) ?? [];
      const text = JSON.stringify(items.map((it) => ({ i: it.i, verdict: verdict(it.a, it.b), why: "figures differ" })));
      return { text, model: "deepseek-v4-flash", usage: { promptTokens: 1000, completionTokens: 100, cacheHitTokens: 0 } };
    },
  };
  return c;
}

describe("contradiction pass: pieces", () => {
  it("collects active claims redacted", () => {
    const claims = collectClaims(snapshot(PAGES));
    expect(claims).toHaveLength(4);
    expect(claims.find((c) => c.id === "acme-sales/catalogue/support")?.text).toContain("[REDACTED:EMAIL]");
  });

  it("pairs each query with its nearest neighbours on other pages, each pair once", () => {
    const claims = [
      { id: "a/b/c", page: "p1" },
      { id: "a/b/d", page: "p1" },
      { id: "a/e/c", page: "p2" },
      { id: "a/f/c", page: "p3" },
    ];
    const v = (x: number, y: number) => Float32Array.from([x, y]);
    const vectors = [v(1, 0), v(0.99, 0.1), v(0.98, 0.2), v(0, 1)];
    const pairs = nearestPairs(claims, vectors, [0, 2], 1);
    // Closest first: claim 1 is nearer claim 2 than claim 0 is.
    expect(pairs.map((p) => [p.a, p.b])).toEqual([[1, 2], [0, 2]]);
  });

  // Five nearer claims about the same subject must not crowd out the one that disagrees.
  it("pairs a claim with every claim about the same thing on other pages, however many are nearer", () => {
    const at = (deg: number) => Float32Array.from([Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)]);
    // X and Y 60 degrees apart; six others between them, each nearer to both than they are to each other.
    const degrees = [0, 60, 28, 29, 30, 31, 32, 33];
    const claims = degrees.map((_, i) => ({ id: `acme-sales/blue-widget/price-${i}`, page: `concepts/sheet-${i}.md` }));
    const vectors = degrees.map(at);
    const has = (pairs: Array<{ a: number; b: number }>) => pairs.some((p) => p.a === 0 && p.b === 1);
    // Unfiltered, k is the cap: the pair is crowded out (the contract the k=1 test above pins).
    expect(has(nearestPairs(claims, vectors, [0, 1], 5))).toBe(false);
    // Filtered to the same subject, every partner is kept — from either side's query.
    expect(has(nearestPairs(claims, vectors, [0, 1], 5, () => true))).toBe(true);
    expect(has(nearestPairs(claims, vectors, [0], 5, () => true))).toBe(true);
    expect(nearestPairs(claims, vectors, [0], 5, () => true)).toHaveLength(7);
    // Beyond the bound, the nearest SAME_SUBJECT_PARTNERS.
    const many = Array.from({ length: SAME_SUBJECT_PARTNERS + 10 }, (_, i) => ({ id: `acme-sales/blue-widget/p-${i}`, page: `concepts/s-${i}.md` }));
    const manyVectors = many.map((_, i) => at(i));
    expect(nearestPairs(many, manyVectors, [0], 5, () => true)).toHaveLength(SAME_SUBJECT_PARTNERS);
  });

  it("finds the same pairs in slices that yield as in one synchronous call, and stops on abort", async () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
    const claims = Array.from({ length: 40 }, (_, i) => ({ id: `a/c${i}/f`, page: `p${i % 9}` }));
    const vectors = claims.map(() => Float32Array.from({ length: 8 }, rnd));
    const queries = claims.map((_, i) => i);
    const once = nearestPairs(claims, vectors, queries, 3);
    expect(await nearestPairsYielding(claims, vectors, queries, 3, undefined, 4)).toEqual(once);
    const stop = new AbortController();
    stop.abort();
    expect(await nearestPairsYielding(claims, vectors, queries, 3, stop.signal, 4)).toEqual([]);
  });

  it("a failed ROLLBACK never hides the error that caused it", () => {
    const calls: string[] = [];
    const db = {
      exec(sql: string) {
        calls.push(sql);
        if (sql === "ROLLBACK") throw new Error("no transaction is active");
      },
    } as unknown as Parameters<typeof runInTransaction>[0];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() =>
      runInTransaction(db, () => {
        throw new Error("disk full");
      }),
    ).toThrow("disk full");
    expect(calls).toEqual(["BEGIN", "ROLLBACK"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    expect(runInTransaction(db, () => 3)).toBe(3);
    expect(calls.slice(2)).toEqual(["BEGIN", "COMMIT"]);
  });

  it("hashes a pair the same both ways round", () => {
    expect(pairHash("x", "y")).toBe(pairHash("y", "x"));
    expect(pairHash("x", "y")).not.toBe(pairHash("x", "z"));
    expect(pairHash("x", "y")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("reads the judge's answer, one verdict per pair", () => {
    const m = parseJudgeResponse(
      'Sure: [{"i":0,"verdict":"contradiction","why":"price differs"},{"i":0,"verdict":"compatible"},{"i":5,"verdict":"contradiction"},{"i":1,"verdict":"maybe"},{"i":2,"verdict":"unsure","why":"mail me at a@example.com"}]',
      3,
    );
    // Pair 0 was answered two ways, so it fails alone; 5 is out of range, "maybe" is no verdict.
    expect([...m.keys()]).toEqual([2]);
    expect(m.get(2)?.why).toContain("[REDACTED:EMAIL]");
    expect(() => parseJudgeResponse("no json", 2)).toThrow(JudgeParseError);
    // Only out-of-range indices (a one-pair batch numbered from 1) is no usable verdict.
    expect(() => parseJudgeResponse('[{"i":1,"verdict":"contradiction"}]', 1)).toThrow(JudgeParseError);
    const { user } = buildJudgePrompt([{ a: "x", b: "y" }]);
    expect(readJudgeItems(user)).toEqual([{ i: 0, a: "x", b: "y" }]);
  });

  it("the stub judge flags same subject, different figures", () => {
    expect(stubVerdict("The blue widget costs 10 EUR.", "The blue widget costs 12 EUR.")).toBe("contradiction");
    expect(stubVerdict("The blue widget costs 10 EUR.", "Shipping takes 3 days.")).toBe("compatible");
  });
});

describe("contradiction pass", () => {
  async function seedVault(pages: Record<string, string> = PAGES) {
    await vaultOperation("seed: pages", async (tx) => {
      for (const [p, t] of Object.entries(pages)) await tx.write(p, t);
    });
    return readVaultSnapshot();
  }

  it("finds a planted contradiction, raises one review item, and pays for nothing twice", async () => {
    const snap = await seedVault();
    const sent: string[] = [];
    const client = judge((a, b) => (/costs/.test(a) && /costs/.test(b) ? "contradiction" : "compatible"), (u) => sent.push(u));
    const embedder = createHashEmbedder();
    const embed = vi.spyOn(embedder, "embed");
    const r = await runContradictionPass(snap, { stateVault: vaultDir(), scope: null, client, embedder, rates: DEFAULT_COST_RATES, runId: "run-0000000000aa", k: 2 });
    expect(r.skipped).toBeNull();
    expect(r.findings).toHaveLength(1);
    expect([r.findings[0].a.id, r.findings[0].b.id].sort()).toEqual(["acme-sales/catalogue/blue-widget", "acme-sales/pricing/blue-widget"]);
    expect(r.reviewItems).toHaveLength(1);
    expect(r.reviewItems[0]).toMatchObject({ kind: "contradiction", runId: "run-0000000000aa" });
    expect(r.reviewItems[0].candidates).toHaveLength(2);
    expect(r.calls).toBe(1);
    expect(sent.join("\n")).not.toContain("help@example.com");
    const summary = readCostSummary(vaultDir(), DEFAULT_COST_RATES);
    expect(summary.byOperation.map((o) => o.operation)).toEqual(["contradiction-judge"]);
    // The embedder reports no usage: embeddings are said to be unmeasured, never summed as free.
    expect(summary.notMeasured).toEqual([{ operation: "embedding", reason: "no_usage_reported" }]);

    const again = await runContradictionPass(snap, { stateVault: vaultDir(), scope: null, client, embedder, rates: DEFAULT_COST_RATES, k: 2 });
    expect(again.embedded).toBe(0);
    expect(again.judged).toBe(0);
    expect(client.calls).toBe(1);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(again.findings).toHaveLength(1);
    // Still one waiting item for the same pair.
    expect(listReviewItems(vaultDir()).total).toBe(1);
  });

  it("judges a same-subject pair on two pages on a scoped night, though six nearer claims are about the subject too", async () => {
    // Every claim is about the blue widget's price; X's page is the one the night changed.
    const texts = [
      "The blue widget costs 10 EUR per unit.",
      "The blue widget costs 99 EUR per unit.",
      ...[11, 12, 13, 14, 15, 16].map((n) => `The blue widget costs ${n} EUR per unit.`),
    ];
    const titles = ["Price list", "Clearance flyer", "Catalogue", "Brochure", "Newsletter", "Quote", "Order form", "Trade offer"];
    const pages: Record<string, string> = {};
    texts.forEach((t, i) => {
      pages[`concepts/${titles[i].toLowerCase().replace(/ /g, "-")}.md`] = pageText({ title: titles[i], claims: [claim(`acme-sales/blue-widget/price-${i}`, t)] });
    });
    const snap = await seedVault(pages);
    // X and Y 60 degrees apart, the six others between them.
    const degrees = new Map(texts.map((t, i) => [t, [0, 60, 28, 29, 30, 31, 32, 33][i]]));
    const embedder: ClaimEmbedder = {
      identity: async () => "angles",
      embed: async (batch) => batch.map((t) => Float32Array.from([Math.cos(((degrees.get(t) ?? 90) * Math.PI) / 180), Math.sin(((degrees.get(t) ?? 90) * Math.PI) / 180)])),
    };
    const asked: Array<[string, string]> = [];
    const client = judge(
      (a, b) => {
        asked.push([a, b]);
        return "compatible";
      },
    );
    const r = await runContradictionPass(snap, { stateVault: vaultDir(), scope: ["concepts/price-list.md"], client, embedder, raiseItems: false });
    expect(r.queried).toBe(1);
    expect(asked.some(([a, b]) => [a, b].sort().join("|") === [texts[0], texts[1]].sort().join("|"))).toBe(true);
    expect(r.pairs).toBe(7);
  });

  it("queries only the claims in scope", async () => {
    const snap = await seedVault();
    const r = await runContradictionPass(snap, {
      stateVault: vaultDir(),
      scope: ["concepts/shipping.md"],
      client: judge(() => "compatible"),
      embedder: createHashEmbedder(),
      raiseItems: false,
    });
    expect(r.queried).toBe(1);
  });

  it("skips, never throws, when the embedder or the judge cannot answer", async () => {
    const snap = await seedVault();
    const broken: ClaimEmbedder = {
      identity: async () => "broken",
      embed: async () => {
        throw new Error("embed unit is down");
      },
    };
    const r = await runContradictionPass(snap, { stateVault: vaultDir(), scope: null, client: judge(() => "contradiction"), embedder: broken });
    expect(r.skipped).toBe("embedder_unavailable");
    expect(r.findings).toEqual([]);

    const refused: FlashClient = {
      model: "deepseek-v4-flash",
      complete: async () => {
        throw new FlashCallError("no_credential", "not signed in");
      },
    };
    const q = await runContradictionPass(snap, { stateVault: vaultDir(), scope: null, client: refused, embedder: createHashEmbedder() });
    expect(q.skipped).toBe("judge_unavailable");
    expect(q.findings).toEqual([]);
  });

  it("stops the judge at a spent ClawBox AI allowance, says when it frees up, and defers every pair it did not judge", async () => {
    const snap = await seedVault();
    let calls = 0;
    const spent: FlashClient = {
      model: "deepseek-v4-flash",
      complete: async () => {
        calls += 1;
        throw new FlashCallError("allowance", "ClawBox AI's 5-hour burst limit is reached.", 429, null, {
          kind: "burst",
          resetAt: "2026-05-20T08:00:00.000Z",
          message: "Short-term burst limit reached.",
        });
      },
    };
    const r = await runContradictionPass(snap, { stateVault: vaultDir(), scope: null, client: spent, embedder: createHashEmbedder(), parallel: 1, k: 8 });
    expect(r.skipped).toBe("allowance_spent");
    expect(r.allowance).toEqual({ kind: "burst", resetAt: "2026-05-20T08:00:00.000Z" });
    expect(r.notes.join(" ")).toMatch(/The judge stopped: ClawBox AI allowance spent, frees up at .+\. The pairs it did not judge are judged next pass\./);
    expect(calls).toBe(1);
    // Queued, not lost: nothing judged, every pair owed, and the pass is no full comparison.
    expect(r.judged).toBe(0);
    expect(r.deferredPairs).toBe(r.pairs);
    expect(r.deferredClaims).toBeGreaterThan(0);
    expect(r.complete).toBe(false);
  });

  it("stops at a spent memory-indexing allowance before the judge: its own reason, never a silent skip", async () => {
    const snap = await seedVault();
    let calls = 0;
    const judge: FlashClient = {
      model: "deepseek-v4-flash",
      complete: async () => {
        calls += 1;
        throw new Error("the judge must not be asked");
      },
    };
    // The shape memory-index-local's EmbeddingUnavailableError carries for an embeddings_weekly_limit_exceeded 429.
    const refused = Object.assign(new Error("The embedding model did not answer: HTTP 429"), {
      retryable: false,
      allowance: { kind: "embeddings", resetAt: "2026-05-25T00:00:00.000Z", message: "Memory indexing allowance used up." },
    });
    const embedder = { identity: async () => "spent-embedder", embed: async () => Promise.reject(refused) };
    const r = await runContradictionPass(snap, { stateVault: vaultDir(), scope: null, client: judge, embedder, parallel: 1 });
    expect(r.skipped).toBe("allowance_spent");
    expect(r.allowance).toEqual({ kind: "embeddings", resetAt: "2026-05-25T00:00:00.000Z" });
    expect(r.notes.join(" ")).toMatch(/The claims could not be embedded: ClawBox AI allowance spent, frees up at .+\. They are compared on the next pass\./);
    expect(r.deferredClaims).toBe(r.queried);
    expect(calls).toBe(0);
  });

  it("works with the deterministic stub model", async () => {
    const snap = await seedVault();
    const r = await runContradictionPass(snap, { stateVault: vaultDir(), scope: null, client: createStubFlashClient(), embedder: createHashEmbedder(), k: 3 });
    expect(r.findings.some((f) => f.verdict === "contradiction")).toBe(true);
  });
});

describe("pages the removed Opus tier left", () => {
  it("still parse and re-serialise byte for byte with `opus_pending` and `checked_by: opus`; a new page carries neither", () => {
    const fresh = pageText();
    const parsed = parsePage(fresh);
    expect(parsed.ok && "opus_pending" in parsed.frontmatter).toBe(false);
    expect(fresh).not.toMatch(/opus_pending/);
    // An older box wrote the flag between checked_by and claims: it stays there, untouched.
    const old = fresh.replace("checked_by: flash\n", "checked_by: opus\nopus_pending: true\n");
    expect(old).toMatch(/checked_by: opus\nopus_pending: true\nclaims:/);
    const reread = parsePage(old);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.frontmatter).toMatchObject({ checked_by: "opus", opus_pending: true });
    expect(serializePage(reread.frontmatter, reread.body)).toBe(old);
    // Whatever value it holds, it is no longer the contract's to judge.
    expect(parsePage(fresh.replace("checked_by: flash\n", "checked_by: flash\nopus_pending: maybe\n")).ok).toBe(true);
  });
});

describe("nightly schedule", () => {
  it("arms the next local HH:MM, tomorrow once today's has passed, and nothing when off", () => {
    const now = new Date(2026, 2, 10, 2, 30);
    expect(computeNextNightlyMs({ enabled: true, time: "03:00" }, now)).toBe(new Date(2026, 2, 10, 3, 0).getTime());
    expect(computeNextNightlyMs({ enabled: true, time: "02:00" }, now)).toBe(new Date(2026, 2, 11, 2, 0).getTime());
    expect(computeNextNightlyMs({ enabled: false, time: "03:00" }, now)).toBe(0);
    expect(computeNextNightlyMs({ enabled: true, time: "25:00" }, now)).toBe(0);
  });
});

describe("settings: the slice 3 sections", () => {
  it("defaults: nightly on at 03:00, contradictions on, no domains, no Opus section", () => {
    const s = readSettings();
    expect(s.nightly).toEqual({ enabled: true, time: "03:00" });
    expect("opus" in s).toBe(false);
    expect(s.contradictions).toEqual({ enabled: true });
    expect(s.domains).toEqual([]);
    expect(s.ingest.folders).toEqual([]);
  });

  it("writes and resets fields, and refuses a bad one whole", () => {
    const s = writeSettings({
      nightly: { time: "04:30" },
      contradictions: { enabled: false },
      domains: [{ name: "acme-sales", owner: "Sales team" }],
      ingest: { folders: ["/srv/docs", "/srv/docs/"] },
    });
    expect(s.nightly).toEqual({ enabled: true, time: "04:30" });
    expect(s.contradictions).toEqual({ enabled: false });
    expect(s.domains).toEqual([{ name: "acme-sales", owner: "Sales team" }]);
    expect(s.ingest.folders).toEqual(["/srv/docs"]);
    for (const bad of [
      { nightly: { time: "4:30" } },
      { contradictions: { enabled: "yes" } },
      { summaries: { capUsd: 5000 } },
      { domains: [{ name: "Acme Sales", owner: "x" }] },
      { domains: [{ name: "a", owner: "x" }, { name: "a", owner: "y" }] },
      { ingest: { folders: ["relative/path"] } },
    ]) {
      expect(() => writeSettings(bad as never)).toThrow(SettingsError);
    }
    expect(readSettings().nightly.time).toBe("04:30");
    expect(writeSettings({ contradictions: null }).contradictions.enabled).toBe(true);
    expect(writeSettings({ nightly: { time: null } }).nightly.time).toBe("03:00");
  });

  it("refuses unknown sections and keys in a patch", () => {
    expect(() => readSettingsPatch({ schedule: "x" })).toThrow(SettingsError);
    expect(() => readSettingsPatch({ nightly: { budget: 1 } })).toThrow(SettingsError);
    expect(() => readSettingsPatch([])).toThrow(SettingsError);
    // The removed Opus tier's section is no setting any more.
    expect(() => readSettingsPatch({ opus: { enabled: true } })).toThrow(/Unknown setting: opus/);
    expect(readSettingsPatch({ nightly: { enabled: true } })).toEqual({ nightly: { enabled: true } });
  });

  it("an older settings.json that still holds `opus` loads without error, and the next save drops it", () => {
    const file = path.join(process.env.PRIME_RADIANT_DIR!, "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = {
      nightly: { enabled: true, time: "02:15" },
      opus: { enabled: true, capUsd: 5, sampleRate: 0.5, model: "claude-opus-5-5", maxPages: 40 },
      contradictions: { enabled: false },
      domains: [{ name: "acme-sales", owner: "Sales team" }],
      laterSection: { kept: true },
    };
    fs.writeFileSync(file, JSON.stringify(old));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const s = readSettings();
      expect("opus" in s).toBe(false);
      expect(s.nightly).toEqual({ enabled: true, time: "02:15" });
      expect(s.contradictions).toEqual({ enabled: false });
      expect(s.domains).toEqual([{ name: "acme-sales", owner: "Sales team" }]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
    // Reading never rewrites the file.
    expect(JSON.parse(fs.readFileSync(file, "utf8")).opus).toEqual(old.opus);
    const saved = writeSettings({ nightly: { time: "04:00" } });
    expect(saved.nightly.time).toBe("04:00");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    expect("opus" in stored).toBe(false);
    // Every other section, one this ClawBox does not know included, is kept.
    expect(stored).toMatchObject({ contradictions: { enabled: false }, domains: old.domains, laterSection: { kept: true } });
  });
});
