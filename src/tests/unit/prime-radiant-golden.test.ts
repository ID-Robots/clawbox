/**
 * Golden questions: the store in the vault (one commit a change, never a
 * page), the answer from the wiki's claims, the judge's prompt and tolerant
 * reader, the nightly score with its history, its cap and its skips, and a
 * regression (correct → wrong) as a `lint` review item. A synthetic set over
 * synthetic pages; the model is a fake.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FlashCallError, type FlashClient } from "@/lib/prime-radiant/flash-client";
import { stubGoldenVerdict } from "@/lib/prime-radiant/flash-stub";
import { git } from "@/lib/prime-radiant/git";
import { revertCommit } from "@/lib/prime-radiant/history";
import {
  buildGoldenPrompt,
  GOLDEN_FILE,
  goldenEvidence,
  goldenMaxTokens,
  goldenRegressions,
  goldenTally,
  GoldenInputError,
  GoldenParseError,
  parseGoldenFile,
  parseGoldenResponse,
  readGoldenInput,
  readGoldenItems,
  serializeGoldenFile,
  type GoldenPage,
  type GoldenQuestion,
} from "@/lib/prime-radiant/golden";
import { goldenStatus, readGoldenHistory, readLatestVerdicts, runGoldenScore } from "@/lib/prime-radiant/golden-score";
import { addGoldenQuestion, deleteGoldenQuestion, GoldenError, readGoldenQuestions, safeGoldenId, updateGoldenQuestion } from "@/lib/prime-radiant/golden-store";
import { readCosts } from "@/lib/prime-radiant/ingest-store";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { listReviewItems } from "@/lib/prime-radiant/review-store";
import { ensureVault, readVaultSnapshot, vaultOperation } from "@/lib/prime-radiant/vault";
import { claim, frontmatter, pageText } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-golden-"));
const prev = process.env.PRIME_RADIANT_DIR;
let n = 0;
const NOW = new Date("2026-05-20T03:00:00.000Z");

beforeEach(() => {
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`, "prime-radiant");
});

afterAll(() => {
  if (prev === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prev;
  fs.rmSync(base, { recursive: true, force: true });
});

const PRICE = claim("acme-sales/blue-widget/price", "The blue widget costs 10 EUR per unit.");
const STOCK = claim("acme-sales/blue-widget/stock", "Globex keeps 400 blue widgets in stock.");
const OFFICE = claim("acme-ops/office/city", "The Acme office is in Plovdiv.");

async function seedPages(price = PRICE.text): Promise<void> {
  await ensureVault();
  await vaultOperation("test: seed", async (tx) => {
    await tx.write("concepts/blue-widget.md", pageText({ title: "Blue widget", claims: [{ ...PRICE, text: price }, STOCK] }));
    await tx.write("concepts/acme-office.md", pageText({ title: "Acme office", domain: "acme-ops", claims: [OFFICE] }));
  });
}

/** The judge: correct when a fact holds the expected answer's words, missing with no fact, else wrong — the stub's rule. */
function judge(calls: string[] = []): FlashClient {
  return {
    model: "deepseek-v4-flash",
    async complete(request) {
      calls.push(request.user);
      const items = readGoldenItems(request.user) ?? [];
      const text = JSON.stringify(items.map((g) => ({ i: g.i, verdict: stubGoldenVerdict(g.expected, g.facts), why: "fake judge" })));
      return { text, model: "deepseek-v4-flash", usage: { promptTokens: 200, completionTokens: 30, cacheHitTokens: 0 } };
    },
  };
}

const PRICE_Q = { question: "What does the blue widget cost?", expected: "10 EUR per unit", domain: "acme-sales" };
const OFFICE_Q = { question: "Which city is the Acme office in?", expected: "Plovdiv", domain: "acme-ops" };

describe("golden questions: input and file", () => {
  it("reads a question strictly and a patch by its fields", () => {
    expect(readGoldenInput({ ...PRICE_Q, owner: "  Sales  team ", page: "concepts/blue-widget" }, false)).toEqual({
      ...PRICE_Q,
      owner: "Sales team",
      page: "concepts/blue-widget.md",
    });
    expect(readGoldenInput({ expected: "12 EUR", owner: null }, true)).toEqual({ expected: "12 EUR", owner: null });
    for (const bad of [{}, { ...PRICE_Q, domain: "Acme Sales" }, { ...PRICE_Q, claimId: "not an id" }, { ...PRICE_Q, page: "../etc/passwd" }, { ...PRICE_Q, extra: 1 }, { ...PRICE_Q, question: "x".repeat(301) }]) {
      expect(() => readGoldenInput(bad, false)).toThrow(GoldenInputError);
    }
    expect(() => readGoldenInput({}, true)).toThrow(GoldenInputError);
    expect(() => readGoldenInput({ question: "" }, true)).toThrow(GoldenInputError);
  });

  it("round-trips the file deterministically and skips a garbled entry", () => {
    const q: GoldenQuestion = { id: "gq-0123456789ab", ...PRICE_Q, owner: "Sales team", claimId: null, page: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
    const text = serializeGoldenFile([q]);
    expect(serializeGoldenFile(parseGoldenFile(text).questions)).toBe(text);
    const mixed = JSON.stringify({ version: 1, questions: [q, { id: "bad" }, q] });
    expect(parseGoldenFile(mixed)).toEqual({ questions: [q], skipped: 2 });
    expect(parseGoldenFile("{not json")).toEqual({ questions: [], skipped: 1 });
    expect(parseGoldenFile(null)).toEqual({ questions: [], skipped: 0 });
    expect(safeGoldenId("gq-0123456789ab")).toBe("gq-0123456789ab");
    expect(safeGoldenId("gq-../x")).toBeNull();
  });
});

describe("golden questions: the answer from the wiki", () => {
  const pages: GoldenPage[] = [
    { path: "concepts/blue-widget.md", fm: frontmatter({ title: "Blue widget", claims: [PRICE, STOCK] }) },
    { path: "concepts/acme-office.md", fm: frontmatter({ title: "Acme office", claims: [OFFICE] }) },
    { path: "concepts/old.md", fm: frontmatter({ title: "Old blue widget price", status: "deprecated", claims: [claim("acme-sales/old/price", "The blue widget costs 8 EUR.")] }) },
  ];

  it("ranks the claims sharing the question's words, never a deprecated page's", () => {
    const ev = goldenEvidence("What does the blue widget cost?", pages, { now: NOW });
    expect(ev[0]).toMatchObject({ claimId: PRICE.id, page: "concepts/blue-widget.md", title: "Blue widget" });
    expect(ev.map((e) => e.claimId)).not.toContain("acme-sales/old/price");
    expect(goldenEvidence("zebra quantum", pages, { now: NOW })).toEqual([]);
  });

  it("puts the search's hits first: a claim hit as it is, a page hit by its best claims", () => {
    const ev = goldenEvidence("Which city?", pages, { now: NOW, hits: [{ kind: "claim", id: OFFICE.id, path: "concepts/acme-office.md" }] });
    expect(ev[0].claimId).toBe(OFFICE.id);
    const byPage = goldenEvidence("blue widget stock", pages, { now: NOW, hits: [{ kind: "page", id: "concepts/blue-widget.md", path: "concepts/blue-widget.md" }], k: 1 });
    expect(byPage).toHaveLength(1);
    expect(byPage[0].claimId).toBe(STOCK.id);
  });

  it("flags a dated fact: historical, a period that ended, a page past its re-check", () => {
    const dated: GoldenPage[] = [
      { path: "concepts/a.md", fm: frontmatter({ title: "Widget price", claims: [claim("acme-sales/a/price", "The widget price was 9 EUR.", { historical: true })] }) },
      { path: "concepts/b.md", fm: frontmatter({ title: "Widget price list", claims: [claim("acme-sales/b/price", "The widget price is 11 EUR.", { valid_until: "2026-01-31" })] }) },
      { path: "concepts/c.md", fm: frontmatter({ type: "metric", title: "Widget price metric", claims: [claim("acme-sales/c/price", "The widget price is 12 EUR.", { as_of: "2026-01-01" })] }) },
    ];
    const ev = goldenEvidence("widget price", dated, { now: NOW });
    expect(ev).toHaveLength(3);
    expect(ev.every((e) => e.dated)).toBe(true);
    expect(ev.find((e) => e.page === "concepts/c.md")?.asOf).toBe("2026-01-01");
  });
});

describe("golden questions: the judge", () => {
  it("builds one prompt for a batch, its facts flagged", () => {
    const { system, user } = buildGoldenPrompt([
      { question: "Q1", expected: "A1", evidence: [{ claimId: "x/y/z", text: "Fact", page: "concepts/p.md", title: "P", asOf: "2026-01-01", verified: true, dated: false }] },
      { question: "Q2", expected: "A2", evidence: [] },
    ]);
    expect(system).toContain("missing");
    const items = readGoldenItems(user);
    expect(items).toHaveLength(2);
    expect(items![0]).toMatchObject({ i: 0, question: "Q1", expected: "A1", facts: [{ n: 1, text: "Fact", page: "P", as_of: "2026-01-01", verified: true }] });
    expect(readGoldenItems("PAIRS (JSON): []")).toBeNull();
    expect(goldenMaxTokens(6)).toBe(640);
    expect(goldenMaxTokens(1000)).toBe(2048);
  });

  it("reads a verdict wherever it sits, leaves out a garbled or conflicting one, and throws only on none", () => {
    const answer = '```json\n[{"i":0,"verdict":"correct","why":"same"}, {"i":1,"verdict":"Stale"}, {"i":2,"verdict":"maybe"}, {"i":9,"verdict":"wrong"}, {"i":3,"verdict":"wrong"}, {"i":3,"verdict":"correct"}]\n```';
    const got = parseGoldenResponse(answer, 4);
    expect([...got.entries()]).toEqual([
      [0, { verdict: "correct", why: "same" }],
      [1, { verdict: "stale", why: "" }],
    ]);
    expect(() => parseGoldenResponse("I cannot say.", 2)).toThrow(GoldenParseError);
  });

  it("tallies the % correct of what was judged, and names correct → wrong only as a regression", () => {
    expect(goldenTally(["correct", "wrong", "missing", null, "correct"])).toEqual({ asked: 5, correct: 2, wrong: 1, missing: 1, stale: 0, failed: 1, percent: 50 });
    expect(goldenTally([null]).percent).toBeNull();
    const prev = new Map([["a", "correct"], ["b", "correct"], ["c", "wrong"], ["d", "missing"]] as const);
    const cur = new Map([["a", "wrong"], ["b", "missing"], ["c", "wrong"], ["d", "wrong"]] as const);
    expect(goldenRegressions(prev, cur)).toEqual(["a"]);
  });
});

describe("golden questions: the store in the vault", () => {
  it("adds, edits and deletes as one commit each, golden.json beside index.md — never a page", async () => {
    await seedPages();
    const added = await addGoldenQuestion(PRICE_Q, { domains: [{ name: "acme-sales", owner: "Sales team" }], now: NOW });
    expect(added.question).toMatchObject({ ...PRICE_Q, owner: "Sales team", claimId: null, page: null });
    expect(added.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.existsSync(path.join(vaultDir(), GOLDEN_FILE))).toBe(true);
    const log = (await git(vaultDir(), ["log", "-1", "--format=%s", "--name-only"])).stdout;
    expect(log).toContain("golden: add What does the blue widget cost?");
    expect(log).toContain(GOLDEN_FILE);
    expect((await readVaultSnapshot()).pages.map((p) => p.path)).not.toContain(GOLDEN_FILE);

    const id = added.question!.id;
    const edited = await updateGoldenQuestion(id, { expected: "10 EUR", claimId: PRICE.id }, { domains: [], now: new Date(NOW.getTime() + 1000) });
    expect(edited.question).toMatchObject({ expected: "10 EUR", claimId: PRICE.id, owner: "Sales team" });
    expect(edited.commit).not.toBeNull();
    expect((await updateGoldenQuestion(id, { expected: "10 EUR" }, { domains: [] })).commit).toBeNull();
    const cleared = await updateGoldenQuestion(id, { owner: null }, { domains: [{ name: "acme-sales", owner: "Pricing desk" }] });
    expect(cleared.question?.owner).toBe("Pricing desk");

    expect((await deleteGoldenQuestion(id)).commit).not.toBeNull();
    expect((await readGoldenQuestions()).questions).toEqual([]);
    await expect(deleteGoldenQuestion(id)).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(updateGoldenQuestion("gq-000000000000", { expected: "x" })).rejects.toBeInstanceOf(GoldenError);
  });

  it("is undone from History like any commit: the question comes back", async () => {
    await seedPages();
    const added = await addGoldenQuestion(PRICE_Q, { domains: [] });
    const gone = await deleteGoldenQuestion(added.question!.id);
    expect((await readGoldenQuestions()).questions).toEqual([]);
    const undo = await revertCommit({ sha: gone.commit! });
    expect(undo.commit).not.toBeNull();
    expect((await readGoldenQuestions()).questions.map((q) => q.id)).toEqual([added.question!.id]);
  });

  it("creates nothing without a vault, and refuses a write there", async () => {
    expect((await readGoldenQuestions()).questions).toEqual([]);
    await expect(addGoldenQuestion(PRICE_Q, { domains: [] })).rejects.toMatchObject({ code: "not_initialised", status: 412 });
    expect(fs.existsSync(vaultDir())).toBe(false);
    expect(await goldenStatus()).toEqual({ questions: 0, last: null, trend: [], change: null });
  });
});

describe("golden questions: the nightly score", () => {
  it("answers each question from the wiki, judges it, stores the score and records every call's cost", async () => {
    await seedPages();
    await addGoldenQuestion(PRICE_Q, { domains: [] });
    await addGoldenQuestion(OFFICE_Q, { domains: [] });
    await addGoldenQuestion({ question: "Who repairs zebra quantum drives?", expected: "Initech", domain: "acme-ops" }, { domains: [] });
    const calls: string[] = [];
    const r = await runGoldenScore({ runId: "run-0123456789ab", client: judge(calls), online: true, now: () => NOW });
    expect(r.skipped).toBeNull();
    expect(r.tally).toEqual({ asked: 3, correct: 2, wrong: 0, missing: 1, stale: 0, failed: 0, percent: 66.7 });
    expect(r.calls).toBe(1);
    expect(calls).toHaveLength(1);
    expect(readCosts(vaultDir(), "run-0123456789ab").map((c) => c.operation)).toEqual(["golden"]);
    const history = readGoldenHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: "run-0123456789ab", runId: "run-0123456789ab", asked: 3, correct: 2, percent: 66.7 });
    const verdicts = readLatestVerdicts();
    expect(Object.values(verdicts).map((v) => v.verdict).sort()).toEqual(["correct", "correct", "missing"]);
    expect((await goldenStatus()).last?.percent).toBe(66.7);
  });

  it("raises a lint review item when a question answered right turns wrong — never for one that was wrong already", async () => {
    await seedPages();
    await addGoldenQuestion(PRICE_Q, { domains: [] });
    await runGoldenScore({ runId: "run-00000000000a", client: judge(), online: true, now: () => NOW });
    // The price page changes: the wiki now answers 14 EUR.
    await vaultOperation("test: new price", async (tx) => {
      await tx.write("concepts/blue-widget.md", pageText({ title: "Blue widget", claims: [{ ...PRICE, text: "The blue widget costs 14 EUR per unit." }, STOCK] }));
    });
    const later = new Date(NOW.getTime() + 86_400_000);
    const r = await runGoldenScore({ runId: "run-00000000000b", client: judge(), online: true, now: () => later });
    expect(r.tally).toMatchObject({ correct: 0, wrong: 1, percent: 0 });
    expect(r.regressions).toHaveLength(1);
    expect(r.reviewItems).toHaveLength(1);
    const items = listReviewItems(vaultDir(), { status: "open" }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "lint", runId: null, pages: ["concepts/blue-widget.md"] });
    expect(items[0].candidates[0].text).toBe("10 EUR per unit");
    expect(items[0].evidence[0]).toMatchObject({ kind: "golden", verdict: "wrong" });
    // Still wrong the next night: the waiting item answers, no second one.
    const third = await runGoldenScore({ runId: "run-00000000000c", client: judge(), online: true, now: () => new Date(later.getTime() + 86_400_000) });
    expect(third.regressions).toEqual([]);
    expect(listReviewItems(vaultDir(), { status: "open" }).items).toHaveLength(1);
    const status = await goldenStatus();
    expect(status.trend.map((t) => t.percent)).toEqual([100, 0, 0]);
    expect(status.change).toBe(0);
  });

  it("asks at most the night's cap, the ones asked longest ago first, in batches", async () => {
    await seedPages();
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push((await addGoldenQuestion({ ...PRICE_Q, question: `What does the blue widget cost? (${i})` }, { domains: [] })).question!.id);
    const calls: string[] = [];
    const first = await runGoldenScore({ runId: "run-0000000000a1", client: judge(calls), online: true, maxQuestions: 7, now: () => NOW });
    expect(first.tally.asked).toBe(7);
    expect(first.capped).toBe(1);
    expect(calls).toHaveLength(2);
    const second = await runGoldenScore({ runId: "run-0000000000a2", client: judge(), online: true, maxQuestions: 1, now: () => new Date(NOW.getTime() + 1000) });
    expect(second.tally.asked).toBe(1);
    expect(Object.keys(readLatestVerdicts())).toHaveLength(8);
    expect(readGoldenHistory(vaultDir(), 1)[0].id).toBe("run-0000000000a2");
  });

  it("is skipped, writing nothing, with no questions, offline, or when the model refuses", async () => {
    await seedPages();
    expect((await runGoldenScore({ client: judge(), online: true })).skipped).toBe("no_questions");
    await addGoldenQuestion(PRICE_Q, { domains: [] });
    const calls: string[] = [];
    expect((await runGoldenScore({ client: judge(calls), online: false })).skipped).toBe("offline");
    expect(calls).toEqual([]);
    const refusing: FlashClient = {
      model: "deepseek-v4-flash",
      async complete() {
        throw new FlashCallError("no_credential", "not signed in");
      },
    };
    const r = await runGoldenScore({ client: refusing, online: true });
    expect(r.skipped).toBe("model_unavailable");
    expect(readGoldenHistory()).toEqual([]);
  });

  it("counts a question the judge left out as not judged, never as wrong", async () => {
    await seedPages();
    await addGoldenQuestion(PRICE_Q, { domains: [] });
    await addGoldenQuestion(OFFICE_Q, { domains: [] });
    const partial: FlashClient = {
      model: "deepseek-v4-flash",
      async complete() {
        return { text: '[{"i":0,"verdict":"correct"}]', model: "deepseek-v4-flash", usage: { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0 } };
      },
    };
    const r = await runGoldenScore({ client: partial, online: true });
    expect(r.tally).toMatchObject({ asked: 2, correct: 1, failed: 1, percent: 100 });
  });
});
