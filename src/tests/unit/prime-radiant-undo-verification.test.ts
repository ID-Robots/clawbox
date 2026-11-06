/**
 * Undo never undoes a verification: a `verify:` commit — a settled review
 * question, a fact verified in the app or through the assistant — is refused
 * whole and page by page, for the owner and for the assistant, and the vault
 * stays exactly as it was; ordinary changes still come off. Over a REAL git
 * vault in a tmp dir. Every name in the fixtures is invented.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { primeRadiantTranslations } from "@/lib/prime-radiant-translations";
import { retireClaimsOnPage } from "@/lib/prime-radiant/claims";
import { deleteClaim, deletePage, verifyClaimAs } from "@/lib/prime-radiant/edit";
import { parsePage } from "@/lib/prime-radiant/frontmatter";
import { ASSISTANT_AUTHOR, git, headCommit, showFileAt } from "@/lib/prime-radiant/git";
import {
  HistoryError,
  isVerificationCommit,
  pageHistory,
  revertCommit,
  VERIFICATION_UNDO_RULE,
  verificationEffect,
} from "@/lib/prime-radiant/history";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { setVaultReindexHook } from "@/lib/prime-radiant/reindex-hook";
import { resolveReviewItem } from "@/lib/prime-radiant/review";
import { addReviewItem, getReviewItem } from "@/lib/prime-radiant/review-store";
import type { Claim, PageFrontmatter } from "@/lib/prime-radiant/schema";
import { readRetiredLedger } from "@/lib/prime-radiant/state-db";
import { upgradeAssistantVerifications, verifyClaim } from "@/lib/prime-radiant/verify";
import { ensureVault, vaultOperation } from "@/lib/prime-radiant/vault";
import { claim, frontmatter, pageText } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-undo-verification-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;
let vault = "";

// The UI test's X200 case: the spec sheet says 1.2 kg, the customer FAQ 1.5 kg.
const SPEC_PAGE = "products/sprocket-x200-specification.md";
const FAQ_PAGE = "support/customer-faq.md";
const SPEC = claim("acme-products/sprocket-x200/weight", "The Sprocket X200 weighs 1.2 kg.");
const FAQ = claim("acme-support/customer-faq/x200-weight", "The FAQ lists the Sprocket X200's weight as 1.5 kg.");
const SPEC_TEXT = pageText({ title: "Sprocket X200 specification", domain: "acme-products", claims: [SPEC] });
const FAQ_TEXT = pageText({ title: "Customer FAQ", domain: "acme-support", claims: [FAQ] });
const INDEX = "# Index\n\n- [[products/sprocket-x200-specification]]\n- [[support/customer-faq]]\n";
const ASSISTANT = { author: ASSISTANT_AUTHOR, onlyAuthoredBy: ASSISTANT_AUTHOR };

async function seed(): Promise<void> {
  await vaultOperation("seed: pages", async (tx) => {
    await tx.write(SPEC_PAGE, SPEC_TEXT);
    await tx.write(FAQ_PAGE, FAQ_TEXT);
    await tx.write("index.md", INDEX);
  });
}

/** The review question the nightly contradiction pass raises for the pair (contradictions.ts). */
function raiseWeightQuestion() {
  return addReviewItem(vault, {
    kind: "contradiction",
    claimId: FAQ.id,
    pages: [FAQ_PAGE, SPEC_PAGE],
    candidates: [
      { text: FAQ.text, page: FAQ_PAGE, claimId: FAQ.id, evidence: [{ kind: "claim", page: FAQ_PAGE }] },
      { text: SPEC.text, page: SPEC_PAGE, claimId: SPEC.id, evidence: [{ kind: "claim", page: SPEC_PAGE }] },
    ],
  }).item;
}

function fmOf(text: string | null): PageFrontmatter {
  const parsed = parsePage(text ?? "");
  if (!parsed.ok) throw new Error("page does not parse");
  return parsed.frontmatter;
}

/** Everything an undo could change: HEAD, the work tree, both pages, the ledger. */
async function vaultState() {
  return {
    head: (await headCommit(vault))?.sha,
    status: (await git(vault, ["status", "--porcelain"])).stdout.trim(),
    spec: await showFileAt(vault, "HEAD", SPEC_PAGE),
    faq: await showFileAt(vault, "HEAD", FAQ_PAGE),
    onDisk: [fs.readFileSync(path.join(vault, SPEC_PAGE), "utf8"), fs.readFileSync(path.join(vault, FAQ_PAGE), "utf8")],
    ledger: readRetiredLedger(vault).sort(),
  };
}

async function refusedAsVerification(attempt: Promise<unknown>): Promise<HistoryError> {
  const err = await attempt.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HistoryError);
  const h = err as HistoryError;
  expect(h).toMatchObject({ code: "lint_blocked", status: 409 });
  expect(h.message).toMatch(/verification is never undone/);
  expect(h.findings.length).toBeGreaterThan(0);
  expect(h.findings.every((f) => f.rule === VERIFICATION_UNDO_RULE && f.blocksCommit)).toBe(true);
  return h;
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

describe("undo of a verification is refused", () => {
  it("B1: Review keeps 1.2 kg, then Undo on the FAQ page's verify: commit is refused and the wiki keeps the right answer", async () => {
    await seed();
    const item = raiseWeightQuestion();
    // Review → the X200 weight question → Keep this answer on 1.2 kg.
    const resolved = await resolveReviewItem(item.id, { action: "pick", candidate: 1 }, { by: "owner" });
    expect(resolved.retired).toEqual([SPEC.id]);
    const sha = resolved.commit!;

    // Pages → Customer FAQ → History: the newest commit is the verification, marked so no Undo is offered.
    const faqHistory = await pageHistory(FAQ_PAGE);
    expect(faqHistory!.commits[0]).toMatchObject({ sha, subject: `verify: ${FAQ.id}`, verified: { by: "owner" }, noUndo: "verification" });
    expect(faqHistory!.commits.slice(1).every((c) => c.noUndo === undefined)).toBe(true);
    expect((await pageHistory(SPEC_PAGE))!.commits[0]).toMatchObject({ sha, noUndo: "verification" });

    const before = await vaultState();
    // Undo on that commit, as History sends it (one page), then the other page, then whole.
    const scoped = await refusedAsVerification(revertCommit({ sha, path: FAQ_PAGE }));
    expect(scoped.findings.map((f) => f.path).sort()).toEqual([SPEC_PAGE, FAQ_PAGE].sort());
    await refusedAsVerification(revertCommit({ sha, path: SPEC_PAGE }));
    await refusedAsVerification(revertCommit({ sha }));
    // The short id History shows is refused the same.
    await refusedAsVerification(revertCommit({ sha: sha.slice(0, 7), path: FAQ_PAGE }));
    expect(await vaultState()).toEqual(before);

    // The right value stays in the wiki, verified; the losing id stays retired; the question stays settled.
    const faq = fmOf(before.faq).claims.find((c) => c.id === FAQ.id)!;
    expect(faq).toMatchObject({ text: SPEC.text, status: "verified", verified: { by: "owner" } });
    expect(fmOf(before.spec)).toMatchObject({ claims: [], retiredClaimIds: [SPEC.id] });
    expect(before.ledger).toContain(SPEC.id);
    expect(getReviewItem(vault, item.id)?.status).toBe("resolved");
  });

  it("refuses a review's own written answer, and the assistant's undo of a review it settled (the MCP tool's road)", async () => {
    await seed();
    const item = raiseWeightQuestion();
    const resolved = await resolveReviewItem(
      item.id,
      { action: "new", text: "The Sprocket X200 weighs 1.25 kg." },
      { by: "owner", via: "assistant", author: ASSISTANT_AUTHOR, person: false },
    );
    expect(resolved.retired).toEqual([SPEC.id]);
    const sha = resolved.commit!;
    const before = await vaultState();
    // The assistant authored the commit, so "only your own" lets it through to the real answer: nobody may.
    await refusedAsVerification(revertCommit({ sha, path: FAQ_PAGE }, vault, ASSISTANT));
    await refusedAsVerification(revertCommit({ sha }, vault, ASSISTANT));
    await refusedAsVerification(revertCommit({ sha, path: SPEC_PAGE }));
    expect(await vaultState()).toEqual(before);
  });

  it("refuses the owner's settled question to the assistant as a verification, not as the owner's to do", async () => {
    await seed();
    const item = raiseWeightQuestion();
    const { commit } = await resolveReviewItem(item.id, { action: "pick", candidate: 1 }, { by: "owner" });
    await refusedAsVerification(revertCommit({ sha: commit!, path: FAQ_PAGE }, vault, ASSISTANT));
  });

  it("refuses a single fact verified with nothing retired: in the app, and by the assistant on the owner's word", async () => {
    await seed();
    const viaAssistant = await verifyClaimAs(
      { id: FAQ.id, text: null, page: null, confirm: true },
      { by: "owner", via: "assistant", author: ASSISTANT_AUTHOR, person: false },
    );
    expect(viaAssistant.retired).toEqual([]);
    const inApp = await verifyClaim({ claimId: SPEC.id, text: SPEC.text, by: "owner" });
    const before = await vaultState();
    await refusedAsVerification(revertCommit({ sha: viaAssistant.commit!, path: FAQ_PAGE }, vault, ASSISTANT));
    await refusedAsVerification(revertCommit({ sha: viaAssistant.commit! }));
    await refusedAsVerification(revertCommit({ sha: inApp.commit!, path: SPEC_PAGE }));
    expect(await vaultState()).toEqual(before);
    const marked = (await pageHistory(FAQ_PAGE))!.commits.filter((c) => c.noUndo === "verification").map((c) => c.sha);
    expect(marked).toEqual([viaAssistant.commit]);
  });

  it("leaves the one-off migration of the assistant's verifications undoable: it re-stamps who verified, verifies nothing anew, retires nothing", async () => {
    const at = "2026-03-01T09:00:00.000Z";
    const stamped: Claim = claim(FAQ.id, FAQ.text, {
      status: "verified",
      confidence: 1,
      verified: { at, by: "assistant" },
      evidence: [{ kind: "human-verification", note: "verified by assistant", updatedAt: at }],
    });
    await vaultOperation("seed: pages", async (tx) => {
      await tx.write(SPEC_PAGE, SPEC_TEXT);
      await tx.write(FAQ_PAGE, pageText({ title: "Customer FAQ", domain: "acme-support", claims: [stamped] }));
      await tx.write("index.md", INDEX);
    });
    const migrated = await upgradeAssistantVerifications({});
    expect(migrated.upgraded).toEqual([{ claimId: FAQ.id, page: FAQ_PAGE }]);
    const [newest] = (await pageHistory(FAQ_PAGE))!.commits;
    expect(newest).toMatchObject({ sha: migrated.commit, verified: { by: "owner", via: "assistant" } });
    expect(newest.noUndo).toBeUndefined();
    const parent = (await git(vault, ["rev-parse", `${migrated.commit}^1`])).stdout.trim();
    expect(await verificationEffect(vault, parent, migrated.commit!)).toEqual({ retired: [], unretired: [], verified: [], pages: [] });
    expect((await revertCommit({ sha: migrated.commit! })).commit).toBeTruthy();
    // The fact stays verified; only who verified it goes back to the assistant.
    expect(fmOf(await showFileAt(vault, "HEAD", FAQ_PAGE)).claims[0]).toMatchObject({ status: "verified", verified: { at, by: "assistant" } });
  });
});

describe("a page-scoped undo never leaves an answer retired while taking its replacement away", () => {
  it("judges a commit by everything it did, whatever its subject says", async () => {
    await seed();
    const at = "2026-04-02T08:00:00.000Z";
    // One commit that retires the spec's answer and verifies its replacement on the FAQ page —
    // with no verify: subject and no trailer: the pages alone say what it did.
    const op = await vaultOperation("edit: tidy the X200 weight", async (tx) => {
      const verified = claim(FAQ.id, SPEC.text, { status: "verified", confidence: 1, verified: { at, by: "owner" } });
      await tx.writePage(FAQ_PAGE, frontmatter({ title: "Customer FAQ", domain: "acme-support", claims: [verified] }), fmBody(FAQ_TEXT));
      const spec = retireClaimsOnPage(fmOf(SPEC_TEXT), new Set([SPEC.id])).frontmatter;
      await tx.writePage(SPEC_PAGE, spec, fmBody(SPEC_TEXT));
    });
    const sha = op.commit!;
    const info = (await headCommit(vault))!;
    expect(isVerificationCommit(info)).toBe(false);
    expect((await pageHistory(FAQ_PAGE))!.commits[0].noUndo).toBeUndefined();
    const parent = (await git(vault, ["rev-parse", `${sha}^1`])).stdout.trim();
    expect(await verificationEffect(vault, parent, sha)).toEqual({ retired: [SPEC.id], unretired: [], verified: [FAQ.id], pages: [SPEC_PAGE, FAQ_PAGE].sort() });

    const before = await vaultState();
    await refusedAsVerification(revertCommit({ sha, path: FAQ_PAGE }));
    await refusedAsVerification(revertCommit({ sha, path: SPEC_PAGE }));
    await refusedAsVerification(revertCommit({ sha }));
    expect(await vaultState()).toEqual(before);
  });

  it("lets an undo made before the fix be undone — the verification comes back — and refuses that redo like the verification", async () => {
    await seed();
    const item = raiseWeightQuestion();
    const { commit: verifySha } = await resolveReviewItem(item.id, { action: "pick", candidate: 1 }, { by: "owner" });
    const verifiedFaq = await showFileAt(vault, "HEAD", FAQ_PAGE);
    // What the old page-scoped undo committed: the FAQ page back to 1.5 kg, the spec's 1.2 kg left retired.
    const bad = await vaultOperation(`revert: ${verifySha!.slice(0, 12)} verify: ${FAQ.id}`, async (tx) => tx.write(FAQ_PAGE, FAQ_TEXT));
    expect(fmOf(await showFileAt(vault, "HEAD", FAQ_PAGE)).claims).toEqual([FAQ]);
    expect(fmOf(await showFileAt(vault, "HEAD", SPEC_PAGE)).retiredClaimIds).toEqual([SPEC.id]);
    expect((await pageHistory(FAQ_PAGE))!.commits[0].noUndo).toBeUndefined();

    // Undoing that undo puts the verified answer back.
    const redo = await revertCommit({ sha: bad.commit!, path: FAQ_PAGE });
    expect(redo.changed).toEqual([FAQ_PAGE]);
    expect(await showFileAt(vault, "HEAD", FAQ_PAGE)).toBe(verifiedFaq);
    // And the redo set a verification stamp: it is never undone either.
    await refusedAsVerification(revertCommit({ sha: redo.commit!, path: FAQ_PAGE }));
  });
});

describe("History's words for it", () => {
  it("are in every language, Bulgarian in its own words", () => {
    const keys = ["primeRadiant.history.noUndo", "primeRadiant.history.noUndoWhy", "primeRadiant.history.verificationRefused"];
    for (const [locale, table] of Object.entries(primeRadiantTranslations)) {
      for (const key of keys) expect(table[key], `${locale} ${key}`).toMatch(/\S/);
    }
    for (const key of keys) {
      expect(primeRadiantTranslations.bg[key]).not.toBe(primeRadiantTranslations.en[key]);
      expect(primeRadiantTranslations.bg[key]).toMatch(/[Ѐ-ӿ]/);
    }
    expect(primeRadiantTranslations.bg["primeRadiant.history.verificationRefused"]).toMatch(/^Не е отменено/);
  });
});

describe("ordinary changes still come off", () => {
  it("undoes an edit page by page and whole, beside a verification that stays", async () => {
    await seed();
    const item = raiseWeightQuestion();
    await resolveReviewItem(item.id, { action: "pick", candidate: 1 }, { by: "owner" });
    const verifiedFaq = await showFileAt(vault, "HEAD", FAQ_PAGE);
    const verifiedSpec = await showFileAt(vault, "HEAD", SPEC_PAGE);

    const edit = await vaultOperation("edit: wording", async (tx) => {
      await tx.writePage(FAQ_PAGE, fmOf(verifiedFaq), "The FAQ answers what customers ask most.\n");
      await tx.writePage(SPEC_PAGE, fmOf(verifiedSpec), "The spec sheet lists the X200's measurements.\n");
    });
    const history = (await pageHistory(FAQ_PAGE))!.commits;
    expect(history[0]).toMatchObject({ sha: edit.commit });
    expect(history[0].noUndo).toBeUndefined();

    const one = await revertCommit({ sha: edit.commit!, path: FAQ_PAGE });
    expect(one.changed).toEqual([FAQ_PAGE]);
    expect(await showFileAt(vault, "HEAD", FAQ_PAGE)).toBe(verifiedFaq);
    // The rest of the edit comes off whole once the FAQ page's part is gone.
    const rest = await revertCommit({ sha: edit.commit!, path: SPEC_PAGE });
    expect(rest.changed).toEqual([SPEC_PAGE]);
    expect(await showFileAt(vault, "HEAD", SPEC_PAGE)).toBe(verifiedSpec);

    const again = await vaultOperation("edit: wording again", async (tx) => tx.writePage(FAQ_PAGE, fmOf(verifiedFaq), "Shorter.\n"));
    expect((await revertCommit({ sha: again.commit! })).commit).toBeTruthy();
    expect((await git(vault, ["status", "--porcelain"])).stdout.trim()).toBe("");
  });

  it("brings back a deleted verified fact, and a deleted page with the ids it retired", async () => {
    await seed();
    await verifyClaim({ claimId: FAQ.id, text: "The Sprocket X200 weighs 1.2 kg.", by: "owner", retire: [SPEC.id] });
    const deleted = await deleteClaim(FAQ.id, FAQ_PAGE, { by: "owner", person: true });
    expect(deleted.wasVerified).toBe(true);
    const back = await revertCommit({ sha: deleted.commit!, path: FAQ_PAGE });
    expect(back.commit).toBeTruthy();
    expect(fmOf(await showFileAt(vault, "HEAD", FAQ_PAGE)).claims[0]).toMatchObject({ id: FAQ.id, status: "verified" });

    // The spec page lists the retired id; deleting the page and undoing that is no retirement.
    const gone = await deletePage(SPEC_PAGE, { by: "owner", person: true });
    const restored = await revertCommit({ sha: gone.commit! });
    expect(restored.commit).toBeTruthy();
    expect(fmOf(await showFileAt(vault, "HEAD", SPEC_PAGE)).retiredClaimIds).toEqual([SPEC.id]);
  });
});

function fmBody(text: string): string {
  return parsePage(text).body;
}
