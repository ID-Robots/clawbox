/**
 * One claim per fact, and one review item per question: the same fact filed
 * twice on a page (a repeated fact in a draft, a second copy of a document
 * brought in by a merge) folded into one claim with both sources; the vault's
 * one-shot repair; the contradiction item keyed on the facts, not their ids;
 * long dedupe keys; a dismissal that holds; a reason kept; a deleted claim's
 * items closed. Every name in the fixtures is invented.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { foldDuplicateClaimsInVault } from "@/lib/prime-radiant/claim-folds";
import { buildClaimIndex, claimTextKey, foldDuplicateClaims } from "@/lib/prime-radiant/claims";
import { contradictionKey, createHashEmbedder, runContradictionPass } from "@/lib/prime-radiant/contradictions";
import { deleteClaim, mergePages, type EditWho } from "@/lib/prime-radiant/edit";
import type { FlashClient } from "@/lib/prime-radiant/flash-client";
import { git } from "@/lib/prime-radiant/git";
import { revertCommit } from "@/lib/prime-radiant/history";
import { readJudgeItems } from "@/lib/prime-radiant/judge";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { readResolveAction, resolveReviewItem, ReviewError } from "@/lib/prime-radiant/review";
import { addReviewItem, getReviewItem, listReviewItems, settleReviewItem, storedDedupeKey } from "@/lib/prime-radiant/review-store";
import type { Claim } from "@/lib/prime-radiant/schema";
import { withStateDb } from "@/lib/prime-radiant/state-db";
import { ensureVault, readPage, vaultOperation } from "@/lib/prime-radiant/vault";
import { buildPage, type BuildContext, type PageDraft } from "@/lib/prime-radiant/writer";
import { claim, pageText, snapshot } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-claim-dupes-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;
let vault = "";

beforeEach(async () => {
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
  vault = vaultDir();
  await ensureVault();
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

const OWNER: EditWho = { by: "owner", person: true };
const NOW = new Date("2026-03-01T12:00:00.000Z");
const AT = NOW.toISOString();
const STAMP = { at: "2026-02-01T00:00:00.000Z", by: "owner" };

const TOTAL = "Invoice INV-7 from Globex totals €120.";
const original = (id: string, extra: Partial<Claim> = {}) =>
  claim(id, TOTAL, { confidence: 0.7, evidence: [{ kind: "source", path: "inbox/INV-7.pdf", note: "Total €120" }], ...extra });
const copy = (id: string, extra: Partial<Claim> = {}) =>
  claim(id, " invoice INV-7 from Globex  totals €120", { confidence: 0.9, evidence: [{ kind: "source", path: "inbox/_dup_INV-7.pdf", note: "TOTAL: €120" }], ...extra });

async function seed(pages: Record<string, string>): Promise<void> {
  await vaultOperation("seed: pages", async (tx) => {
    for (const [p, text] of Object.entries(pages)) await tx.write(p, text);
  });
}

async function claimsOf(rel: string): Promise<Claim[]> {
  const page = await readPage(rel);
  if (!page || !page.parsed.ok) throw new Error(`no page ${rel}`);
  return page.parsed.frontmatter.claims;
}

describe("one claim per fact", () => {
  it("folds same-worded claims for the same dates: the first kept, the copies' sources joined, the higher confidence — never a verified one", () => {
    const a = original("acme-sales/inv-7/total");
    const b = copy("acme-sales/inv-7/total-2");
    const otherDay = claim("acme-sales/inv-7/total-3", TOTAL, { as_of: "2026-01-01" });
    const verified = claim("acme-sales/inv-7/total-4", TOTAL, { status: "verified", verified: STAMP });
    const r = foldDuplicateClaims([a, b, otherDay, verified], AT);
    expect(r.folded).toEqual([{ id: b.id, into: a.id }]);
    expect(r.claims.map((c) => c.id)).toEqual([a.id, otherDay.id, verified.id]);
    // The kept claim's own text and quote stay; the copy's source joins its evidence.
    expect(r.claims[0]).toEqual({ ...a, confidence: 0.9, updatedAt: AT, evidence: [a.evidence[0], b.evidence[0]] });
    expect(foldDuplicateClaims(r.claims).folded).toEqual([]);
    expect(claimTextKey("  Invoice INV-7 from Globex totals €120. ")).toBe(claimTextKey("invoice inv-7 from globex totals €120"));
  });

  it("writes a fact a draft repeats once: no -2 id, the higher confidence, one line in Key facts", () => {
    const draft: PageDraft = {
      i: 0,
      useful: true,
      type: "entity",
      title: "Globex",
      domain: "sales",
      summary: "Globex is a synthetic supplier.",
      details: "",
      facts: [
        { fact: TOTAL, quote: "Total €120", confidence: 0.6 },
        { fact: "Globex ships from Rotterdam.", quote: "ships from Rotterdam", confidence: 0.8 },
        { fact: ` ${TOTAL.toLowerCase()} `, quote: "TOTAL: €120", confidence: 0.9 },
      ],
      privacy: "internal",
      confidence: 0.8,
    };
    const ctx: BuildContext = { takenPaths: new Set(), pagesBySource: new Map(), claimIndex: buildClaimIndex([]), now: NOW };
    const built = buildPage(draft, "inbox/INV-7.pdf", ctx);
    if (!built.ok) throw new Error("not built");
    expect(built.frontmatter.claims.map((c) => [c.id, c.text, c.confidence])).toEqual([
      ["sales/globex/invoice-inv-7-from-globex-totals-120", TOTAL, 0.9],
      ["sales/globex/globex-ships-from-rotterdam", "Globex ships from Rotterdam.", 0.8],
    ]);
    expect(built.body.split("\n").filter((l) => l.toLowerCase().includes("totals"))).toEqual([`- ${TOTAL}`]);
  });

  it("a merge folds the second copy of a document's claim into the first, keeping its source, and closes the copy's items", async () => {
    const a = original("acme-sales/globex/inv-7-total");
    const b = copy("acme-sales/globex-2/inv-7-total");
    const ships = claim("acme-sales/globex-2/ships-from", "Globex ships from Rotterdam.");
    await seed({
      "entities/globex.md": pageText({ type: "entity", title: "Globex", claims: [a], sources: ["inbox/INV-7.pdf"] }, "Globex supplies widgets.\n"),
      "entities/globex-2.md": pageText({ type: "entity", title: "Globex (copy)", claims: [b, ships], sources: ["inbox/_dup_INV-7.pdf"] }, "Globex supplies widgets.\n"),
    });
    const item = addReviewItem(vault, { kind: "lint", claimId: b.id, pages: ["entities/globex-2.md"] }).item;
    const r = await mergePages({ into: "entities/globex.md", from: ["entities/globex-2.md"], dryRun: false, keepIntoBody: true }, OWNER, { now: NOW });
    expect(r.folded).toEqual([{ id: b.id, into: a.id }]);
    expect(r.claims).toEqual([ships.id]);
    const claims = await claimsOf("entities/globex.md");
    expect(claims.map((c) => c.id)).toEqual([a.id, ships.id]);
    expect(claims[0]).toMatchObject({ text: TOTAL, confidence: 0.9 });
    expect(claims[0].evidence.map((e) => e.path)).toEqual(["inbox/INV-7.pdf", "inbox/_dup_INV-7.pdf"]);
    expect(getReviewItem(vault, item.id)).toMatchObject({ status: "resolved", resolution: { action: "dismiss", removed: [b.id], note: `claim folded into ${a.id}` } });
  });

  it("folds an existing vault in undoable commits, idempotently, leaving a page verified as a whole", async () => {
    const a = original("acme-sales/globex/inv-7-total");
    const b = copy("acme-sales/globex/inv-7-total-2");
    await seed({
      "entities/globex.md": pageText({ type: "entity", title: "Globex", claims: [a, b] }, "Globex supplies widgets.\n"),
      "entities/initech.md": pageText(
        { type: "entity", title: "Initech", verified: STAMP, claims: [original("acme-sales/initech/inv-7-total"), copy("acme-sales/initech/inv-7-total-2")] },
        "Initech buys widgets.\n",
      ),
      // A verified claim beside an unverified copy: the owner's to settle.
      "entities/umbrella.md": pageText(
        { type: "entity", title: "Umbrella", claims: [original("acme-sales/umbrella/inv-7-total", { status: "verified", verified: STAMP }), copy("acme-sales/umbrella/inv-7-total-2")] },
        "Umbrella buys widgets.\n",
      ),
    });
    const head = async () => (await git(vault, ["rev-parse", "HEAD"])).stdout.trim();
    const before = await head();
    const dry = await foldDuplicateClaimsInVault({ dryRun: true, now: NOW });
    expect(dry).toEqual({ dryRun: true, commits: [], pages: ["entities/globex.md"], folds: [{ page: "entities/globex.md", id: b.id, into: a.id }], skipped: ["entities/initech.md"] });
    expect(await head()).toBe(before);

    const r = await foldDuplicateClaimsInVault({ now: NOW });
    expect(r.commits).toHaveLength(1);
    expect(r.folds).toEqual(dry.folds);
    expect((await git(vault, ["log", "-1", "--format=%s"])).stdout.trim()).toBe("claims: fold 1 duplicate claim on 1 page");
    const claims = await claimsOf("entities/globex.md");
    expect(claims).toHaveLength(1);
    expect(claims[0].evidence.map((e) => e.path)).toEqual(["inbox/INV-7.pdf", "inbox/_dup_INV-7.pdf"]);
    expect(await claimsOf("entities/umbrella.md")).toHaveLength(2);

    // Idempotent: nothing left to fold, nothing written.
    const again = await foldDuplicateClaimsInVault({ now: NOW });
    expect(again).toMatchObject({ commits: [], folds: [] });
    expect(await head()).toBe(r.commits[0]);

    // Undo brings the copy back (it was removed, not retired).
    expect((await revertCommit({ sha: r.commits[0] })).commit).not.toBeNull();
    expect((await claimsOf("entities/globex.md")).map((c) => c.id)).toEqual([a.id, b.id]);
  });
});

describe("one review item per question", () => {
  const INVOICE = "concepts/invoice-inv-2026-0042-fabrikam.md";
  const REMINDER = "concepts/payment-reminder-fabrikam.md";
  const WRITTEN = "2026-10-16T08:00:00.000Z";
  const c = (id: string, text: string, extra: Partial<Claim> = {}) => claim(id, text, { updatedAt: WRITTEN, ...extra });
  const pages = (reminder: string) => ({
    // The invoice's total filed twice: the invoice and a second copy of it.
    [INVOICE]: pageText({
      title: "Invoice INV-2026-0042 Fabrikam",
      claims: [
        c("finance/invoice-inv-2026-0042-fabrikam/total", "The total due on invoice INV-2026-0042 is €1,200.00."),
        c("finance/invoice-inv-2026-0042-fabrikam/total-2", "The total due on invoice INV-2026-0042 is €1,200.00.", { evidence: [{ kind: "source", path: "inbox/_dup_INV-2026-0042.pdf" }] }),
      ],
    }),
    [REMINDER]: pageText({ title: "Payment reminder to Fabrikam", claims: [c("finance/payment-reminder-fabrikam/total", reminder)] }),
  });
  const judge: FlashClient = {
    model: "deepseek-v4-flash",
    async complete(request) {
      const items = readJudgeItems(request.user) ?? [];
      const text = JSON.stringify(items.map((it) => ({ i: it.i, verdict: it.a === it.b ? "compatible" : "contradiction", why: "totals differ" })));
      return { text, model: "deepseek-v4-flash", usage: { promptTokens: 100, completionTokens: 10, cacheHitTokens: 0 } };
    },
  };
  const pass = (reminder: string) =>
    runContradictionPass(snapshot(pages(reminder)), {
      stateVault: vault,
      scope: null,
      client: judge,
      embedder: createHashEmbedder(),
      retry: { attempts: 1, sleep: async () => undefined },
      now: () => new Date(WRITTEN),
    });

  it("raises one item for the same text under two ids, and never again once the owner dismissed it — until a text changes", async () => {
    const first = await pass("The total due on invoice INV-2026-0042 is €1,250.00.");
    expect(first.findings).toHaveLength(2);
    expect(listReviewItems(vault).items).toHaveLength(1);
    const [item] = listReviewItems(vault).items;
    await resolveReviewItem(item.id, { action: "dismiss", reason: "the reminder adds a late fee" }, { by: "owner" });
    expect(getReviewItem(vault, item.id)?.resolution).toMatchObject({ action: "dismiss", by: "owner", note: "the reminder adds a late fee" });

    // The next pass judges the same pairs from its cache: the dismissal holds.
    const second = await pass("The total due on invoice INV-2026-0042 is €1,250.00.");
    expect(second.reviewItems).toEqual([]);
    expect(listReviewItems(vault).total).toBe(0);

    // A side whose text changed is a new question.
    const third = await pass("The total due on invoice INV-2026-0042 is €1,300.00.");
    expect(third.reviewItems).toHaveLength(1);
    expect(listReviewItems(vault).total).toBe(1);
  });

  it("keys a contradiction on the sides' pages and texts, in either order", () => {
    const a = { page: INVOICE, text: "Total is €1,200.00." };
    const b = { page: REMINDER, text: "Total is €1,250.00." };
    expect(contradictionKey(a, b)).toBe(contradictionKey(b, a));
    expect(contradictionKey(a, b)).toBe(contradictionKey({ ...a, text: " total is €1,200.00 " }, b));
    expect(contradictionKey(a, b)).not.toBe(contradictionKey({ ...a, page: "concepts/other.md" }, b));
  });

  it("stores a key past 200 characters as its hash: two keys that begin alike are two questions", () => {
    const long = `contradiction:${"x".repeat(250)}`;
    const one = addReviewItem(vault, { kind: "contradiction", dedupeKey: `${long}|a` });
    const two = addReviewItem(vault, { kind: "contradiction", dedupeKey: `${long}|b` });
    expect([one.created, two.created]).toEqual([true, true]);
    expect(addReviewItem(vault, { kind: "contradiction", dedupeKey: `${long}|a` })).toMatchObject({ created: false, item: { id: one.item.id } });
    const keys = withStateDb(vault, (db) => (db.prepare("SELECT dedupe_key FROM review_items ORDER BY created_at, id").all() as Array<{ dedupe_key: string }>).map((r) => r.dedupe_key));
    expect(keys.every((k) => /^sha256:[0-9a-f]{64}$/.test(k))).toBe(true);
    expect(storedDedupeKey("lint:main:rule:concepts/a.md")).toBe("lint:main:rule:concepts/a.md");
  });

  it("answers with the item waiting under a key used before, and lets a pass's or a removal's close raise it again", () => {
    const old = addReviewItem(vault, { kind: "contradiction", dedupeKey: "contradiction:x/y/a|x/y/b" }).item;
    expect(addReviewItem(vault, { kind: "contradiction", dedupeKey: "new-key", legacyKeys: ["contradiction:x/y/a|x/y/b"] })).toMatchObject({ created: false, item: { id: old.id } });

    const candidates = [{ text: "A is 1.", page: null, evidence: [] }, { text: "A is 2.", page: null, evidence: [] }];
    const raise = () => addReviewItem(vault, { kind: "contradiction", dedupeKey: "k-dismiss", candidates, keepDismissed: true });
    const item = raise().item;
    settleReviewItem(vault, item.id, "resolved", { action: "dismiss", by: "auto", note: "different subjects" });
    const after = raise();
    expect(after.created).toBe(true);
    settleReviewItem(vault, after.item.id, "resolved", { action: "dismiss", by: "owner", removed: ["x/y/a"] });
    expect(raise().created).toBe(true);
  });

  it("reads a reason with any action, strictly", () => {
    expect(readResolveAction({ action: "dismiss", reason: "  Not  the same\ninvoice " })).toEqual({ action: "dismiss", reason: "Not the same invoice" });
    expect(readResolveAction({ action: "later", reason: "" })).toEqual({ action: "later" });
    expect(readResolveAction({ action: "pick", candidate: 0, reason: "x".repeat(600) }).reason).toHaveLength(500);
    expect(() => readResolveAction({ action: "dismiss", reason: 7 })).toThrow(ReviewError);
  });

  it("closes the items still waiting on a deleted claim as claim removed — a contradiction of either side — and no other", async () => {
    const gone = claim("acme-sales/globex/inv-7-total", TOTAL);
    const kept = claim("acme-sales/initech/inv-7-total", "Invoice INV-7 from Globex totals €150.");
    await seed({
      "entities/globex.md": pageText({ type: "entity", title: "Globex", claims: [gone] }, "Globex supplies widgets.\n"),
      "entities/initech.md": pageText({ type: "entity", title: "Initech", claims: [kept] }, "Initech buys widgets.\n"),
    });
    const side = (x: Claim, page: string) => ({ text: x.text, page, claimId: x.id, evidence: [] });
    const pair = addReviewItem(vault, { kind: "contradiction", claimId: kept.id, candidates: [side(kept, "entities/initech.md"), side(gone, "entities/globex.md")] }).item;
    const own = addReviewItem(vault, { kind: "lint", claimId: gone.id }).item;
    const other = addReviewItem(vault, { kind: "opus", claimId: kept.id, candidates: [side(gone, "entities/globex.md")] }).item;
    const r = await deleteClaim(gone.id, null, OWNER, { now: NOW });
    expect(r.commit).not.toBeNull();
    for (const id of [pair.id, own.id]) {
      expect(getReviewItem(vault, id)).toMatchObject({ status: "resolved", resolution: { action: "dismiss", by: "owner", note: "claim removed", removed: [gone.id] } });
    }
    expect(getReviewItem(vault, other.id)?.status).toBe("open");
  });
});
