/**
 * The owner verification loop: who a page answers to, the daily questions'
 * order and caps, each owner's language, the re-check day by page type
 * (metrics 30 days, records never), the `as-of-missing` lint for metric
 * pages, and the settings — sending off by default, the languages strict.
 * Synthetic pages; the vault-backed part runs over a real git vault.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DAILY_LANGUAGES,
  DAILY_WORDING,
  dailyOwners,
  HUB_MIN_INBOUND,
  pageOwner,
  nextRecheck,
  pickDailyQuestions,
  type DailyInput,
  type DailyPage,
  type DailyReviewItem,
} from "@/lib/prime-radiant/daily";
import { readDailyQuestions } from "@/lib/prime-radiant/daily-questions";
import { lintVault, metricWithoutAsOf } from "@/lib/prime-radiant/lint";
import { lastChecked, RECHECK_DAYS, recheckDays, recheckOf, recheckPassed } from "@/lib/prime-radiant/recheck";
import { addReviewItem } from "@/lib/prime-radiant/review-store";
import { defaultSettings, readSettings, readSettingsPatch, SettingsError, writeSettings } from "@/lib/prime-radiant/settings";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { validateFrontmatter, type PageFrontmatter } from "@/lib/prime-radiant/schema";
import { ensureVault, vaultOperation } from "@/lib/prime-radiant/vault";
import { claim, frontmatter, pageText, snapshot } from "../helpers/prime-radiant-fixtures";

const NOW = new Date("2026-05-20T09:00:00.000Z");
const DOMAINS = [
  { name: "acme-sales", owner: "Иван Иванов" },
  { name: "acme-ops", owner: "Ops desk" },
];

function page(p: string, extra: Partial<PageFrontmatter> = {}, inbound = 0): DailyPage {
  return { path: p, fm: frontmatter({ generated: { at: "2026-05-15T10:00:00.000Z", by: "flash" }, ...extra }), inbound };
}

function item(id: string, pages: string[], createdAt: string, extra: Partial<DailyReviewItem> = {}): DailyReviewItem {
  return { id, kind: "contradiction", claimId: null, pages, candidates: [], createdAt, ...extra };
}

const verified = { at: "2026-05-01T10:00:00.000Z", by: "owner" };

describe("re-check day by page type", () => {
  it("follows the type from the last check: a metric 30 days, a record and a source never", () => {
    expect(RECHECK_DAYS.metric).toBe(30);
    const metric = frontmatter({ type: "metric", title: "Monthly widget sales", generated: { at: "2026-04-01T08:00:00.000Z", by: "flash" } });
    expect(recheckOf(metric)).toEqual({ date: "2026-05-01", by: "type", days: 30 });
    expect(recheckPassed(metric, NOW)).toBe(true);
    expect(recheckPassed(metric, new Date("2026-05-01T23:00:00.000Z"))).toBe(false);
    const invoice = frontmatter({ type: "reference", title: "Invoice 2026-0042 from Globex" });
    expect(recheckDays(invoice)).toBeNull();
    expect(recheckOf(invoice)).toEqual({ date: null, by: "type", days: null });
    expect(recheckDays(frontmatter({ type: "source" }))).toBeNull();
    expect(recheckDays(frontmatter({ type: "synthesis", hub: { kind: "invoices", month: "2026-04", leaves: 4 } }))).toBeNull();
  });

  it("restarts the clock on any verification on the page, and the page's own date wins", () => {
    const fm = frontmatter({ type: "metric", generated: { at: "2026-01-01T00:00:00.000Z", by: "flash" }, claims: [claim("acme-sales/w/sales", "Sold 40.", { verified })] });
    expect(lastChecked(fm)).toBe(Date.parse(verified.at));
    expect(recheckOf(fm).date).toBe("2026-05-31");
    expect(recheckOf({ ...fm, stale_after: "2027-01-01" })).toEqual({ date: "2027-01-01", by: "page", days: 30 });
  });

  it("counts a metric with an as_of of its own from that day, however recently it was written", () => {
    const fm = frontmatter({ type: "metric", title: "Widget stock", as_of: "2026-01-31", generated: { at: "2026-05-15T10:00:00.000Z", by: "flash" } });
    expect(lastChecked(fm)).toBe(Date.parse("2026-01-31T00:00:00.000Z"));
    expect(recheckOf(fm).date).toBe("2026-03-02");
    expect(recheckPassed(fm, NOW)).toBe(true);
    // A verification since restarts it; a concept's own as_of never pulls its clock back.
    expect(recheckOf({ ...fm, verified: { at: "2026-05-10T00:00:00.000Z", by: "owner" } }).date).toBe("2026-06-09");
    expect(lastChecked(frontmatter({ type: "concept", as_of: "2026-01-31", generated: { at: "2026-05-15T10:00:00.000Z", by: "flash" } }))).toBe(Date.parse("2026-05-15T10:00:00.000Z"));
    // A zoneless moment is read as UTC, as the pass reads it.
    expect(lastChecked(frontmatter({ type: "metric", as_of: "2026-01-31T12:00", generated: { at: "2026-05-15T10:00:00.000Z", by: "flash" } }))).toBe(Date.parse("2026-01-31T12:00:00.000Z"));
  });

  it("holds a page's own moment from that moment, a bare day through its end", () => {
    const fm = frontmatter({ type: "concept", stale_after: "2026-05-20T08:00:00.000Z" });
    expect(recheckPassed(fm, new Date("2026-05-20T07:59:00.000Z"))).toBe(false);
    expect(recheckPassed(fm, new Date("2026-05-20T08:01:00.000Z"))).toBe(true);
    expect(recheckPassed({ ...fm, stale_after: "2026-05-20" }, new Date("2026-05-20T23:00:00.000Z"))).toBe(false);
  });
});

describe("as-of-missing", () => {
  it("warns on a metric page with no as_of of its own and an undated claim — never on other types", () => {
    expect(metricWithoutAsOf(frontmatter({ type: "metric", claims: [claim("a/b/c")] }))).toBe(true);
    expect(metricWithoutAsOf(frontmatter({ type: "metric", claims: [] }))).toBe(true);
    expect(metricWithoutAsOf(frontmatter({ type: "metric", as_of: "2026-04-30", claims: [claim("a/b/c")] }))).toBe(false);
    expect(metricWithoutAsOf(frontmatter({ type: "metric", claims: [claim("a/b/c", "x", { as_of: "2026-04-30" }), claim("a/b/d", "y", { valid_from: "2026-04-01" })] }))).toBe(false);
    expect(metricWithoutAsOf(frontmatter({ type: "metric", as_of: "last month", claims: [claim("a/b/c")] }))).toBe(true);
    expect(metricWithoutAsOf(frontmatter({ type: "concept", claims: [claim("a/b/c")] }))).toBe(false);
    const report = lintVault(snapshot({ "concepts/sales.md": pageText({ type: "metric", title: "Widget sales", claims: [claim("acme-sales/widget/sales")] }) }), { now: NOW });
    const f = report.findings.find((x) => x.rule === "as-of-missing");
    expect(f).toMatchObject({ severity: "warning", blocksCommit: false, path: "concepts/sales.md", details: { claims: 1, undated: 1 } });
    // A page-level as_of that is no date is no error of the page: it still parses.
    expect(validateFrontmatter({ ...frontmatter({ type: "metric" }), as_of: "soon" }).ok).toBe(true);
  });

  it("is silenced in the lint by a page-level or per-claim as_of, and reads a zoneless moment as a date", () => {
    const rules = (text: string) => lintVault(snapshot({ "concepts/sales.md": text }), { now: NOW }).findings.map((x) => x.rule);
    expect(rules(pageText({ type: "metric", title: "Widget sales", as_of: "2026-04-30", claims: [claim("acme-sales/widget/sales")] }))).not.toContain("as-of-missing");
    expect(rules(pageText({ type: "metric", title: "Widget sales", claims: [claim("acme-sales/widget/sales", "Sold 40.", { as_of: "2026-04-30" })] }))).not.toContain("as-of-missing");
    expect(rules(pageText({ type: "metric", title: "Widget sales", as_of: "2026-04-30T09:00", claims: [claim("acme-sales/widget/sales")] }))).not.toContain("as-of-missing");
    expect(rules(pageText({ type: "concept", title: "Widget notes", claims: [claim("acme-sales/widget/notes")] }))).not.toContain("as-of-missing");
    expect(metricWithoutAsOf(frontmatter({ type: "metric", as_of: "2026-02-30", claims: [claim("a/b/c")] }))).toBe(true);
  });
});

describe("daily questions: who and in what order", () => {
  const pages: DailyPage[] = [
    page("concepts/sales-metric.md", { type: "metric", title: "Widget sales", domain: "acme-sales", claims: [claim("acme-sales/w/q1", "Q1 sales were 40."), claim("acme-sales/w/q2", "Q2 sales were 55.")] }, 1),
    page("concepts/pricing-decision.md", { type: "decision", title: "Pricing decision", domain: "acme-sales", claims: [claim("acme-sales/p/rule", "Prices rise 3% a year."), claim("acme-sales/p/done", "Decided in March.", { verified })] }, 2),
    page("entities/globex.md", { type: "entity", title: "Globex", domain: "acme-sales", claims: [claim("acme-sales/globex/hq", "Globex is in Sofia.")] }, HUB_MIN_INBOUND),
    page("concepts/plain.md", { type: "concept", title: "Plain notes", domain: "acme-sales", claims: [claim("acme-sales/plain/x", "Plain fact.")] }, 0),
    page("concepts/old-howto.md", { type: "howto", title: "Old howto", domain: "acme-sales", generated: { at: "2025-01-01T00:00:00.000Z", by: "flash" } }),
    page("concepts/ops.md", { type: "metric", title: "Ops metric", domain: "acme-ops", claims: [claim("acme-ops/m/x", "Uptime 99%.")] }),
    page("concepts/nobody.md", { type: "metric", title: "Orphan metric", domain: "acme-misc", owner: "unassigned", claims: [claim("acme-misc/m/x", "Value 1.")] }),
    page("concepts/gone.md", { type: "metric", title: "Gone metric", domain: "acme-sales", status: "deprecated", claims: [claim("acme-sales/gone/x", "Old.")] }),
  ];
  const items = [
    item("rev-000000000002", ["concepts/plain.md"], "2026-05-10T00:00:00.000Z", { candidates: [{ text: "10 EUR", page: "concepts/plain.md" }, { text: "12 EUR", page: "concepts/plain.md" }] }),
    item("rev-000000000001", ["concepts/sales-metric.md"], "2026-05-02T00:00:00.000Z", { claimId: "acme-sales/w/q1" }),
    item("rev-000000000003", ["concepts/ops.md"], "2026-05-01T00:00:00.000Z"),
  ];
  const input: DailyInput = { pages, reviewItems: items, domains: DOMAINS, now: NOW };

  it("names the domain's owner first, else the page's own; unassigned is nobody", () => {
    expect(pageOwner({ domain: "acme-sales", owner: "someone-else" }, DOMAINS)).toBe("Иван Иванов");
    expect(pageOwner({ domain: "acme-misc", owner: "Globex desk" }, DOMAINS)).toBe("Globex desk");
    expect(pageOwner({ domain: "acme-misc", owner: "unassigned" }, DOMAINS)).toBeNull();
    expect(dailyOwners(input).map((o) => o.owner)).toEqual(["Ops desk", "Иван Иванов"]);
  });

  it("asks review items first (oldest first), then unverified claims on hubs, metrics and decisions, then pages past re-check", () => {
    const qs = pickDailyQuestions(input, "Иван Иванов", { perOwner: 20 });
    expect(qs.map((q) => [q.kind, q.reviewId ?? q.claimId ?? q.page])).toEqual([
      ["review", "rev-000000000001"],
      ["review", "rev-000000000002"],
      // round one: one claim a page, most linked first — the review item's claim is not asked twice
      ["claim", "acme-sales/globex/hq"],
      ["claim", "acme-sales/p/rule"],
      ["claim", "acme-sales/w/q2"],
      // a page past its re-check (a howto 180 days after it was written)
      ["recheck", "concepts/old-howto.md"],
    ]);
    expect(qs[1].options).toEqual(["10 EUR", "12 EUR"]);
    expect(qs[2].answer).toEqual({ tool: "prime_radiant_claim_verify", args: { id: "acme-sales/globex/hq" } });
    expect(qs[0].answer).toEqual({ tool: "prime_radiant_review_resolve", args: { id: "rev-000000000001" } });
    // "Still current" sets the howto's 180 days from today: an answer page edit accepts, so the question can be closed.
    expect(qs[5]).toMatchObject({ due: "2025-06-30", answer: { tool: "prime_radiant_page_edit", args: { path: "concepts/old-howto.md", recheck_after: "2026-11-16" } } });
    // no claim of a plain concept page, a verified claim, a deprecated page or another owner's page
    const asked = qs.map((q) => q.claimId);
    for (const id of ["acme-sales/plain/x", "acme-sales/p/done", "acme-sales/gone/x", "acme-ops/m/x"]) expect(asked).not.toContain(id);
  });

  it("numbers a review item's options as the review list does, and answers one with no claim by fixing the page and dismissing it", () => {
    const five = ["A", "", "C", "D", "E"].map((text) => ({ text, page: "concepts/plain.md" }));
    const withClaim = item("rev-00000000000a", ["concepts/plain.md"], "2026-05-01T00:00:00.000Z", { claimId: "acme-sales/plain/x", candidates: five });
    const lint = item("rev-00000000000b", ["concepts/sales-metric.md"], "2026-05-02T00:00:00.000Z", { kind: "lint" });
    const qs = pickDailyQuestions({ ...input, reviewItems: [withClaim, lint] }, "Иван Иванов", { perOwner: 2 });
    expect(qs[0].options).toEqual(["A", "—", "C", "D"]);
    expect(qs[0].answer).toEqual({ tool: "prime_radiant_review_resolve", args: { id: "rev-00000000000a" } });
    expect(qs[1].question).toBe("A question about “Widget sales” is waiting for you.");
    expect(qs[1].answer).toEqual({
      tool: "prime_radiant_review_resolve",
      args: { id: "rev-00000000000b", action: "dismiss" },
      fixFirst: { tool: "prime_radiant_page_edit", args: { path: "concepts/sales-metric.md" } },
    });
  });

  it("is the same list all day, until something is answered", () => {
    const a = pickDailyQuestions(input, "Иван Иванов", { perOwner: 20 });
    const later = pickDailyQuestions({ ...input, now: new Date("2026-05-20T22:00:00.000Z"), pages: [...input.pages].reverse(), reviewItems: [...items].reverse() }, "Иван Иванов", { perOwner: 20 });
    expect(later).toEqual(a);
  });

  it("answers a page still current with its type's interval from today, a type never re-checked with by_type", () => {
    expect(nextRecheck(30, NOW)).toBe("2026-06-19");
    expect(nextRecheck(null, NOW)).toBe("by_type");
    // A record whose own date passed: the answer clears the date, and its type never asks again.
    const record = page("concepts/invoice-2026-0042.md", { type: "reference", title: "Invoice 2026-0042 from Globex", domain: "acme-sales", stale_after: "2026-05-01" });
    const qs = pickDailyQuestions({ ...input, pages: [record], reviewItems: [] }, "Иван Иванов");
    expect(qs).toHaveLength(1);
    expect(qs[0].answer).toEqual({ tool: "prime_radiant_page_edit", args: { path: "concepts/invoice-2026-0042.md", recheck_after: "by_type" } });
  });

  it("caps each owner at perOwner, five by default", () => {
    const many: DailyPage[] = Array.from({ length: 12 }, (_, i) => page(`concepts/m${i}.md`, { type: "metric", title: `Metric ${i}`, domain: "acme-sales", claims: [claim(`acme-sales/m${i}/x`, "Value.")] }));
    const big = { ...input, pages: many, reviewItems: [] };
    expect(pickDailyQuestions(big, "Иван Иванов")).toHaveLength(5);
    expect(pickDailyQuestions(big, "Иван Иванов", { perOwner: 2 })).toHaveLength(2);
    expect(pickDailyQuestions(big, "Иван Иванов", { perOwner: 99 })).toHaveLength(12);
    expect(pickDailyQuestions(input, "Ops desk", { perOwner: 1 })).toHaveLength(1);
    expect(pickDailyQuestions(input, "Nobody at all")).toEqual([]);
  });

  it("phrases each question short in the owner's language", () => {
    const bg = pickDailyQuestions(input, "Иван Иванов", { language: "bg", perOwner: 3 });
    expect(bg[0].question).toBe("Чака ви въпрос за „Widget sales“.");
    expect(bg[1].question).toBe("Кое е вярно за „Plain notes“?");
    expect(bg[2].question).toBe("Още ли е вярно? „Globex is in Sofia.“ (Globex)");
    expect(pickDailyQuestions(input, "Иван Иванов", { perOwner: 3 })[2].question).toBe("Still true? “Globex is in Sofia.” (Globex)");
    for (const lang of DAILY_LANGUAGES) {
      for (const text of Object.values(DAILY_WORDING[lang])) expect(text.length).toBeLessThan(90);
    }
  });
});

describe("daily questions: settings", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-daily-"));
  const prev = process.env.PRIME_RADIANT_DIR;
  let n = 0;
  beforeEach(() => {
    process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`, "prime-radiant");
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.PRIME_RADIANT_DIR;
    else process.env.PRIME_RADIANT_DIR = prev;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("sends nothing by default: outbound is off, five a day, English", () => {
    expect(defaultSettings().verification).toEqual({ perOwner: 5, outbound: false, languages: [] });
    expect(defaultSettings().golden).toEqual({ enabled: true, maxQuestions: 50 });
    expect(readSettings().verification.outbound).toBe(false);
  });

  it("stores each owner's language strictly, and refuses an unknown one or a duplicate", () => {
    const saved = writeSettings({ verification: { outbound: true, perOwner: 3, languages: [{ owner: "Иван Иванов", language: "bg" }] } });
    expect(saved.verification).toEqual({ perOwner: 3, outbound: true, languages: [{ owner: "Иван Иванов", language: "bg" }] });
    expect(() => writeSettings({ verification: { languages: [{ owner: "Ops desk", language: "klingon" }] } })).toThrow(SettingsError);
    expect(() => writeSettings({ verification: { languages: [{ owner: "A", language: "en" }, { owner: "a", language: "bg" }] } })).toThrow(SettingsError);
    expect(() => writeSettings({ verification: { perOwner: 0 } })).toThrow(SettingsError);
    expect(() => writeSettings({ golden: { maxQuestions: 501 } })).toThrow(SettingsError);
    expect(() => readSettingsPatch({ verification: { send: true } })).toThrow(SettingsError);
    expect(writeSettings({ verification: null }).verification.outbound).toBe(false);
  });

  it("reads today's questions from the vault without creating anything, each owner in their language", async () => {
    expect(await readDailyQuestions("Иван Иванов")).toMatchObject({ initialised: false, owners: [], questions: [], outbound: false });
    expect(fs.existsSync(vaultDir())).toBe(false);
    await ensureVault();
    writeSettings({ domains: DOMAINS, verification: { languages: [{ owner: "Иван Иванов", language: "bg" }] } });
    await vaultOperation("test: seed", async (tx) => {
      await tx.write("concepts/sales.md", pageText({ type: "metric", title: "Widget sales", domain: "acme-sales", as_of: "2026-05-01", claims: [claim("acme-sales/w/q1", "Q1 sales were 40.")] }));
      await tx.write("concepts/note.md", pageText({ type: "concept", title: "A note", domain: "acme-sales", claims: [claim("acme-sales/note/x", "A note.")] }));
    });
    addReviewItem(vaultDir(), { kind: "contradiction", pages: ["concepts/note.md"], candidates: [{ text: "A", page: "concepts/note.md", evidence: [] }, { text: "B", page: "concepts/note.md", evidence: [] }] });
    const all = await readDailyQuestions(null, { now: NOW });
    expect(all.owners).toEqual([{ owner: "Ops desk", domains: ["acme-ops"], pages: 0, language: "en", waiting: 0 }, { owner: "Иван Иванов", domains: ["acme-sales"], pages: 2, language: "bg", waiting: 2 }]);
    const mine = await readDailyQuestions("иван иванов", { now: NOW });
    expect(mine.owner).toBe("Иван Иванов");
    expect(mine.language).toBe("bg");
    expect(mine.questions.map((q) => q.kind)).toEqual(["review", "claim"]);
    expect(mine.questions[0].question).toBe("Кое е вярно за „A note“?");
  });

  it("finds an owner's oldest review item behind hundreds of newer ones", async () => {
    await ensureVault();
    writeSettings({ domains: DOMAINS });
    await vaultOperation("test: seed", async (tx) => {
      await tx.write("concepts/note.md", pageText({ type: "concept", title: "A note", domain: "acme-sales", claims: [claim("acme-sales/note/x", "A note.")] }));
      await tx.write("concepts/ops.md", pageText({ type: "concept", title: "Ops note", domain: "acme-ops", claims: [claim("acme-ops/note/x", "An ops note.")] }));
    });
    const oldest = addReviewItem(vaultDir(), { kind: "lint", pages: ["concepts/note.md"], dedupeKey: "test:oldest" }, "2026-01-01T00:00:00.000Z");
    // One page more than the review list answers at a time (200).
    for (let i = 0; i < 201; i++) {
      addReviewItem(vaultDir(), { kind: "lint", pages: ["concepts/ops.md"], dedupeKey: `test:ops-${i}` }, new Date(Date.UTC(2026, 3, 1) + i * 60_000).toISOString());
    }
    const mine = await readDailyQuestions("Иван Иванов", { now: NOW });
    expect(mine.questions[0]).toMatchObject({ kind: "review", reviewId: oldest.item.id });
  }, 60_000);
});
