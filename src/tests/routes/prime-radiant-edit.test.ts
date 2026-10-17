/**
 * The direct-edit routes (pages POST/PATCH/DELETE, pages/merge, claims POST/PATCH/DELETE,
 * claims/verify) and the writes the assistant may now make (revert of its own
 * commits, review resolve, maintenance connect), over a real vault in a tmp
 * dir. Three callers: the owner's cookie, the MCP bearer (the assistant) and
 * neither; every write is one commit, and the assistant's names it.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const auth = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/route-auth", () => auth);
const owner = vi.hoisted(() => ({ hasPersonSession: vi.fn(async () => true) }));
vi.mock("@/lib/owner-session", () => owner);
const bearer = vi.hoisted(() => ({ verifyMcpBearer: vi.fn((h: string | null) => h === "Bearer test-assistant-bearer") }));
vi.mock("@/lib/mcp-token", () => bearer);
// The vault's Memory Shard index: stubbed (it embeds), pinned in its own suite.
const shard = vi.hoisted(() => ({
  scheduleReindexAfterCommit: vi.fn(),
  reindexPrimeRadiantVault: vi.fn(async () => null),
  reindexPrimeRadiantPaths: vi.fn(async () => null),
  readPageVectors: vi.fn(async () => new Map()),
  vaultIndexingAllowed: vi.fn(async () => false),
}));
vi.mock("@/lib/prime-radiant/shard-index", () => shard);

import { POST as pagesPOST, GET as pagesGET } from "@/app/setup-api/prime-radiant/pages/route";
import { DELETE as pageDELETE, GET as pageGET, PATCH as pagePATCH, POST as pagePOST } from "@/app/setup-api/prime-radiant/pages/[...path]/route";
import { POST as claimsPOST } from "@/app/setup-api/prime-radiant/claims/route";
import { DELETE as claimDELETE, PATCH as claimPATCH } from "@/app/setup-api/prime-radiant/claims/[...id]/route";
import { POST as verifyPOST } from "@/app/setup-api/prime-radiant/claims/verify/route";
import { POST as revertPOST } from "@/app/setup-api/prime-radiant/revert/route";
import { POST as resolvePOST } from "@/app/setup-api/prime-radiant/review/[id]/resolve/route";
import { GET as maintenanceGET, POST as maintenancePOST } from "@/app/setup-api/prime-radiant/maintenance/route";
import { addReviewItem } from "@/lib/prime-radiant/review-store";
import { commitAuthorEmail, logForPath } from "@/lib/prime-radiant/git";
import { parsePage } from "@/lib/prime-radiant/frontmatter";
import { ownerVerified } from "@/lib/prime-radiant/schema";
import { ensureVault, vaultOperation } from "@/lib/prime-radiant/vault";
import { claim, pageText } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-edit-routes-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;
let vault = "";

const ORIGIN = "http://clawbox.local";
const API = `${ORIGIN}/setup-api/prime-radiant`;
type As = "owner" | "assistant" | "nobody";

/** A request as one of the three callers. The assistant is the MCP server: a bearer, no Origin. */
function req(method: string, url: string, as: As, body?: unknown, headers: Record<string, string> = {}) {
  const who: Record<string, string> = as === "assistant" ? { authorization: "Bearer test-assistant-bearer" } : as === "owner" ? { origin: ORIGIN } : {};
  owner.hasPersonSession.mockResolvedValue(as === "owner");
  return new Request(`${API}${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", ...who, ...headers },
  });
}
const pathCtx = (p: string) => ({ params: Promise.resolve({ path: p.split("/") }) });
const idCtx = (id: string) => ({ params: Promise.resolve({ id: id.split("/") }) });
const reviewCtx = (id: string) => ({ params: Promise.resolve({ id }) });

/** `<author>|<committer>|<subject>` of the vault's commits, newest first. */
function log(limit = 1): string[] {
  return execFileSync("git", ["-C", vault, "log", `-${limit}`, "--format=%an|%cn|%s"], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
  })
    .trim()
    .split("\n");
}
const read = (rel: string) => fs.readFileSync(path.join(vault, rel), "utf8");

const PRICE = claim("acme-sales/pricing/blue-widget", "The blue widget costs 10 EUR.", { status: "proposed" });
const VERIFIED = claim("acme-sales/pricing/red-widget", "The red widget costs 14 EUR.", {
  status: "verified",
  confidence: 1,
  verified: { at: "2026-02-01T00:00:00.000Z", by: "owner" },
});

async function seed() {
  await vaultOperation("seed: pages", async (tx) => {
    await tx.write("concepts/pricing.md", pageText({ claims: [PRICE, VERIFIED] }));
    await tx.write("index.md", "# Index\n\n- [[concepts/pricing]] — Widget pricing\n");
  });
}

const NEW_PAGE = {
  type: "entity",
  title: "Acme Widgets Ltd",
  domain: "acme-sales",
  summary: "Acme Widgets Ltd is a synthetic company that makes widgets.",
  body: "## Details\n\nIt sells in three sizes; see [[concepts/pricing]].",
  facts: ["Acme Widgets Ltd was founded in 1999."],
};

beforeEach(async () => {
  auth.requireSession.mockReset().mockResolvedValue(null);
  owner.hasPersonSession.mockReset().mockResolvedValue(true);
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
  vault = path.join(process.env.PRIME_RADIANT_DIR, "vault");
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("who may write", () => {
  it("answers whatever requireSession answers, before anything else", async () => {
    auth.requireSession.mockResolvedValue(NextResponse.json({ error: "x", code: "unauthorized" }, { status: 401 }));
    for (const res of [
      await pagesPOST(req("POST", "/pages", "assistant", NEW_PAGE)),
      await pagePATCH(req("PATCH", "/pages/concepts/pricing.md", "assistant", { title: "x" }), pathCtx("concepts/pricing.md")),
      await pageDELETE(req("DELETE", "/pages/concepts/pricing.md", "assistant"), pathCtx("concepts/pricing.md")),
      await pagePOST(req("POST", "/pages/merge", "assistant", { into: "concepts/pricing.md", from: ["concepts/x.md"] }), pathCtx("merge")),
      await claimsPOST(req("POST", "/claims", "assistant", { page: "concepts/pricing.md", text: "x" })),
      await claimPATCH(req("PATCH", `/claims/${PRICE.id}`, "assistant", { text: "x" }), idCtx(PRICE.id)),
      await claimDELETE(req("DELETE", `/claims/${PRICE.id}`, "assistant"), idCtx(PRICE.id)),
      await verifyPOST(req("POST", "/claims/verify", "assistant", { id: PRICE.id })),
    ]) {
      expect(res.status).toBe(401);
    }
    expect(fs.existsSync(vault)).toBe(false);
  });

  it("refuses a caller that is neither the owner's cookie nor the assistant's bearer", async () => {
    await ensureVault();
    await seed();
    const head = log()[0];
    for (const res of [
      await pagesPOST(req("POST", "/pages", "nobody", NEW_PAGE)),
      await pagePATCH(req("PATCH", "/pages/concepts/pricing.md", "nobody", { title: "x" }), pathCtx("concepts/pricing.md")),
      await pageDELETE(req("DELETE", "/pages/concepts/pricing.md", "nobody"), pathCtx("concepts/pricing.md")),
      await pagePOST(req("POST", "/pages/merge", "nobody", { into: "concepts/pricing.md", from: ["concepts/x.md"] }), pathCtx("merge")),
      await claimsPOST(req("POST", "/claims", "nobody", { page: "concepts/pricing.md", text: "A fact." })),
      await claimDELETE(req("DELETE", `/claims/${PRICE.id}`, "nobody"), idCtx(PRICE.id)),
      await verifyPOST(req("POST", "/claims/verify", "nobody", { id: PRICE.id })),
      await revertPOST(req("POST", "/revert", "nobody", { commit: "abcdef1" })),
      await pagesPOST(req("POST", "/pages", "nobody", NEW_PAGE, { authorization: "Bearer not-the-bearer" })),
    ]) {
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("owner_only");
    }
    expect(log()[0]).toBe(head);
  });

  it("refuses a cross-site page riding the owner's cookie", async () => {
    await ensureVault();
    const res = await pagesPOST(req("POST", "/pages", "owner", NEW_PAGE, { origin: "https://evil.example.com" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
  });

  it("answers 412 before the vault exists, and creates none", async () => {
    const res = await pagesPOST(req("POST", "/pages", "assistant", NEW_PAGE));
    expect(res.status).toBe(412);
    expect((await res.json()).code).toBe("not_initialised");
    expect(fs.existsSync(vault)).toBe(false);
  });
});

describe("pages", () => {
  it("creates a page as the assistant: one commit it authors, its facts as proposed claims, an index line", async () => {
    await ensureVault();
    await seed();
    const res = await pagesPOST(req("POST", "/pages", "assistant", NEW_PAGE));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ path: "entities/acme-widgets-ltd.md", claims: ["acme-sales/acme-widgets-ltd/acme-widgets-ltd-was-founded-in-1999"] });
    expect(log()[0]).toBe("ClawBox assistant|Prime Radiant|create: entities/acme-widgets-ltd.md");
    const text = read(body.path);
    expect(text).toContain("by: assistant");
    expect(text).toContain("status: proposed");
    expect(text).toContain("checked_by: flash");
    expect(text).toMatch(/sources:\n {2}- assistant/);
    expect(read("index.md")).toContain("- [[entities/acme-widgets-ltd]] — Acme Widgets Ltd");
    const page = await (await pageGET(req("GET", `/pages/${body.path}`, "assistant"), pathCtx(body.path))).json();
    expect(page.summary).toBe(NEW_PAGE.summary);
    expect(page.backlinks).toEqual([]);
    expect(page.links).toEqual(["concepts/pricing.md"]);
  });

  it("names the owner's page Prime Radiant's and marks it checked by a human", async () => {
    await ensureVault();
    const res = await pagesPOST(req("POST", "/pages", "owner", { ...NEW_PAGE, facts: undefined, owner: "sales-team" }));
    expect(res.status).toBe(201);
    expect(log()[0]).toBe("Prime Radiant|Prime Radiant|create: entities/acme-widgets-ltd.md");
    expect(read("entities/acme-widgets-ltd.md")).toContain("checked_by: human");
  });

  it("refuses a bad page strictly and writes nothing", async () => {
    await ensureVault();
    const head = log()[0];
    for (const bad of [
      { ...NEW_PAGE, type: "novel" },
      { ...NEW_PAGE, domain: "Acme Sales" },
      { ...NEW_PAGE, summary: "## A heading" },
      { ...NEW_PAGE, summary: "x".repeat(301) },
      { ...NEW_PAGE, colour: "blue" },
      { ...NEW_PAGE, facts: "one fact" },
      { ...NEW_PAGE, body: "x".repeat(12_001) },
    ]) {
      const res = await pagesPOST(req("POST", "/pages", "assistant", bad));
      expect(res.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
      expect((await res.json()).code).toBe("invalid");
    }
    expect(log()[0]).toBe(head);
  });

  it("refuses a page whose text carries a secret, putting nothing back on disk", async () => {
    await ensureVault();
    const secret = "ghp" + "_" + "Ab3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5";
    const res = await pagesPOST(req("POST", "/pages", "assistant", { ...NEW_PAGE, body: `The token is ${secret}.` }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("lint_blocked");
    expect(body.findings[0].rule).toBe("secret-pattern");
    expect(fs.existsSync(path.join(vault, "entities/acme-widgets-ltd.md"))).toBe(false);
  });

  it("edits the summary alone, keeping the rest of the body, as the assistant", async () => {
    await ensureVault();
    await seed();
    const res = await pagePATCH(
      req("PATCH", "/pages/concepts/pricing.md", "assistant", { summary: "Widget prices, as the owner gave them.", status: "stable" }),
      pathCtx("concepts/pricing.md"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed.sort()).toEqual(["status", "summary"]);
    expect(log()[0]).toBe("ClawBox assistant|Prime Radiant|edit: concepts/pricing.md");
    const text = read("concepts/pricing.md");
    expect(text).toContain("Widget prices, as the owner gave them.\n\n## Details");
    expect(text).not.toContain("Acme Widgets Ltd sells widgets in three sizes.");
    expect(text).toContain("status: stable");
    expect(text).toContain(VERIFIED.id);
  });

  it("commits nothing for an edit that changes nothing, and 404s a page that is not there", async () => {
    await ensureVault();
    await seed();
    const head = log()[0];
    const same = await (await pagePATCH(req("PATCH", "/pages/concepts/pricing.md", "assistant", { title: "Widget pricing" }), pathCtx("concepts/pricing.md"))).json();
    expect(same).toMatchObject({ commit: null, changed: [] });
    expect(log()[0]).toBe(head);
    const missing = await pagePATCH(req("PATCH", "/pages/concepts/nope.md", "assistant", { title: "x" }), pathCtx("concepts/nope.md"));
    expect(missing.status).toBe(404);
    const empty = await pagePATCH(req("PATCH", "/pages/concepts/pricing.md", "assistant", {}), pathCtx("concepts/pricing.md"));
    expect(empty.status).toBe(400);
  });

  it("deletes a page and its index line in one commit, saying which verified facts went", async () => {
    await ensureVault();
    await seed();
    const res = await pageDELETE(req("DELETE", "/pages/concepts/pricing.md", "assistant"), pathCtx("concepts/pricing.md"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ path: "concepts/pricing.md", claims: [PRICE.id, VERIFIED.id], verified: [VERIFIED.id] });
    expect(fs.existsSync(path.join(vault, "concepts/pricing.md"))).toBe(false);
    expect(read("index.md")).not.toContain("concepts/pricing");
    expect(log()[0]).toBe("ClawBox assistant|Prime Radiant|delete: concepts/pricing.md");
    const again = await pageDELETE(req("DELETE", "/pages/concepts/pricing.md", "assistant"), pathCtx("concepts/pricing.md"));
    expect(again.status).toBe(404);
  });

  it("merges a duplicate as the assistant through the bearer: a dry run first, then one commit it authors and may undo", async () => {
    await ensureVault();
    await seed();
    const GREEN = claim("acme-sales/prices/green-widget", "The green widget costs 9 EUR.", { status: "proposed" });
    await vaultOperation("seed: duplicate", async (tx) => {
      await tx.write("concepts/prices.md", pageText({ title: "Widget prices", claims: [GREEN] }, "Widget prices in brief.\n"));
      await tx.write("concepts/shipping.md", pageText({ title: "Shipping" }, "Shipping is priced as in [[concepts/prices|the list]].\n"));
      // A content page links shipping: index.md listing it does not keep it from being an orphan.
      await tx.write("concepts/returns.md", pageText({ title: "Returns" }, "Returns go back as in [[concepts/shipping]].\n"));
      await tx.write("index.md", "# Index\n\n- [[concepts/pricing]] — Widget pricing\n- [[concepts/prices]] — Widget prices\n- [[concepts/shipping]] — Shipping\n");
    });
    const before = { pricing: read("concepts/pricing.md"), prices: read("concepts/prices.md"), shipping: read("concepts/shipping.md"), index: read("index.md") };
    const head = log()[0];
    const merge = { into: "concepts/pricing.md", from: ["concepts/prices.md"] };

    const dry = await pagePOST(req("POST", "/pages/merge", "assistant", { ...merge, dry_run: true }), pathCtx("merge"));
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({ dryRun: true, commit: null, claims: [GREEN.id], relinked: [{ path: "concepts/shipping.md", links: 1 }], links: 1, indexLines: 1 });
    expect(log()[0]).toBe(head);

    const res = await pagePOST(req("POST", "/pages/merge", "assistant", merge), pathCtx("merge"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ dryRun: false, claims: [GREEN.id], aliases: ["Widget prices"], findings: [] });
    expect(log()[0]).toBe("ClawBox assistant|Prime Radiant|merge: concepts/prices.md -> concepts/pricing.md");
    expect(fs.existsSync(path.join(vault, "concepts/prices.md"))).toBe(false);
    expect(read("concepts/shipping.md")).toContain("[[concepts/pricing|the list]]");
    expect(read("index.md")).toBe("# Index\n\n- [[concepts/pricing]] — Widget pricing\n- [[concepts/shipping]] — Shipping\n");
    const merged = read("concepts/pricing.md");
    expect(merged).toContain(GREEN.id);
    expect(merged).toContain(VERIFIED.id);
    // The page that stays keeps its body as it was.
    expect(merged.slice(merged.indexOf("\n---\n"))).toBe(before.pricing.slice(before.pricing.indexOf("\n---\n")));

    const undone = await revertPOST(req("POST", "/revert", "assistant", { commit: body.commit }));
    expect(undone.status).toBe(200);
    expect({ pricing: read("concepts/pricing.md"), prices: read("concepts/prices.md"), shipping: read("concepts/shipping.md"), index: read("index.md") }).toEqual(before);
  });

  it("refuses a merge strictly, answers 405 to a POST on a page, and leaves a page at merge.md to GET", async () => {
    await ensureVault();
    await seed();
    await vaultOperation("seed: merge.md", async (tx) => tx.write("merge.md", pageText({ title: "Merge notes" }, "How the team merges.\n")));
    const head = log()[0];
    for (const [body, status, code] of [
      [{ into: "concepts/pricing.md", from: ["concepts/pricing.md"] }, 400, "invalid"],
      [{ into: "concepts/pricing.md", from: [] }, 400, "invalid"],
      [{ into: "concepts/pricing.md", from: ["merge.md"], force: true }, 400, "invalid"],
      [{ into: "concepts/pricing.md", from: ["concepts/nope.md"] }, 404, "not_found"],
    ] as const) {
      const res = await pagePOST(req("POST", "/pages/merge", "owner", body), pathCtx("merge"));
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect((await res.json()).code).toBe(code);
    }
    await pagePATCH(req("PATCH", "/pages/concepts/pricing.md", "owner", { status: "deprecated" }), pathCtx("concepts/pricing.md"));
    const deprecated = await pagePOST(req("POST", "/pages/merge", "owner", { into: "concepts/pricing.md", from: ["merge.md"] }), pathCtx("merge"));
    expect(deprecated.status).toBe(409);
    expect((await deprecated.json()).code).toBe("deprecated");
    expect(log(2)[1]).toBe(head);

    const onPage = await pagePOST(req("POST", "/pages/concepts/pricing.md", "owner", {}), pathCtx("concepts/pricing.md"));
    expect(onPage.status).toBe(405);
    const page = await pageGET(req("GET", "/pages/merge", "owner"), pathCtx("merge"));
    expect(page.status).toBe(200);
    expect((await page.json()).path).toBe("merge.md");
  });

  it("lists pages by owner", async () => {
    await ensureVault();
    await seed();
    const mine = await (await pagesGET(req("GET", "/pages?owner=SALES-team", "assistant"))).json();
    expect(mine.pages.map((p: { path: string }) => p.path)).toEqual(["concepts/pricing.md"]);
    const none = await (await pagesGET(req("GET", "/pages?owner=support", "assistant"))).json();
    expect(none.total).toBe(0);
  });
});

describe("claims", () => {
  it("adds a claim with an allocated id, refuses one another page holds, edits and deletes it", async () => {
    await ensureVault();
    await seed();
    const added = await claimsPOST(req("POST", "/claims", "assistant", { page: "concepts/pricing.md", text: "The green widget costs 9 EUR.", confidence: 0.6 }));
    expect(added.status).toBe(201);
    const { id } = await added.json();
    expect(id).toBe("acme-sales/widget-pricing/the-green-widget-costs-9-eur");
    expect(log()[0]).toBe(`ClawBox assistant|Prime Radiant|claim: add ${id}`);
    expect(read("concepts/pricing.md")).toContain("stated by assistant");

    const same = await claimsPOST(req("POST", "/claims", "assistant", { page: "concepts/pricing.md", text: "Again.", id }));
    expect((await same.json()).code).toBe("exists");

    const edited = await claimPATCH(req("PATCH", `/claims/${id}`, "assistant", { text: "The green widget costs 8 EUR." }), idCtx(id));
    expect(edited.status).toBe(200);
    expect(read("concepts/pricing.md")).toContain("The green widget costs 8 EUR.");
    expect(log()[0]).toBe(`ClawBox assistant|Prime Radiant|claim: edit ${id}`);

    const gone = await claimDELETE(req("DELETE", `/claims/${id}`, "assistant"), idCtx(id));
    expect(await gone.json()).toMatchObject({ id, page: "concepts/pricing.md", wasVerified: false });
    expect(read("concepts/pricing.md")).not.toContain(id);
    // Removed, not retired: the page keeps no retirement, so undoing the delete is allowed.
    expect(read("concepts/pricing.md")).toContain("retiredClaimIds: []");
  });

  it("refuses to edit a verified claim's text, and a bad claim id or confidence", async () => {
    await ensureVault();
    await seed();
    const res = await claimPATCH(req("PATCH", `/claims/${VERIFIED.id}`, "assistant", { text: "The red widget costs 1 EUR." }), idCtx(VERIFIED.id));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("verified");
    expect((await claimPATCH(req("PATCH", "/claims/Not/A/Claim", "assistant", { text: "x" }), idCtx("Not/A/Claim"))).status).toBe(400);
    expect((await claimsPOST(req("POST", "/claims", "assistant", { page: "concepts/pricing.md", text: "x", confidence: 3 }))).status).toBe(400);
    expect((await claimDELETE(req("DELETE", "/claims/acme-sales/pricing/none", "assistant"), idCtx("acme-sales/pricing/none"))).status).toBe(404);
  });

  it("verifies a claim as it stands: the stamp and the commit say the assistant, checked_by stays", async () => {
    await ensureVault();
    await seed();
    const res = await verifyPOST(req("POST", "/claims/verify", "assistant", { id: PRICE.id }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ claimId: PRICE.id, page: "concepts/pricing.md" });
    expect(log()[0]).toBe(`ClawBox assistant|Prime Radiant|verify: ${PRICE.id}`);
    const text = read("concepts/pricing.md");
    expect(text).toContain("by: assistant");
    expect(text).toContain("checked_by: flash");
    const owners = await verifyPOST(req("POST", "/claims/verify", "owner", { id: PRICE.id, text: "The blue widget costs 11 EUR." }));
    expect(owners.status).toBe(200);
    expect(read("concepts/pricing.md")).toContain("checked_by: human");
    expect(log()[0]).toBe(`Prime Radiant|Prime Radiant|verify: ${PRICE.id}`);
  });

  it("stamps a verification the assistant makes on the owner's confirmation as the owner's, via the assistant", async () => {
    await ensureVault();
    await seed();
    const res = await verifyPOST(req("POST", "/claims/verify", "assistant", { id: PRICE.id, confirm: true }));
    expect(res.status).toBe(200);
    // The assistant made the commit; the stamp says whose word it was.
    expect(log()[0]).toBe(`ClawBox assistant|Prime Radiant|verify: ${PRICE.id}`);
    const page = parsePage(read("concepts/pricing.md"));
    if (!page.ok) throw new Error("page does not parse");
    const verified = page.frontmatter.claims.find((c) => c.id === PRICE.id);
    expect(verified?.verified).toMatchObject({ by: "owner", via: "assistant" });
    expect(verified?.evidence.at(-1)).toMatchObject({ kind: "human-verification", note: "verified by owner via assistant" });
    expect(page.frontmatter.checked_by).toBe("human");
    expect(ownerVerified(verified!)).toBe(true);
    // History reads who verified from the commit's trailers.
    const [head] = await logForPath(vault, "concepts/pricing.md", 1);
    expect(head).toMatchObject({ subject: `verify: ${PRICE.id}`, author: "ClawBox assistant", verified: { by: "owner", via: "assistant" } });
    // `confirm` is a yes or a no, nothing else.
    expect((await verifyPOST(req("POST", "/claims/verify", "assistant", { id: PRICE.id, confirm: "yes" }))).status).toBe(400);
  });

  it("keeps a confirm from the owner's own browser the owner's, with no via", async () => {
    await ensureVault();
    await seed();
    expect((await verifyPOST(req("POST", "/claims/verify", "owner", { id: PRICE.id, confirm: true }))).status).toBe(200);
    const [head] = await logForPath(vault, "concepts/pricing.md", 1);
    expect(head.verified).toEqual({ by: "owner" });
    expect(read("concepts/pricing.md")).not.toContain("via: assistant");
  });
});

describe("commitAuthorEmail", () => {
  it("reads a commit's author, and never takes the argument for an option", async () => {
    await ensureVault();
    await seed();
    const head = execFileSync("git", ["-C", vault, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(await commitAuthorEmail(vault, head)).toBe("prime-radiant@localhost");
    // `--all` as a revision is no revision; as an option it would read the newest commit's author.
    expect(await commitAuthorEmail(vault, "--all")).toBeNull();
  });
});

describe("undo, review and passes for the assistant", () => {
  it("lets the assistant undo its own commit but not the owner's, which the owner may undo", async () => {
    await ensureVault();
    await seed();
    await pagePATCH(req("PATCH", "/pages/concepts/pricing.md", "assistant", { title: "Prices" }), pathCtx("concepts/pricing.md"));
    const [mine, seeded] = execFileSync("git", ["-C", vault, "log", "-2", "--format=%H"], { encoding: "utf8" }).trim().split("\n");

    const refused = await revertPOST(req("POST", "/revert", "assistant", { commit: seeded }));
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("owner_only");

    const undone = await revertPOST(req("POST", "/revert", "assistant", { commit: mine, path: "concepts/pricing.md" }));
    expect(undone.status).toBe(200);
    expect(log()[0]).toMatch(/^ClawBox assistant\|Prime Radiant\|revert: /);
    expect(read("concepts/pricing.md")).toContain("title: Widget pricing");

    // The owner undoes whatever it likes — here the assistant's own undo.
    const assistantsUndo = execFileSync("git", ["-C", vault, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const ownerUndo = await revertPOST(req("POST", "/revert", "owner", { commit: assistantsUndo }));
    expect(ownerUndo.status).toBe(200);
    expect(log()[0]).toMatch(/^Prime Radiant\|Prime Radiant\|revert: /);
    expect(read("concepts/pricing.md")).toContain("title: Prices");
  });

  it("lets the assistant settle a review item, stamped and authored as the assistant", async () => {
    await ensureVault();
    await seed();
    const { item } = addReviewItem(vault, {
      kind: "contradiction",
      claimId: PRICE.id,
      pages: ["concepts/pricing.md"],
      candidates: [
        { text: "The blue widget costs 10 EUR.", page: "concepts/pricing.md", claimId: PRICE.id, evidence: [] },
        { text: "The blue widget costs 12 EUR.", page: null, evidence: [] },
      ],
    });
    const res = await resolvePOST(req("POST", `/review/${item.id}/resolve`, "assistant", { action: "pick", candidate: 1 }), reviewCtx(item.id));
    expect(res.status).toBe(200);
    expect((await res.json()).item.resolution).toMatchObject({ action: "pick", by: "assistant" });
    expect(log()[0]).toBe(`ClawBox assistant|Prime Radiant|verify: ${PRICE.id}`);
    expect(read("concepts/pricing.md")).toContain("The blue widget costs 12 EUR.");
  });

  it("settles a review item the user told the assistant how to settle as the owner's answer, via the assistant", async () => {
    await ensureVault();
    await seed();
    const { item } = addReviewItem(vault, {
      kind: "contradiction",
      claimId: PRICE.id,
      pages: ["concepts/pricing.md"],
      candidates: [
        { text: "The blue widget costs 10 EUR.", page: "concepts/pricing.md", claimId: PRICE.id, evidence: [] },
        { text: "The blue widget costs 12 EUR.", page: null, evidence: [] },
      ],
    });
    const res = await resolvePOST(req("POST", `/review/${item.id}/resolve`, "assistant", { action: "pick", candidate: 1, confirm: true }), reviewCtx(item.id));
    expect(res.status).toBe(200);
    expect((await res.json()).item.resolution).toMatchObject({ action: "pick", by: "owner", via: "assistant" });
    expect(log()[0]).toBe(`ClawBox assistant|Prime Radiant|verify: ${PRICE.id}`);
    const page = parsePage(read("concepts/pricing.md"));
    if (!page.ok) throw new Error("page does not parse");
    const verified = page.frontmatter.claims.find((c) => c.id === PRICE.id);
    expect(verified).toMatchObject({ text: "The blue widget costs 12 EUR.", verified: { by: "owner", via: "assistant" } });
    expect(verified?.evidence.at(-1)?.note).toBe(`verified by owner via assistant from review ${item.id}`);
    expect(ownerVerified(verified!)).toBe(true);
  });

  it("lets the assistant run the connect pass, and only that pass", async () => {
    await ensureVault();
    await seed();
    for (const action of ["reindex", "rejudge-reviews", "migrate-frontmatter", "rename-slugs", "upgrade-assistant-verifications"]) {
      const res = await maintenancePOST(req("POST", "/maintenance", "assistant", { action, dryRun: true }));
      expect(res.status, action).toBe(403);
      expect((await res.json()).code).toBe("owner_only");
    }
    const dry = await maintenancePOST(req("POST", "/maintenance", "assistant", { action: "connect", dryRun: true }));
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({ dryRun: true });
  });

  it("lets the owner rename meaningless pages and upgrade the assistant's confirmed verifications, dry run first", async () => {
    await ensureVault();
    await vaultOperation("seed: legacy pages", async (tx) => {
      const assistants = claim("bg-legal/x/term", "Договорът е за 12 месеца.", {
        status: "verified",
        confidence: 1,
        verified: { at: "2026-09-01T00:00:00.000Z", by: "assistant" },
        evidence: [{ kind: "human-verification", note: "verified by assistant", updatedAt: "2026-09-01T00:00:00.000Z" }],
      });
      await tx.write("concepts/x-3.md", pageText({ title: "Граждански договор — Иван Иванов", claims: [assistants] }, "Договор за услуги.\n"));
      await tx.write("concepts/pricing.md", pageText({ claims: [PRICE] }, "Prices. See [[concepts/x-3]] and [[x-3|the contract]].\n"));
      await tx.write("index.md", "# Index\n\n- [[concepts/pricing]] — Widget pricing\n- [[concepts/x-3]] — Граждански договор — Иван Иванов\n");
    });
    const head = () => execFileSync("git", ["-C", vault, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const before = head();

    const dryRename = await maintenancePOST(req("POST", "/maintenance", "owner", { action: "rename-slugs", dryRun: true }));
    expect(dryRename.status).toBe(200);
    expect(await dryRename.json()).toMatchObject({ dryRun: true, commit: null, renamed: [{ from: "concepts/x-3.md", to: "concepts/grazhdanski-dogovor-ivan-ivanov.md" }], links: 3 });
    expect(head()).toBe(before);

    const rename = await maintenancePOST(req("POST", "/maintenance", "owner", { action: "rename-slugs" }));
    expect(rename.status).toBe(200);
    expect(await rename.json()).toMatchObject({ dryRun: false, renamed: [{ to: "concepts/grazhdanski-dogovor-ivan-ivanov.md" }] });
    expect(log()[0]).toBe("Prime Radiant|Prime Radiant|rename: 1 page with meaningless names");
    expect(fs.existsSync(path.join(vault, "concepts/x-3.md"))).toBe(false);
    expect(read("concepts/pricing.md")).toContain("See [[concepts/grazhdanski-dogovor-ivan-ivanov]] and [[concepts/grazhdanski-dogovor-ivan-ivanov|the contract]].");
    expect(read("index.md")).toContain("- [[concepts/grazhdanski-dogovor-ivan-ivanov]] — Граждански договор");

    const dryUpgrade = await maintenancePOST(req("POST", "/maintenance", "owner", { action: "upgrade-assistant-verifications", dryRun: true }));
    expect(await dryUpgrade.json()).toMatchObject({ dryRun: true, commit: null, upgraded: [{ claimId: "bg-legal/x/term", page: "concepts/grazhdanski-dogovor-ivan-ivanov.md" }] });
    expect(read("concepts/grazhdanski-dogovor-ivan-ivanov.md")).toContain("by: assistant");

    const upgrade = await maintenancePOST(req("POST", "/maintenance", "owner", { action: "upgrade-assistant-verifications" }));
    expect(upgrade.status).toBe(200);
    expect(await upgrade.json()).toMatchObject({ dryRun: false, upgraded: [{ claimId: "bg-legal/x/term" }], pages: ["concepts/grazhdanski-dogovor-ivan-ivanov.md"] });
    expect(log()[0]).toBe("Prime Radiant|Prime Radiant|migrate: 1 assistant verification -> owner via the assistant");
    expect(read("concepts/grazhdanski-dogovor-ivan-ivanov.md")).toContain("via: assistant");
    // Run again: nothing left to do, nothing committed.
    const again = await maintenancePOST(req("POST", "/maintenance", "owner", { action: "upgrade-assistant-verifications" }));
    expect(await again.json()).toMatchObject({ commit: null, upgraded: [] });
  });

  it("names the assistant on the commits of a connect pass it started", async () => {
    await ensureVault();
    await seed();
    // A second page that names the first, so the pass has a link to write.
    await vaultOperation("seed: catalogue", async (tx) => {
      await tx.write("concepts/catalogue.md", pageText({ title: "Catalogue", domain: "acme-sales" }, "The catalogue lists Widget pricing for every size.\n"));
    });
    const seeded = log()[0];
    const res = await maintenancePOST(req("POST", "/maintenance", "assistant", { action: "connect" }));
    expect(res.status).toBe(202);
    for (let i = 0; i < 100; i++) {
      const state = await (await maintenanceGET(req("GET", "/maintenance", "assistant"))).json();
      if (!state.running) {
        expect(state.last.connect.error).toBeUndefined();
        expect(state.last.connect.commits.length).toBeGreaterThan(0);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const commits = log(20);
    const since = commits.slice(0, commits.indexOf(seeded));
    expect(since.length).toBeGreaterThan(0);
    for (const c of since) expect(c).toMatch(/^ClawBox assistant\|Prime Radiant\|connect/);
  });
});
