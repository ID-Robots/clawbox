/**
 * The review queue, verification, the verified gate and history/revert, over a
 * REAL git vault in a tmp dir. Every name in the fixtures is invented.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { git, headCommit, logForPath, showFileAt } from "@/lib/prime-radiant/git";
import { gateIgnores, judgeTouch, verifiedTouches } from "@/lib/prime-radiant/gate";
import { HistoryError, pageHistory, revertCommit, safeCommitId, vaultDiff } from "@/lib/prime-radiant/history";
import { stateDbPath, vaultDir } from "@/lib/prime-radiant/paths";
import { setVaultReindexHook } from "@/lib/prime-radiant/reindex-hook";
import { readResolveAction, resolveReviewItem, createReviewItem, ReviewError } from "@/lib/prime-radiant/review";
import {
  addReviewItem,
  cleanCandidates,
  countWaitingForRuns,
  getReviewItem,
  listReviewItems,
  safeReviewId,
  settleReviewItem,
} from "@/lib/prime-radiant/review-store";
import { readRetiredLedger } from "@/lib/prime-radiant/state-db";
import { cleanVerifiedText, verifyClaim, VerifyError } from "@/lib/prime-radiant/verify";
import { ensureVault, readPage, vaultOperation, VaultLintBlockedError } from "@/lib/prime-radiant/vault";
import { claim, pageText } from "../helpers/prime-radiant-fixtures";

/** A synthetic token shape, built so no literal credential sits in the file. */
const FAKE_TOKEN = "ghp" + "_" + "Ab3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-review-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;
let vault = "";

const INDEX = "# Index\n\n- [[concepts/pricing]]\n- [[concepts/shipping]]\n";

async function seed(pages: Record<string, string>, message = "seed: pages"): Promise<void> {
  await vaultOperation(message, async (tx) => {
    for (const [p, text] of Object.entries(pages)) await tx.write(p, text);
    await tx.write("index.md", INDEX);
  });
}

beforeEach(async () => {
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
  vault = vaultDir();
  await ensureVault();
});

afterEach(() => setVaultReindexHook(null));

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

const PRICE_A = claim("acme-sales/widget-pricing/blue-price", "A blue widget costs 10 EUR.");
const PRICE_B = claim("acme-sales/widget-catalogue/blue-price", "A blue widget costs 12 EUR.");

describe("review store", () => {
  it("rebuilds ids from the alphabet", () => {
    expect(safeReviewId("rev-0123456789ab")).toBe("rev-0123456789ab");
    for (const bad of ["rev-0123456789aB", "rev-../../etc/pa", "rev-123", 42, null]) expect(safeReviewId(bad)).toBeNull();
  });

  it("cleans candidates strictly", () => {
    const c = cleanCandidates([
      { text: "  A blue widget\ncosts 10 EUR. ", page: "concepts/pricing.md", claimId: "acme-sales/widget-pricing/blue-price", evidence: [{ kind: "claim" }, { note: "no kind" }] },
      { text: "" },
      { text: "x", page: "../../etc/passwd", claimId: "Not An Id" },
      "nope",
    ]);
    expect(c).toEqual([
      { text: "A blue widget costs 10 EUR.", page: "concepts/pricing.md", claimId: "acme-sales/widget-pricing/blue-price", evidence: [{ kind: "claim" }] },
      { text: "x", page: null, evidence: [] },
    ]);
  });

  it("never creates the database on a read, dedupes an open question and counts by status", () => {
    expect(listReviewItems(vault)).toEqual({ total: 0, counts: { open: 0, resolved: 0, later: 0 }, items: [] });
    expect(fs.existsSync(stateDbPath())).toBe(false);
    const first = addReviewItem(vault, { kind: "contradiction", claimId: PRICE_A.id, dedupeKey: "k1", runId: "run-000000000001" });
    const again = addReviewItem(vault, { kind: "contradiction", claimId: PRICE_A.id, dedupeKey: "k1" });
    expect(first.created).toBe(true);
    expect(again).toEqual({ item: first.item, created: false });
    expect(countWaitingForRuns(vault, ["run-000000000001"])).toBe(1);
    expect(settleReviewItem(vault, first.item.id, "later", { action: "later", by: "owner" })).toBe(true);
    // Put off is still waiting: the same question does not open a second item.
    expect(addReviewItem(vault, { kind: "contradiction", dedupeKey: "k1" }).created).toBe(false);
    expect(settleReviewItem(vault, first.item.id, "resolved", { action: "dismiss", by: "owner" })).toBe(true);
    expect(settleReviewItem(vault, first.item.id, "resolved", { action: "dismiss", by: "owner" })).toBe(false);
    expect(addReviewItem(vault, { kind: "contradiction", dedupeKey: "k1" }).created).toBe(true);
    const list = listReviewItems(vault, { status: "all" });
    expect(list.total).toBe(2);
    expect(list.counts).toEqual({ open: 1, resolved: 1, later: 0 });
    expect(countWaitingForRuns(vault, ["run-000000000001"])).toBe(0);
  });

  it("reads a hand-raised item strictly", () => {
    expect(() => createReviewItem({ kind: "nonsense", claimId: PRICE_A.id }, { by: "owner" })).toThrow(ReviewError);
    expect(() => createReviewItem({ claimId: "Bad Id" }, { by: "owner" })).toThrow(ReviewError);
    expect(() => createReviewItem({}, { by: "owner" })).toThrow(ReviewError);
    const { item } = createReviewItem({ claimId: PRICE_A.id, note: "Sales says 11 EUR" }, { by: "assistant" });
    expect(item).toMatchObject({ kind: "contradiction", claimId: PRICE_A.id, evidence: [{ kind: "raised-by", source: "assistant", note: "Sales says 11 EUR" }] });
  });

  it("reads a resolve action strictly", () => {
    expect(readResolveAction({ action: "pick", candidate: 1 })).toEqual({ action: "pick", candidate: 1 });
    expect(readResolveAction({ action: "new", text: " 11 EUR " })).toEqual({ action: "new", text: "11 EUR", page: null });
    for (const bad of [{}, { action: "pick" }, { action: "pick", candidate: -1 }, { action: "new", text: "" }, { action: "new", text: "x".repeat(241) }, { action: "merge" }]) {
      expect(() => readResolveAction(bad)).toThrow(ReviewError);
    }
  });
});

describe("verify", () => {
  it("replaces the claim, retires the losing ids everywhere, in one commit", async () => {
    const other = claim("acme-sales/widget-pricing/red-price", "A red widget costs 9 EUR.");
    await seed({
      "concepts/pricing.md": pageText({ claims: [PRICE_A, other] }),
      "concepts/shipping.md": pageText({ title: "Catalogue", claims: [PRICE_B] }),
    });
    const before = (await logForPath(vault, "concepts/pricing.md")).length;
    const r = await verifyClaim({ claimId: PRICE_A.id, text: "A blue widget costs 11 EUR.", by: "owner", retire: [PRICE_B.id, "acme-sales/old/never-seen"] });
    expect(r).toMatchObject({ claimId: PRICE_A.id, page: "concepts/pricing.md", retired: [PRICE_B.id, "acme-sales/old/never-seen"] });
    expect(r.changed).toEqual(["concepts/pricing.md", "concepts/shipping.md"]);
    expect((await headCommit(vault))?.subject).toBe(`verify: ${PRICE_A.id}`);
    expect((await logForPath(vault, "concepts/pricing.md")).length).toBe(before + 1);

    const page = await readPage("concepts/pricing.md");
    const fm = page!.parsed.ok ? page!.parsed.frontmatter : null;
    const verified = fm!.claims.find((c) => c.id === PRICE_A.id)!;
    expect(verified).toMatchObject({ text: "A blue widget costs 11 EUR.", status: "verified", confidence: 1, verified: { by: "owner" } });
    expect(verified.evidence.at(-1)).toMatchObject({ kind: "human-verification" });
    expect(fm!.checked_by).toBe("human");
    expect(fm!.claims.map((c) => c.id)).toContain(other.id);

    const loser = await readPage("concepts/shipping.md");
    expect(loser!.parsed.ok && loser!.parsed.frontmatter.claims).toEqual([]);
    expect(loser!.parsed.ok && loser!.parsed.frontmatter.retiredClaimIds).toEqual([PRICE_B.id]);
    expect(readRetiredLedger(vault)).toEqual(expect.arrayContaining([PRICE_B.id, "acme-sales/old/never-seen"]));
  });

  it("removes a colliding copy of the kept id without retiring it", async () => {
    await vaultOperation(
      "seed: collision",
      async (tx) => {
        await tx.write("concepts/pricing.md", pageText({ claims: [PRICE_A] }));
        await tx.write("concepts/shipping.md", pageText({ title: "Copy", claims: [claim(PRICE_A.id, "A blue widget costs 13 EUR.")] }));
      },
      { lint: false },
    );
    await verifyClaim({ claimId: PRICE_A.id, text: "A blue widget costs 10 EUR.", by: "owner", page: "concepts/pricing.md" });
    const copy = await readPage("concepts/shipping.md");
    expect(copy!.parsed.ok && copy!.parsed.frontmatter.claims).toEqual([]);
    expect(copy!.parsed.ok && copy!.parsed.frontmatter.retiredClaimIds).toEqual([]);
    expect(readRetiredLedger(vault)).not.toContain(PRICE_A.id);
  });

  it("writes a new claim to the named page, and refuses what it cannot do", async () => {
    await seed({ "concepts/pricing.md": pageText({ claims: [] }) });
    const r = await verifyClaim({ claimId: "acme-sales/widget-pricing/green-price", text: "A green widget costs 8 EUR.", by: "owner", page: "concepts/pricing.md" });
    expect(r.page).toBe("concepts/pricing.md");
    await expect(verifyClaim({ claimId: "acme-sales/x/y", text: "t", by: "owner" })).rejects.toMatchObject({ code: "not_found" });
    await expect(verifyClaim({ claimId: "Bad", text: "t", by: "owner" })).rejects.toBeInstanceOf(VerifyError);
    await expect(verifyClaim({ claimId: "acme-sales/x/y", text: "", by: "owner", page: "concepts/pricing.md" })).rejects.toMatchObject({ code: "invalid" });
    await verifyClaim({ claimId: "acme-sales/widget-pricing/green-price", text: "A green widget costs 7 EUR.", by: "owner", retire: ["acme-sales/widget-pricing/old-green"] });
    await expect(
      verifyClaim({ claimId: "acme-sales/widget-pricing/old-green", text: "t", by: "owner", page: "concepts/pricing.md" }),
    ).rejects.toMatchObject({ code: "retired" });
    expect(cleanVerifiedText(" a\n b ")).toBe("a b");
  });

  it("refuses a verified text that carries a secret, changing nothing", async () => {
    await seed({ "concepts/pricing.md": pageText({ claims: [PRICE_A] }) });
    const head = await headCommit(vault);
    await expect(
      verifyClaim({ claimId: PRICE_A.id, text: `The key is ${FAKE_TOKEN}`, by: "owner" }),
    ).rejects.toBeInstanceOf(VaultLintBlockedError);
    expect((await headCommit(vault))?.sha).toBe(head?.sha);
  });
});

describe("resolving review items", () => {
  async function disputed() {
    await seed({
      "concepts/pricing.md": pageText({ claims: [PRICE_A] }),
      "concepts/shipping.md": pageText({ title: "Catalogue", claims: [PRICE_B] }),
    });
    return addReviewItem(vault, {
      kind: "contradiction",
      claimId: PRICE_A.id,
      pages: ["concepts/pricing.md", "concepts/shipping.md"],
      candidates: [
        { text: PRICE_A.text, page: "concepts/pricing.md", claimId: PRICE_A.id, evidence: [{ kind: "claim", page: "concepts/pricing.md" }] },
        { text: PRICE_B.text, page: "concepts/shipping.md", claimId: PRICE_B.id, evidence: [{ kind: "claim", page: "concepts/shipping.md" }] },
      ],
    }).item;
  }

  it("pick: the chosen text is verified, the other candidate's id retired, the item resolved, the reindex hook told", async () => {
    const item = await disputed();
    const otherItem = addReviewItem(vault, { kind: "opus", claimId: PRICE_B.id }).item;
    const hook = vi.fn();
    setVaultReindexHook(hook);
    const r = await resolveReviewItem(item.id, { action: "pick", candidate: 1 }, { by: "owner" });
    expect(r.retired).toEqual([PRICE_B.id]);
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.item).toMatchObject({ status: "resolved", resolution: { action: "pick", candidate: 1, text: PRICE_B.text, retired: [PRICE_B.id] } });
    const page = await readPage("concepts/pricing.md");
    expect(page!.parsed.ok && page!.parsed.frontmatter.claims[0]).toMatchObject({ id: PRICE_A.id, text: PRICE_B.text, status: "verified" });
    // An item about the retired claim asks about nothing now.
    expect(getReviewItem(vault, otherItem.id)?.status).toBe("resolved");
    expect(hook).toHaveBeenCalledWith(["concepts/pricing.md", "concepts/shipping.md"]);
    await expect(resolveReviewItem(item.id, { action: "dismiss" }, { by: "owner" })).rejects.toMatchObject({ code: "already_resolved" });
  });

  it("new: the owner's text wins and every candidate id is retired", async () => {
    const item = await disputed();
    const r = await resolveReviewItem(item.id, { action: "new", text: "A blue widget costs 11 EUR." }, { by: "owner" });
    expect(r.retired).toEqual([PRICE_B.id]);
    expect(readRetiredLedger(vault)).toContain(PRICE_B.id);
  });

  it("later keeps it waiting; dismiss resolves it with no commit; a missing item is not_found", async () => {
    const item = await disputed();
    const head = await headCommit(vault);
    expect((await resolveReviewItem(item.id, { action: "later" }, { by: "owner" })).item.status).toBe("later");
    expect((await resolveReviewItem(item.id, { action: "dismiss" }, { by: "owner" })).item.status).toBe("resolved");
    expect((await headCommit(vault))?.sha).toBe(head?.sha);
    await expect(resolveReviewItem("rev-000000000000", { action: "later" }, { by: "owner" })).rejects.toMatchObject({ code: "not_found" });
    const noClaim = addReviewItem(vault, { kind: "lint", pages: ["concepts/pricing.md"] }).item;
    await expect(resolveReviewItem(noClaim.id, { action: "pick", candidate: 0 }, { by: "owner" })).rejects.toMatchObject({ code: "no_claim" });
  });

  it("two resolutions of one item verify once", async () => {
    const item = await disputed();
    const results = await Promise.allSettled([
      resolveReviewItem(item.id, { action: "pick", candidate: 0 }, { by: "owner" }),
      resolveReviewItem(item.id, { action: "pick", candidate: 1 }, { by: "owner" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const verifies = (await git(vault, ["log", "--format=%s"])).stdout.split("\n").filter((s) => s.startsWith("verify:"));
    expect(verifies).toHaveLength(1);
  });
});

describe("verified gate", () => {
  const verifiedPage = pageText({ claims: [claim(PRICE_A.id, PRICE_A.text, { status: "verified", verified: { at: "2026-02-01T00:00:00.000Z", by: "owner" } })] });

  it("ignores bookkeeping", () => {
    for (const p of ["index.md", "log.md", "log.jsonl", ".openclaw-wiki/state.json", "_views/x.md", "reports/r.md", "concepts/x.txt"]) expect(gateIgnores(p)).toBe(true);
    expect(gateIgnores("concepts/pricing.md")).toBe(false);
  });

  it("judges one page: new, unverified, re-serialised, edited, deleted", () => {
    expect(judgeTouch("p.md", null, verifiedPage)).toBeNull();
    expect(judgeTouch("p.md", pageText({ claims: [PRICE_A] }), pageText({ claims: [PRICE_B] }))).toBeNull();
    expect(judgeTouch("p.md", verifiedPage, `${verifiedPage}`)).toBeNull();
    const edited = verifiedPage.replace(PRICE_A.text, "A blue widget costs 99 EUR.");
    expect(judgeTouch("p.md", verifiedPage, edited)).toEqual({
      path: "p.md",
      deleted: false,
      pageVerified: false,
      claims: [{ claimId: PRICE_A.id, before: PRICE_A.text, after: "A blue widget costs 99 EUR." }],
    });
    expect(judgeTouch("p.md", verifiedPage, verifiedPage.replace("sells widgets", "sells gadgets"))).toMatchObject({ claims: [] });
    expect(judgeTouch("p.md", verifiedPage, null)).toMatchObject({ deleted: true, claims: [{ claimId: PRICE_A.id, after: null }] });
  });

  it("compares a branch with main: bookkeeping-only is clean, a verified edit is caught", async () => {
    await seed({ "concepts/pricing.md": verifiedPage, "concepts/shipping.md": pageText({ title: "Shipping", claims: [PRICE_B] }) });
    await git(vault, ["checkout", "--quiet", "-b", "dream/2026-03-01"]);
    await vaultOperation("nightly: index", async (tx) => {
      await tx.write("index.md", `${INDEX}- [[concepts/new]]\n`);
      await tx.write("concepts/shipping.md", pageText({ title: "Shipping", claims: [claim(PRICE_B.id, "A blue widget costs 14 EUR.")] }));
    });
    expect(await verifiedTouches(vault, "main", "dream/2026-03-01")).toEqual([]);
    await vaultOperation("nightly: edit verified", async (tx) => {
      await tx.write("concepts/pricing.md", verifiedPage.replace(PRICE_A.text, "A blue widget costs 99 EUR."));
    });
    const touches = await verifiedTouches(vault, "main", "dream/2026-03-01");
    expect(touches.map((t) => t.path)).toEqual(["concepts/pricing.md"]);
    await git(vault, ["checkout", "--quiet", "main"]);
  });
});

describe("history, diff and revert", () => {
  it("lists a page's history and diffs a commit, refusing bad ids and paths", async () => {
    await seed({ "concepts/pricing.md": pageText({ claims: [PRICE_A] }) });
    await vaultOperation("edit: pricing", async (tx) => tx.write("concepts/pricing.md", pageText({ claims: [claim(PRICE_A.id, "A blue widget costs 15 EUR.")] })));
    const h = await pageHistory("concepts/pricing");
    expect(h?.path).toBe("concepts/pricing.md");
    expect(h?.commits.map((c) => c.subject)).toEqual(["edit: pricing", "seed: pages"]);
    expect(await pageHistory("../etc/passwd")).toBeNull();

    const d = await vaultDiff({ to: h!.commits[0].sha.slice(0, 10), path: "concepts/pricing.md" });
    expect(d.files).toEqual(["concepts/pricing.md"]);
    expect(d.diff).toContain("+    text: A blue widget costs 15 EUR.");
    expect(d.commit?.subject).toBe("edit: pricing");
    const root = (await git(vault, ["rev-list", "--max-parents=0", "HEAD"])).stdout.trim();
    expect((await vaultDiff({ to: root })).files).toEqual(expect.arrayContaining(["index.md", "AGENTS.md"]));
    await expect(vaultDiff({ to: "HEAD" })).rejects.toMatchObject({ code: "invalid" });
    await expect(vaultDiff({ to: "abcdef1234" })).rejects.toMatchObject({ code: "not_found" });
    await expect(vaultDiff({ to: h!.commits[0].sha, path: "../x" })).rejects.toBeInstanceOf(HistoryError);
    expect(safeCommitId("ABCDEF1")).toBe("abcdef1");
    expect(safeCommitId("abc;rm")).toBeNull();
  });

  it("reverts one commit as one new commit, refuses a conflict and an undo of a verification", async () => {
    await seed({ "concepts/pricing.md": pageText({ claims: [PRICE_A] }), "concepts/shipping.md": pageText({ title: "Shipping", claims: [PRICE_B] }) });
    const edit = await vaultOperation("edit: shipping", async (tx) =>
      tx.write("concepts/shipping.md", pageText({ title: "Shipping", claims: [claim(PRICE_B.id, "A blue widget costs 16 EUR.")] })),
    );
    const r = await revertCommit({ sha: edit.commit! });
    expect(r.changed).toEqual(["concepts/shipping.md"]);
    expect((await headCommit(vault))?.subject).toMatch(/^revert: [0-9a-f]{12} edit: shipping$/);
    expect(await showFileAt(vault, "HEAD", "concepts/shipping.md")).toBe(pageText({ title: "Shipping", claims: [PRICE_B] }).trim());

    // A later change to the same lines: the old commit no longer comes off alone.
    const a = await vaultOperation("edit: a", async (tx) => tx.write("concepts/shipping.md", pageText({ title: "Shipping", claims: [claim(PRICE_B.id, "Seventeen.")] })));
    await vaultOperation("edit: b", async (tx) => tx.write("concepts/shipping.md", pageText({ title: "Shipping", claims: [claim(PRICE_B.id, "Eighteen.")] })));
    await expect(revertCommit({ sha: a.commit! })).rejects.toMatchObject({ code: "conflict" });
    expect((await git(vault, ["status", "--porcelain"])).stdout.trim()).toBe("");

    const v = await verifyClaim({ claimId: PRICE_A.id, text: "A blue widget costs 10 EUR.", by: "owner", retire: [PRICE_B.id] });
    const head = await headCommit(vault);
    await expect(revertCommit({ sha: v.commit! })).rejects.toMatchObject({ code: "lint_blocked" });
    expect((await headCommit(vault))?.sha).toBe(head?.sha);
    expect((await git(vault, ["status", "--porcelain"])).stdout.trim()).toBe("");

    const rootSha = (await git(vault, ["rev-list", "--max-parents=0", "HEAD"])).stdout.trim();
    await expect(revertCommit({ sha: rootSha })).rejects.toMatchObject({ code: "invalid" });
  });
});
