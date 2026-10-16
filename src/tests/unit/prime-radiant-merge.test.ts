/**
 * Merging duplicate pages (edit.ts `mergePages`) over a REAL git vault in a
 * tmp dir: the claims move intact, the names and sources join the page that
 * stays, every link form in every page leads to it, the merged pages and their
 * index lines go — one commit, which Undo takes back whole. The page that
 * stays keeps its body byte for byte unless the caller lets it change. Every
 * name in the fixtures is invented.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The vault's Memory Shard index: stubbed (it embeds), pinned in its own suite.
const shard = vi.hoisted(() => ({ scheduleReindexAfterCommit: vi.fn() }));
vi.mock("@/lib/prime-radiant/shard-index", () => shard);

import { mergePages, PageEditError, readPageMerge, type EditWho, type PageMerge } from "@/lib/prime-radiant/edit";
import { ASSISTANT_AUTHOR, git, headCommit } from "@/lib/prime-radiant/git";
import { revertCommit } from "@/lib/prime-radiant/history";
import { createLinkResolver, extractLinks, relativeHref, rewriteLinks } from "@/lib/prime-radiant/links";
import { lintVault } from "@/lib/prime-radiant/lint";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { addReviewItem, getReviewItem } from "@/lib/prime-radiant/review-store";
import { withStateDb } from "@/lib/prime-radiant/state-db";
import { splitFrontmatter } from "@/lib/prime-radiant/frontmatter";
import { readPage, readVaultSnapshot, vaultOperation, type VaultSnapshot } from "@/lib/prime-radiant/vault";
import type { PageFrontmatter } from "@/lib/prime-radiant/schema";
import { claim, pageText } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-merge-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;
let vault = "";

const OWNER: EditWho = { by: "owner", person: true };
const ASSISTANT: EditWho = { by: "assistant", author: ASSISTANT_AUTHOR, person: false };
const NOW = new Date("2026-03-01T12:00:00.000Z");

const INTO = "entities/acme.md";
const GMBH = "entities/acme-widgets-gmbh.md";
const LEGACY = "concepts/acme-legacy.md";
const DUP = "entities/acme-copy.md";
const INTO_BODY = "Acme Widgets Ltd makes widgets in three sizes.\n\nShipping: [[concepts/shipping]].\n";

const FOUNDED = claim("acme-sales/acme-widgets-ltd/founded", "Acme Widgets Ltd was founded in 1999.");
const BERLIN = claim("acme-sales/acme-widgets-gmbh/based-in-berlin", "Acme Widgets GmbH is based in Berlin.", { status: "proposed" });
const REGISTERED = claim("acme-sales/acme-widgets-gmbh/registered", "Acme Widgets GmbH was registered in 2004.", {
  status: "verified",
  confidence: 1,
  verified: { at: "2026-02-01T00:00:00.000Z", by: "owner" },
  evidence: [{ kind: "human-verification", note: "verified by owner", updatedAt: "2026-02-01T00:00:00.000Z" }],
});
const LEGACY_NAME = claim("acme-sales/acme-old/legacy-name", "Acme Widgets Ltd traded as Acme Tools until 2001.");
const GONE = "acme-sales/acme-old/first-office";

const PRICING_BODY = [
  "Widget prices for [[Acme Widgets GmbH]] and [[entities/acme-widgets-gmbh|the GmbH]].",
  "",
  "- [[acme-widgets-gmbh#Details]]",
  "- [[concepts/acme-legacy#History|old notes]]",
  '- [German arm](../entities/acme-widgets-gmbh.md#details "GmbH")',
  "- [old](acme-legacy.md)",
  "- [also old](./acme-legacy.md)",
  "- `[[concepts/acme-legacy]]` is how a link is written.",
  "- [[entities/acme]] and [[concepts/shipping]] stay.",
  "",
].join("\n");

const PRICING_MERGED = [
  "Widget prices for [[entities/acme|Acme Widgets GmbH]] and [[entities/acme|the GmbH]].",
  "",
  "- [[entities/acme#Details|acme-widgets-gmbh]]",
  "- [[entities/acme#History|old notes]]",
  '- [German arm](../entities/acme.md#details "GmbH")',
  "- [old](../entities/acme.md)",
  "- [also old](../entities/acme.md)",
  "- `[[concepts/acme-legacy]]` is how a link is written.",
  "- [[entities/acme]] and [[concepts/shipping]] stay.",
].join("\n");

const INDEX = [
  "# Index",
  "",
  "- [[entities/acme]] — Acme Widgets Ltd",
  "- [[entities/acme-widgets-gmbh]] — Acme Widgets GmbH",
  "- [[concepts/acme-legacy]] — Acme (old)",
  "- [[concepts/pricing]] — Widget pricing",
  "- [[concepts/shipping]] — Shipping",
  "- [[overview]] — Overview",
  "",
  "The German arm is [[entities/acme-widgets-gmbh|here]].",
  "",
].join("\n");

const entity = (extra: Partial<PageFrontmatter>) => ({ type: "entity" as const, ...extra });

function pages(over: { into?: Partial<PageFrontmatter>; intoBody?: string; gmbh?: Partial<PageFrontmatter> } = {}): Record<string, string> {
  return {
    [INTO]: pageText(entity({ title: "Acme Widgets Ltd", claims: [FOUNDED], sources: ["sources/catalogue.md"], ...over.into }), over.intoBody ?? INTO_BODY),
    [GMBH]: pageText(
      entity({ title: "Acme Widgets GmbH", aliases: ["Acme DE"], claims: [BERLIN, REGISTERED], sources: ["sources/register.md", "sources/catalogue.md"], privacy: "confidential", ...over.gmbh }),
      "Acme Widgets Ltd makes widgets in three sizes.\n\n## Details\n\nThe German arm, see [[entities/acme]].\n",
    ),
    [LEGACY]: pageText(
      { title: "Acme (old)", claims: [LEGACY_NAME], retiredClaimIds: [GONE], sources: ["sources/old-letters.md"] },
      "Acme (old) was the first name of [[Acme Widgets Ltd]]; see [pricing](pricing.md).\n\n## History\n\nRenamed in 2001.\n",
    ),
    "concepts/pricing.md": pageText({ title: "Widget pricing" }, PRICING_BODY),
    "concepts/shipping.md": pageText({ title: "Shipping" }, "Shipping for [[entities/acme]] takes a week.\n"),
    "overview.md": pageText({ type: "reference", title: "Overview" }, "Start at [[Acme (old)]] or [old](concepts/acme-legacy.md).\n"),
  };
}

async function seed(files: Record<string, string> = pages()): Promise<string> {
  const op = await vaultOperation("seed: pages", async (tx) => {
    for (const [p, text] of Object.entries(files)) await tx.write(p, text);
    await tx.write("index.md", INDEX);
  });
  return op.commit!;
}

const MERGE: PageMerge = { into: INTO, from: [GMBH, LEGACY], dryRun: false, keepIntoBody: true };
const LET_BODY_CHANGE: PageMerge = { ...MERGE, keepIntoBody: false };
const read = (rel: string) => fs.readFileSync(path.join(vault, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(vault, rel));

async function frontmatterOf(rel: string): Promise<PageFrontmatter> {
  const page = await readPage(rel, vault);
  if (!page?.parsed.ok) throw new Error(`${rel} does not parse`);
  return page.parsed.frontmatter;
}

async function bodyOf(rel: string): Promise<string> {
  const page = await readPage(rel, vault);
  if (!page) throw new Error(`no ${rel}`);
  return page.parsed.body.trim();
}

/** Every tracked file's text: what Undo must bring back byte for byte. */
async function trackedFiles(): Promise<Record<string, string>> {
  const names = (await git(vault, ["ls-files", "-z"])).stdout.split("\0").filter(Boolean);
  return Object.fromEntries(names.map((p) => [p, read(p)]));
}

/** Links (outside code) in every page and index.md that resolve to no page. */
function brokenLinks(snapshot: VaultSnapshot): string[] {
  const resolver = createLinkResolver(snapshot.pages.map((p) => ({ path: p.path, title: p.parsed.ok ? p.parsed.frontmatter.title : undefined })));
  const out: string[] = [];
  for (const [from, body] of [...snapshot.pages.map((p) => [p.path, p.parsed.body] as const), ["index.md", snapshot.indexBody ?? ""] as const]) {
    for (const link of extractLinks(body)) if (resolver.resolve(from, link) === null) out.push(`${from} -> ${link.target}`);
  }
  return out;
}

const registryPage = (id: string) =>
  withStateDb(vault, (db) => (db.prepare("SELECT page FROM claim_registry WHERE id = ?").get(id) as { page: string } | undefined)?.page ?? null);

beforeEach(() => {
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
  vault = vaultDir();
  shard.scheduleReindexAfterCommit.mockClear();
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("rewriteLinks / relativeHref (pure)", () => {
  it("hands every link form to the callback with its parts, and leaves code and other links alone", () => {
    const body = "[[a]] [[b#h]] [[c|x]] [[d#h|y]] [t](e.md#f \"T\") [u](https://example.com/g.md) `[[a]]`\n```\n[[a]]\n```\n";
    const seen: unknown[] = [];
    const out = rewriteLinks(body, (link) => {
      seen.push(link);
      return link.target === "a" ? "[[z]]" : null;
    });
    expect(out).toEqual({ body: body.replace("[[a]] ", "[[z]] "), rewritten: 1 });
    expect(seen).toEqual([
      { kind: "wiki", target: "a", heading: null, alias: null },
      { kind: "wiki", target: "b", heading: "h", alias: null },
      { kind: "wiki", target: "c", heading: null, alias: "x" },
      { kind: "wiki", target: "d", heading: "h", alias: "y" },
      { kind: "md", target: "e.md", text: "t", fragment: "f", title: '"T"' },
    ]);
  });

  it("writes the href from one page to another", () => {
    expect(relativeHref("concepts/pricing.md", "entities/acme.md")).toBe("../entities/acme.md");
    expect(relativeHref("entities/a.md", "entities/acme.md")).toBe("acme.md");
    expect(relativeHref("overview.md", "entities/acme.md")).toBe("entities/acme.md");
    expect(relativeHref("a/b/c.md", "a/d.md")).toBe("../d.md");
    expect(relativeHref("x.md", "notes/Acme widgets 2.md")).toBe("notes/Acme%20widgets%202.md");
  });
});

describe("readPageMerge", () => {
  it("reads the body strictly", () => {
    expect(readPageMerge({ into: "entities/acme", from: ["entities/acme-widgets-gmbh.md", "entities/acme-widgets-gmbh"] })).toEqual({
      into: INTO,
      from: [GMBH],
      dryRun: false,
      keepIntoBody: true,
    });
    expect(readPageMerge({ into: INTO, from: [GMBH], dry_run: true }).dryRun).toBe(true);
    expect(readPageMerge({ into: INTO, from: [GMBH], keep_into_body: false }).keepIntoBody).toBe(false);
    for (const bad of [
      { into: INTO, from: [] },
      { into: INTO, from: Array.from({ length: 21 }, (_, i) => `entities/p${i}.md`) },
      { into: INTO, from: GMBH },
      { into: INTO, from: [GMBH], dry_run: "yes" },
      { into: INTO, from: [GMBH], keep_into_body: "no" },
      { into: INTO, from: [GMBH], force: true },
      { into: INTO, from: [GMBH, INTO] },
      { into: 7, from: [GMBH] },
    ]) {
      expect(() => readPageMerge(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: "invalid", status: 400 }));
    }
    expect(() => readPageMerge({ into: INTO, from: ["../../etc/passwd"] })).toThrow(expect.objectContaining({ code: "not_found", status: 404 }));
  });
});

describe("mergePages", () => {
  it("moves every claim intact onto the page that stays, verification and all, in one commit", async () => {
    await seed();
    const r = await mergePages(MERGE, OWNER, { now: NOW });
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await headCommit(vault))?.subject).toBe(`merge: ${GMBH}, ${LEGACY} -> ${INTO}`);
    expect(r.claims).toEqual([BERLIN.id, REGISTERED.id, LEGACY_NAME.id]);
    expect(r.verified).toEqual([REGISTERED.id]);
    const fm = await frontmatterOf(INTO);
    // The same objects: id, text, status, confidence, evidence and the verification stamp untouched.
    expect(fm.claims).toEqual([FOUNDED, BERLIN, REGISTERED, LEGACY_NAME]);
    // The claim registry follows them, and the commit's pages go to the index.
    for (const c of [BERLIN, REGISTERED, LEGACY_NAME]) expect(registryPage(c.id)).toBe(INTO);
    await vi.waitFor(() => expect(shard.scheduleReindexAfterCommit).toHaveBeenCalledTimes(2));
    expect(shard.scheduleReindexAfterCommit).toHaveBeenLastCalledWith(vault, [LEGACY, "concepts/pricing.md", GMBH, INTO, "index.md", "overview.md"]);
  });

  it("adds the merged pages' titles and aliases, unions the sources, keeps their retirements and the strictest privacy", async () => {
    await seed();
    const r = await mergePages(MERGE, OWNER, { now: NOW });
    const fm = await frontmatterOf(INTO);
    expect(fm.aliases).toEqual(["Acme Widgets GmbH", "Acme DE", "Acme (old)"]);
    expect(r.aliases).toEqual(["Acme Widgets GmbH", "Acme DE", "Acme (old)"]);
    expect(fm.sources).toEqual(["sources/catalogue.md", "sources/register.md", "sources/old-letters.md"]);
    expect(r.sources).toEqual(["sources/register.md", "sources/old-letters.md"]);
    expect(fm.retiredClaimIds).toEqual([GONE]);
    expect(fm.privacy).toBe("confidential");
    expect(r.privacy).toBe("confidential");
    expect(fm.generated).toEqual({ at: NOW.toISOString(), by: "owner" });
    expect(fm.title).toBe("Acme Widgets Ltd");
  });

  it("keeps the staying page's body byte for byte by default: only its frontmatter takes the merge", async () => {
    // A block memory-wiki wrote into the page is part of the bytes kept.
    const managed = `${INTO_BODY}\n<!-- openclaw:wiki:related:start -->\n## Related\n\n- [[concepts/pricing]]\n<!-- openclaw:wiki:related:end -->\n`;
    await seed();
    fs.writeFileSync(path.join(vault, INTO), pages({ intoBody: managed })[INTO]);
    await git(vault, ["commit", "-qam", "plugin block"]);
    const before = splitFrontmatter(read(INTO)).body;
    const r = await mergePages(MERGE, OWNER, { now: NOW });
    expect(r.notes).toEqual([]);
    expect(splitFrontmatter(read(INTO)).body).toBe(before);
    expect((await frontmatterOf(INTO)).claims.map((c) => c.id)).toEqual([FOUNDED.id, BERLIN.id, REGISTERED.id, LEGACY_NAME.id]);
  });

  it("refuses, by default, when the staying page links to a page that goes, and names it", async () => {
    await seed(pages({ intoBody: `${INTO_BODY}\nIts German arm is [[entities/acme-widgets-gmbh|the GmbH]].\n` }));
    const head = (await headCommit(vault))?.sha;
    await expect(mergePages(MERGE, OWNER, { now: NOW })).rejects.toMatchObject({ code: "into_links", status: 409, message: expect.stringContaining(`links to ${GMBH}`) });
    await expect(mergePages({ ...MERGE, dryRun: true }, OWNER, { now: NOW })).rejects.toMatchObject({ code: "into_links" });
    expect((await headCommit(vault))?.sha).toBe(head);
  });

  it("let change, closes the body with a new summary (never a deprecated page's) and unlinks the page from itself", async () => {
    await seed({
      ...pages({ intoBody: `${INTO_BODY}\nIts German arm is [[entities/acme-widgets-gmbh|the GmbH]].\n` }),
      [DUP]: pageText(entity({ title: "Acme Widgets Limited", status: "deprecated" }), "Duplicate of [[entities/acme]].\n"),
    });
    const r = await mergePages({ ...LET_BODY_CHANGE, from: [GMBH, LEGACY, DUP] }, OWNER, { now: NOW });
    // The GmbH page said what the page says already, the copy is deprecated; the old one is news.
    expect(r.notes).toEqual([LEGACY]);
    expect(r.relinked[0]).toEqual({ path: INTO, links: 1 });
    expect(await bodyOf(INTO)).toBe(
      [
        "Acme Widgets Ltd makes widgets in three sizes.",
        "",
        "Shipping: [[concepts/shipping]].",
        "",
        // The page's own link to a merged page is its words now, not a link to itself.
        "Its German arm is the GmbH.",
        "",
        // Its links read from where it now sits.
        "Merged from Acme (old): Acme (old) was the first name of Acme Widgets Ltd; see [pricing](../concepts/pricing.md).",
      ].join("\n"),
    );
    expect((await frontmatterOf(INTO)).aliases).toEqual(["Acme Widgets GmbH", "Acme DE", "Acme (old)", "Acme Widgets Limited"]);
    expect(exists(DUP)).toBe(false);
    expect(brokenLinks(await readVaultSnapshot(vault))).toEqual([]);
  });

  it("points every link form in every other page and in index.md at the page that stays, code left alone", async () => {
    await seed();
    const r = await mergePages(MERGE, OWNER, { now: NOW });
    expect(await bodyOf("concepts/pricing.md")).toBe(PRICING_MERGED);
    expect(await bodyOf("overview.md")).toBe("Start at [[entities/acme|Acme (old)]] or [old](entities/acme.md).");
    expect(read("concepts/shipping.md")).toBe(pages()["concepts/shipping.md"]);
    expect(r.relinked).toEqual([
      { path: "concepts/pricing.md", links: 7 },
      { path: "overview.md", links: 2 },
    ]);
    expect(r.links).toBe(10);
    expect(read("index.md")).toBe(
      [
        "# Index",
        "",
        "- [[entities/acme]] — Acme Widgets Ltd",
        "- [[concepts/pricing]] — Widget pricing",
        "- [[concepts/shipping]] — Shipping",
        "- [[overview]] — Overview",
        "",
        "The German arm is [[entities/acme|here]].",
        "",
      ].join("\n"),
    );
    expect(r.indexLines).toBe(2);
  });

  it("names a page that links a merged page but does not parse, and leaves it as it is", async () => {
    await seed();
    // No frontmatter: written by hand, past the lint that would refuse it.
    const broken = "See [[entities/acme-widgets-gmbh]] for the German arm.\n";
    fs.writeFileSync(path.join(vault, "concepts/broken.md"), broken);
    await git(vault, ["add", "concepts/broken.md"]);
    await git(vault, ["commit", "-qm", "hand page"]);
    const r = await mergePages(MERGE, OWNER, { now: NOW });
    expect(r.commit).not.toBeNull();
    expect(r.unparsed).toEqual(["concepts/broken.md"]);
    expect(read("concepts/broken.md")).toBe(broken);
    expect(r.relinked.map((p) => p.path)).not.toContain("concepts/broken.md");
  });

  it("refuses a claim whose id was retired, naming it, and changes nothing", async () => {
    await seed();
    // The staying page records BERLIN's id as retired: a state no commit may carry, so written by hand.
    fs.writeFileSync(path.join(vault, INTO), pages({ into: { retiredClaimIds: [BERLIN.id] } })[INTO]);
    await git(vault, ["commit", "-qam", "hand edit"]);
    const head = (await headCommit(vault))?.sha;
    await expect(mergePages(MERGE, OWNER, { now: NOW })).rejects.toMatchObject({
      code: "retired",
      status: 409,
      message: expect.stringContaining(`${BERLIN.id} on ${GMBH}`),
    });
    expect((await headCommit(vault))?.sha).toBe(head);
    expect(exists(GMBH)).toBe(true);
  });

  it("lists the page that stays when only the merged pages were listed", async () => {
    await seed();
    // No line for it, and no other link to it in index.md: only the merged pages' lines.
    fs.writeFileSync(path.join(vault, "index.md"), INDEX.replace("- [[entities/acme]] — Acme Widgets Ltd\n", "").replace("The German arm is [[entities/acme-widgets-gmbh|here]].\n", ""));
    await git(vault, ["commit", "-qam", "index by hand"]);
    const r = await mergePages(MERGE, OWNER, { now: NOW });
    expect(r.indexLines).toBe(2);
    expect(read("index.md")).toContain("- [[entities/acme]] — Acme Widgets Ltd\n");
    expect(lintVault(await readVaultSnapshot(vault), { now: NOW }).findings).toEqual([]);
  });

  it("removes the merged pages, and lint stays clean: no error, no orphan, no link left broken", async () => {
    await seed();
    const before = await readVaultSnapshot(vault);
    expect(brokenLinks(before)).toEqual([]);
    expect(lintVault(before, { now: NOW }).errors).toBe(0);

    const r = await mergePages(MERGE, OWNER, { now: NOW });
    expect(exists(GMBH)).toBe(false);
    expect(exists(LEGACY)).toBe(false);
    expect(r.unparsed).toEqual([]);
    const after = await readVaultSnapshot(vault);
    expect(after.pages.map((p) => p.path)).toEqual(["concepts/pricing.md", "concepts/shipping.md", INTO, "overview.md"]);
    expect(brokenLinks(after)).toEqual([]);
    const report = lintVault(after, { now: NOW });
    expect(report.findings).toEqual([]);
    expect(r.findings).toEqual([]);
  });

  it("answers a dry run with exactly what the merge does, and writes nothing", async () => {
    const seeded = await seed();
    const files = await trackedFiles();
    const dry = await mergePages({ ...MERGE, dryRun: true }, OWNER, { now: NOW });
    expect(dry).toMatchObject({ dryRun: true, commit: null, claims: [BERLIN.id, REGISTERED.id, LEGACY_NAME.id], verified: [REGISTERED.id], links: 10, indexLines: 2 });
    expect(dry.relinked.map((p) => p.path)).toEqual(["concepts/pricing.md", "overview.md"]);
    expect((await headCommit(vault))?.sha).toBe(seeded);
    expect(await trackedFiles()).toEqual(files);
    expect((await git(vault, ["status", "--porcelain"])).stdout.trim()).toBe("");

    const done = await mergePages(MERGE, OWNER, { now: NOW });
    const strip = (r: typeof dry) => ({ ...r, dryRun: undefined, commit: undefined, findings: undefined });
    expect(strip(done)).toEqual(strip(dry));
  });

  it("is undone whole by one revert: every page, every link and index.md back as they were", async () => {
    await seed();
    const files = await trackedFiles();
    const r = await mergePages(LET_BODY_CHANGE, ASSISTANT, { now: NOW });
    expect(r.notes).toEqual([LEGACY]);
    // The assistant may take back its own merge.
    const undone = await revertCommit({ sha: r.commit! }, vault, { onlyAuthoredBy: ASSISTANT_AUTHOR });
    expect(undone.changed.sort()).toEqual(["concepts/acme-legacy.md", "concepts/pricing.md", INTO, GMBH, "index.md", "overview.md"].sort());
    expect(await trackedFiles()).toEqual(files);
    expect((await headCommit(vault))?.subject).toMatch(/^revert: [0-9a-f]{12} merge: /);
    expect(lintVault(await readVaultSnapshot(vault), { now: NOW }).errors).toBe(0);
  });

  it("lets the waiting review items about a moved claim follow it, unresolved", async () => {
    await seed();
    const about = addReviewItem(vault, {
      kind: "contradiction",
      claimId: BERLIN.id,
      pages: [GMBH, "concepts/pricing.md"],
      candidates: [
        { text: BERLIN.text, page: GMBH, claimId: BERLIN.id, evidence: [] },
        { text: "Acme Widgets GmbH is based in Munich.", page: "concepts/pricing.md", evidence: [] },
      ],
    }).item;
    const other = addReviewItem(vault, { kind: "lint", pages: [GMBH], candidates: [] }).item;
    expect((await mergePages({ ...MERGE, dryRun: true }, OWNER, { now: NOW })).reviewItems).toBe(1);
    expect(getReviewItem(vault, about.id)?.pages).toEqual([GMBH, "concepts/pricing.md"]);

    const r = await mergePages(MERGE, OWNER, { now: NOW });
    expect(r.reviewItems).toBe(1);
    const followed = getReviewItem(vault, about.id)!;
    expect(followed).toMatchObject({ status: "open", claimId: BERLIN.id, pages: [INTO, "concepts/pricing.md"], resolution: null });
    expect(followed.candidates.map((c) => c.page)).toEqual([INTO, "concepts/pricing.md"]);
    // An item about no moved claim is left as it was.
    expect(getReviewItem(vault, other.id)).toEqual(other);
  });

  it("keeps one copy of a fact both pages carry, the verified one", async () => {
    const unverified = claim(REGISTERED.id, REGISTERED.text, { status: "proposed" });
    // The same id on two pages is a collision no commit may carry: the pages are written by hand.
    await seed();
    const files = pages({ into: { claims: [FOUNDED, unverified] } });
    for (const [p, text] of Object.entries(files)) fs.writeFileSync(path.join(vault, p), text);
    await git(vault, ["commit", "-qam", "hand edit"]);
    const r = await mergePages(MERGE, OWNER, { now: NOW });
    expect((await frontmatterOf(INTO)).claims).toEqual([FOUNDED, REGISTERED, BERLIN, LEGACY_NAME]);
    expect(r.claims).toEqual([BERLIN.id, REGISTERED.id, LEGACY_NAME.id]);
    expect(r.verified).toEqual([REGISTERED.id]);
  });

  it("refuses a verified claim it cannot move intact, says which, and changes nothing", async () => {
    await seed();
    const clash = claim(REGISTERED.id, "Acme Widgets GmbH was registered in 2005.", { status: "proposed" });
    for (const [p, text] of Object.entries(pages({ into: { claims: [FOUNDED, clash] } }))) fs.writeFileSync(path.join(vault, p), text);
    await git(vault, ["commit", "-qam", "hand edit"]);
    const head = (await headCommit(vault))?.sha;
    const files = await trackedFiles();
    for (const dryRun of [true, false]) {
      const err = await mergePages({ ...MERGE, dryRun }, OWNER, { now: NOW }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PageEditError);
      expect(err).toMatchObject({ code: "verified", status: 409 });
      expect((err as Error).message).toContain(`verified claim ${REGISTERED.id} on ${GMBH}`);
      expect((err as Error).message).toContain(INTO);
    }
    expect((await headCommit(vault))?.sha).toBe(head);
    expect(await trackedFiles()).toEqual(files);
    expect((await git(vault, ["status", "--porcelain"])).stdout.trim()).toBe("");
  });

  it("refuses two different unverified claims under one id", async () => {
    await seed();
    const clash = claim(BERLIN.id, "Acme Widgets GmbH is based in Hamburg.");
    for (const [p, text] of Object.entries(pages({ into: { claims: [FOUNDED, clash] } }))) fs.writeFileSync(path.join(vault, p), text);
    await git(vault, ["commit", "-qam", "hand edit"]);
    await expect(mergePages(MERGE, OWNER, { now: NOW })).rejects.toMatchObject({ code: "taken", status: 409 });
  });

  it("refuses a deprecated target, a page into itself, a missing page and more claims than a page holds", async () => {
    await seed(pages({ into: { status: "deprecated" } }));
    await expect(mergePages(MERGE, OWNER, { now: NOW })).rejects.toMatchObject({ code: "deprecated", status: 409, message: expect.stringContaining(INTO) });

    process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
    vault = vaultDir();
    const many = Array.from({ length: 18 }, (_, i) => claim(`acme-sales/acme-widgets-ltd/fact-${i}`, `Acme Widgets Ltd fact number ${i}.`));
    await seed(pages({ into: { claims: many } }));
    await expect(mergePages({ into: INTO, from: [INTO], dryRun: false, keepIntoBody: true }, OWNER)).rejects.toMatchObject({ code: "invalid", status: 400 });
    await expect(mergePages({ into: INTO, from: ["entities/nobody.md"], dryRun: false, keepIntoBody: true }, OWNER)).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("entities/nobody.md"),
    });
    // 18 + 2 fits; 18 + 3 does not.
    await expect(mergePages({ ...MERGE, from: [GMBH], dryRun: true }, OWNER)).resolves.toMatchObject({ claims: [BERLIN.id, REGISTERED.id] });
    await expect(mergePages(MERGE, OWNER)).rejects.toMatchObject({ code: "too_many_claims", status: 409, message: expect.stringContaining("21 claims") });
  });

  it("leaves a page verified as a whole to the owner", async () => {
    const stamp = { at: "2026-02-01T00:00:00.000Z", by: "owner" };
    await seed(pages({ gmbh: { verified: stamp } }));
    await expect(mergePages(MERGE, ASSISTANT, { now: NOW })).rejects.toMatchObject({ code: "verified", message: expect.stringContaining(GMBH) });
    await expect(mergePages(MERGE, OWNER, { now: NOW })).resolves.toMatchObject({ claims: [BERLIN.id, REGISTERED.id, LEGACY_NAME.id] });

    process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
    vault = vaultDir();
    await seed(pages({ into: { verified: stamp } }));
    await expect(mergePages(MERGE, ASSISTANT, { now: NOW })).rejects.toMatchObject({ code: "verified", message: expect.stringContaining(INTO) });
  });
});
