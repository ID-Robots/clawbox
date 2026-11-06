/**
 * POST /setup-api/prime-radiant/pages/bulk — metadata (domain, owner,
 * privacy, status) set on many pages in ONE commit, over a real vault in a
 * tmp dir: a page its own PATCH would refuse is listed in `refused` and the
 * rest still change; a dry run commits nothing; the assistant's commit names
 * it; Undo takes the whole edit back.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { GET as pageGET, POST as pagePOST } from "@/app/setup-api/prime-radiant/pages/[...path]/route";
import { POST as revertPOST } from "@/app/setup-api/prime-radiant/revert/route";
import { MAX_BULK_EDITS } from "@/lib/prime-radiant/edit";
import { ensureVault, vaultOperation } from "@/lib/prime-radiant/vault";
import { claim, pageText } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-bulk-routes-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;
let vault = "";

const ORIGIN = "http://clawbox.local";
type As = "owner" | "assistant" | "nobody";

function req(as: As, body: unknown) {
  const who: Record<string, string> = as === "assistant" ? { authorization: "Bearer test-assistant-bearer" } : as === "owner" ? { origin: ORIGIN } : {};
  owner.hasPersonSession.mockResolvedValue(as === "owner");
  return new Request(`${ORIGIN}/setup-api/prime-radiant/pages/bulk`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...who },
  });
}
const BULK = { params: Promise.resolve({ path: ["bulk"] }) };
const bulk = async (as: As, body: unknown) => {
  const res = await pagePOST(req(as, body), BULK);
  return { status: res.status, body: await res.json() };
};

function git(...args: string[]): string {
  return execFileSync("git", ["-C", vault, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
  }).trim();
}
/** `<author>|<committer>|<subject>` of the vault's commits, newest first. */
const log = (limit = 1) => git("log", `-${limit}`, "--format=%an|%cn|%s").split("\n");
const read = (rel: string) => fs.readFileSync(path.join(vault, rel), "utf8");
/** A page file's body: everything after its frontmatter. */
const bodyOf = (text: string) => text.slice(text.indexOf("\n---\n") + 5);

const PRICE = claim("acme-sales/pricing/blue-widget", "The blue widget costs 10 EUR.", { status: "proposed" });
const PAGES = ["concepts/pricing.md", "concepts/shipping.md", "concepts/support.md", "concepts/verified.md", "concepts/broken.md"];

async function seed() {
  await vaultOperation("seed: pages", async (tx) => {
    // A body with memory-wiki's managed block: a bulk edit keeps it, byte for byte.
    await tx.write("concepts/pricing.md", pageText({ claims: [PRICE] }, "Widget prices in brief.\n\n## Details\n\nSee [[concepts/shipping]].\n\n<!-- openclaw:wiki:related:start -->\n## Related\n- [[concepts/support]]\n<!-- openclaw:wiki:related:end -->\n"));
    await tx.write("concepts/shipping.md", pageText({ title: "Shipping" }, "Shipping is priced per parcel.\n"));
    await tx.write("concepts/support.md", pageText({ title: "Support", domain: "support" }, "Support answers within a day.\n"));
    await tx.write("concepts/verified.md", pageText({ title: "Price list", verified: { at: "2026-02-01T00:00:00.000Z", by: "owner" } }, "The price list as the owner gave it.\n"));
    await tx.write("index.md", `# Index\n\n${PAGES.slice(0, 4).map((p) => `- [[${p.replace(/\.md$/, "")}]]`).join("\n")}\n`);
  });
  // A page whose frontmatter does not parse, as a hand edit would leave it.
  fs.writeFileSync(path.join(vault, "concepts/broken.md"), "---\ntitle: [unclosed\n---\nBroken.\n");
  git("add", "-A");
  git("-c", "user.name=Prime Radiant", "-c", "user.email=prime-radiant@localhost", "commit", "--quiet", "-m", "seed: broken page");
}

const MIXED = {
  edits: [
    { path: "concepts/pricing.md", domain: "billing", owner: "finance-team" },
    { path: "concepts/shipping", privacy: "confidential", status: "stable" },
    { path: "concepts/support.md", domain: "support" },
    { path: "concepts/verified.md", domain: "billing" },
    { path: "concepts/nope.md", domain: "billing" },
    { path: "concepts/support.md", owner: "someone-else" },
    { path: "concepts/broken.md", owner: "finance-team" },
    { path: "entities/acme.md", domain: "Not A Domain" },
    { path: "entities/acme.md", colour: "blue" },
  ],
};

beforeEach(async () => {
  auth.requireSession.mockReset().mockResolvedValue(null);
  owner.hasPersonSession.mockReset().mockResolvedValue(true);
  shard.scheduleReindexAfterCommit.mockReset();
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
  vault = path.join(process.env.PRIME_RADIANT_DIR, "vault");
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("POST pages/bulk", () => {
  it("applies every edit it can in ONE commit the assistant authors, and lists each refused page with its own code", async () => {
    await ensureVault();
    await seed();
    const before = Object.fromEntries(PAGES.map((p) => [p, read(p)]));
    const head = log()[0];
    // The seed's own reindex is scheduled in the background: let it arrive first.
    await vi.waitFor(() => expect(shard.scheduleReindexAfterCommit).toHaveBeenCalledTimes(1));
    shard.scheduleReindexAfterCommit.mockClear();

    const res = await bulk("assistant", MIXED);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: ["concepts/pricing.md", "concepts/shipping.md"], unchanged: ["concepts/support.md"], dryRun: false });
    expect(res.body.refused.map((r: { path: string; code: string }) => [r.path, r.code])).toEqual([
      ["concepts/verified.md", "verified"],
      ["concepts/nope.md", "not_found"],
      ["concepts/support.md", "invalid"],
      ["concepts/broken.md", "invalid_page"],
      ["entities/acme.md", "invalid"],
      ["entities/acme.md", "invalid"],
    ]);
    expect(res.body.refused[2].error).toMatch(/named more than once/);
    expect(res.body.refused[4].error).toMatch(/domain is lowercase kebab-case/);
    expect(res.body.refused[5].error).toMatch(/Unknown field: colour/);
    expect(res.body.commit).toMatch(/^[0-9a-f]{40}$/);

    // Exactly one commit, naming the assistant, touching exactly the two pages.
    expect(log(2)).toEqual(["ClawBox assistant|Prime Radiant|bulk: 2 pages", head]);
    expect(git("show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["concepts/pricing.md", "concepts/shipping.md"]);

    const pricing = read("concepts/pricing.md");
    expect(pricing).toContain("domain: billing\nowner: finance-team\n");
    expect(pricing).toContain("by: assistant");
    expect(pricing).toContain(PRICE.id);
    // Only the frontmatter changed: the body, memory-wiki's block included, is the bytes it was.
    expect(bodyOf(pricing)).toBe(bodyOf(before["concepts/pricing.md"]));
    const shipping = read("concepts/shipping.md");
    expect(shipping).toContain("status: stable");
    expect(shipping).toContain("privacy: confidential");
    expect(bodyOf(shipping)).toBe(bodyOf(before["concepts/shipping.md"]));
    for (const p of ["concepts/support.md", "concepts/verified.md", "concepts/broken.md"]) expect(read(p), p).toBe(before[p]);
    // Nothing Memory Shard embeds changed: no reindex.
    await new Promise((r) => setTimeout(r, 50));
    expect(shard.scheduleReindexAfterCommit).not.toHaveBeenCalled();

    // Undo takes the whole edit back.
    const undone = await revertPOST(
      new Request(`${ORIGIN}/setup-api/prime-radiant/revert`, { method: "POST", body: JSON.stringify({ commit: res.body.commit }), headers: { "content-type": "application/json", authorization: "Bearer test-assistant-bearer" } }),
    );
    expect(undone.status).toBe(200);
    expect(Object.fromEntries(PAGES.map((p) => [p, read(p)]))).toEqual(before);
  });

  it("answers a dry run the same and writes nothing", async () => {
    await ensureVault();
    await seed();
    const before = Object.fromEntries(PAGES.map((p) => [p, read(p)]));
    const head = log()[0];
    const dry = await bulk("assistant", { ...MIXED, dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ changed: ["concepts/pricing.md", "concepts/shipping.md"], unchanged: ["concepts/support.md"], commit: null, dryRun: true });
    expect(dry.body.refused).toHaveLength(6);
    expect(log()[0]).toBe(head);
    expect(git("status", "--porcelain")).toBe("");
    expect(Object.fromEntries(PAGES.map((p) => [p, read(p)]))).toEqual(before);

    const real = await bulk("assistant", MIXED);
    expect({ ...real.body, commit: null, dryRun: true }).toEqual(dry.body);
  });

  it("lets the owner re-tag a page a person verified, which the assistant may not; one page says so", async () => {
    await ensureVault();
    await seed();
    const refused = await bulk("assistant", { edits: [{ path: "concepts/verified.md", domain: "billing" }] });
    expect(refused.body).toMatchObject({ changed: [], unchanged: [], commit: null, refused: [{ path: "concepts/verified.md", code: "verified" }] });
    const res = await bulk("owner", { edits: [{ path: "concepts/verified.md", domain: "billing" }] });
    expect(res.body).toMatchObject({ changed: ["concepts/verified.md"], refused: [] });
    expect(log()[0]).toBe("Prime Radiant|Prime Radiant|bulk: 1 page");
    expect(read("concepts/verified.md")).toContain("verified:\n  at: 2026-02-01T00:00:00.000Z\n  by: owner\n");
  });

  it("refuses alone a page its new metadata would make break a blocking rule, and still changes the rest", async () => {
    await ensureVault();
    await seed();
    const before = read("concepts/shipping.md");
    const secret = "ghp" + "_" + "Ab3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5";
    const res = await bulk("assistant", { edits: [{ path: "concepts/shipping.md", owner: secret }, { path: "concepts/pricing.md", domain: "billing" }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: ["concepts/pricing.md"], refused: [{ path: "concepts/shipping.md", code: "lint_blocked" }] });
    expect(res.body.refused[0].error).toMatch(/secret-pattern/);
    expect(read("concepts/shipping.md")).toBe(before);
    expect(log()[0]).toBe("ClawBox assistant|Prime Radiant|bulk: 1 page");
  });

  it("judges each page for what the edit did to it: a claim id two listed pages already shared refuses neither, as their own PATCHes would not", async () => {
    await ensureVault();
    await seed();
    // Written past the lint, as a hand edit would.
    await vaultOperation("seed: shared claim id", async (tx) => tx.write("concepts/shipping.md", pageText({ title: "Shipping", claims: [PRICE] }, "Shipping is priced per parcel.\n")), { lint: false });
    const res = await bulk("assistant", { edits: [{ path: "concepts/pricing.md", domain: "billing" }, { path: "concepts/shipping.md", domain: "billing" }] });
    expect(res.body).toMatchObject({ changed: ["concepts/pricing.md", "concepts/shipping.md"], refused: [] });
    expect(log()[0]).toBe("ClawBox assistant|Prime Radiant|bulk: 2 pages");

    // A page index.md does not list is judged against the whole vault, and the shared id then refuses it alone.
    await vaultOperation("seed: unlisted copy", async (tx) => tx.write("concepts/copy.md", pageText({ title: "Copy", claims: [PRICE] }, "A copy.\n")), { lint: false });
    const unlisted = await bulk("assistant", { edits: [{ path: "concepts/copy.md", owner: "finance-team" }, { path: "concepts/support.md", owner: "finance-team" }] });
    expect(unlisted.body).toMatchObject({ changed: ["concepts/support.md"], refused: [{ path: "concepts/copy.md", code: "lint_blocked" }] });
    expect(unlisted.body.refused[0].error).toMatch(/claim-id-collision/);
    expect(log()[0]).toBe("ClawBox assistant|Prime Radiant|bulk: 1 page");
  });

  it("refuses alone an edit that is no object or names no path, and still applies the rest", async () => {
    await ensureVault();
    await seed();
    const res = await bulk("assistant", { edits: ["concepts/pricing.md", null, { path: 42, owner: "x" }, { path: "../index.md", owner: "x" }, { path: "concepts/pricing.md" }, { path: "concepts/support.md", owner: "finance-team" }] });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(["concepts/support.md"]);
    expect(res.body.refused.map((r: { path: string; code: string }) => [r.path, r.code])).toEqual([
      ["", "invalid"],
      ["", "invalid"],
      ["", "invalid"],
      ["../index.md", "not_found"],
      ["concepts/pricing.md", "invalid"],
    ]);
    expect(res.body.refused[4].error).toMatch(/Name at least one of domain, owner, privacy, status/);
    expect(log()[0]).toBe("ClawBox assistant|Prime Radiant|bulk: 1 page");
  });

  it("refuses alone, as not_found, a path deeper than the vault's walk reaches — the dry run and the real run alike", async () => {
    await ensureVault();
    await seed();
    const deep = `${Array.from({ length: 10 }, (_, i) => `d${i}`).join("/")}/page.md`;
    const edits = [{ path: deep, owner: "x" }, { path: "concepts/support.md", owner: "finance-team" }];
    const dry = await bulk("assistant", { edits, dry_run: true });
    const real = await bulk("assistant", { edits });
    for (const res of [dry, real]) {
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ changed: ["concepts/support.md"], refused: [{ path: deep, code: "not_found" }] });
    }
    expect(log()[0]).toBe("ClawBox assistant|Prime Radiant|bulk: 1 page");
  });

  it("refuses an unlisted page whose claim id a listed page in the same batch carries, and still changes the listed one", async () => {
    await ensureVault();
    await seed();
    // index.md does not list the copy; it carries the claim id concepts/pricing.md does (written past the lint, as a hand edit would).
    await vaultOperation("seed: unlisted copy", async (tx) => tx.write("concepts/copy.md", pageText({ title: "Copy", claims: [PRICE] }, "A copy.\n")), { lint: false });
    const before = read("concepts/copy.md");
    const res = await bulk("assistant", { edits: [{ path: "concepts/copy.md", domain: "billing" }, { path: "concepts/pricing.md", domain: "billing" }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: ["concepts/pricing.md"], unchanged: [], refused: [{ path: "concepts/copy.md", code: "lint_blocked" }] });
    expect(res.body.refused[0].error).toMatch(/claim-id-collision/);
    expect(read("concepts/copy.md")).toBe(before);
    expect(read("concepts/pricing.md")).toContain("domain: billing");
    expect(log()[0]).toBe("ClawBox assistant|Prime Radiant|bulk: 1 page");
  });

  it("judges a listed page on its own even when an unlisted page in the batch sends the lint to the whole vault", async () => {
    await ensureVault();
    await seed();
    // concepts/shipping.md (left out of the batch) already shares a claim id with concepts/pricing.md; concepts/loose.md is unlisted and carries none.
    await vaultOperation(
      "seed: shared claim id, unlisted page",
      async (tx) => {
        await tx.write("concepts/shipping.md", pageText({ title: "Shipping", claims: [PRICE] }, "Shipping is priced per parcel.\n"));
        await tx.write("concepts/loose.md", pageText({ title: "Loose" }, "Nobody lists this page.\n"));
      },
      { lint: false },
    );
    const res = await bulk("assistant", { edits: [{ path: "concepts/loose.md", owner: "finance-team" }, { path: "concepts/pricing.md", owner: "finance-team" }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: ["concepts/loose.md", "concepts/pricing.md"], refused: [] });
    expect(log()[0]).toBe("ClawBox assistant|Prime Radiant|bulk: 2 pages");
  });

  it("commits nothing when every page already says what the edit asks", async () => {
    await ensureVault();
    await seed();
    const head = log()[0];
    const res = await bulk("assistant", { edits: [{ path: "concepts/support.md", domain: "support" }, { path: "concepts/pricing.md", owner: "sales-team" }] });
    expect(res.body).toEqual({ changed: [], unchanged: ["concepts/support.md", "concepts/pricing.md"], refused: [], commit: null, dryRun: false });
    expect(log()[0]).toBe(head);
  });

  it("reads the request itself strictly, and keeps the same writers as PATCH", async () => {
    await ensureVault();
    await seed();
    const head = log()[0];
    const tooMany = Array.from({ length: MAX_BULK_EDITS + 1 }, (_, i) => ({ path: `concepts/p-${i}.md`, owner: "x" }));
    for (const body of [{}, { edits: [] }, { edits: "concepts/pricing.md" }, { edits: tooMany }, { edits: [{ path: "concepts/pricing.md", owner: "x" }], dry_run: "yes" }, { edits: [{ path: "concepts/pricing.md", owner: "x" }], force: true }]) {
      const res = await bulk("assistant", body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.body.code).toBe("invalid");
    }
    expect((await bulk("assistant", "{not json")).status).toBe(400);
    expect((await bulk("nobody", MIXED)).body.code).toBe("owner_only");
    const crossSite = await pagePOST(
      new Request(`${ORIGIN}/setup-api/prime-radiant/pages/bulk`, { method: "POST", body: JSON.stringify(MIXED), headers: { "content-type": "application/json", origin: "https://elsewhere.example" } }),
      BULK,
    );
    expect(crossSite.status).toBe(403);
    // 500 edits with long paths fit the body limit; a page at bulk.md is still a page to GET.
    const full = Array.from({ length: MAX_BULK_EDITS }, (_, i) => ({ path: `concepts/${"long-name-".repeat(20)}${i}.md`, owner: "finance-team" }));
    const many = await bulk("assistant", { edits: full });
    expect(many.status).toBe(200);
    expect(many.body.refused).toHaveLength(MAX_BULK_EDITS);
    expect(log()[0]).toBe(head);
    await vaultOperation("seed: bulk.md", async (tx) => tx.write("bulk.md", pageText({ title: "Bulk orders" }, "How bulk orders work.\n")));
    const page = await pageGET(new Request(`${ORIGIN}/setup-api/prime-radiant/pages/bulk`, { headers: { origin: ORIGIN } }), BULK);
    expect((await page.json()).path).toBe("bulk.md");
  });

  it("answers 412 before the vault exists", async () => {
    const res = await bulk("assistant", MIXED);
    expect(res.status).toBe(412);
    expect(res.body.code).toBe("not_initialised");
  });
});
