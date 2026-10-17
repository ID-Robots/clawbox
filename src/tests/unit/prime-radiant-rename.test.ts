/**
 * Meaningless page names (rename.ts), the writer's paths for Cyrillic titles,
 * a former path kept as an alias (links.ts), and the one-off migration of the
 * assistant's confirmed verifications to the owner's (verify.ts) — all on
 * synthetic vaults.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The vault's Memory Shard index: stubbed (it embeds), pinned in its own suite.
const shard = vi.hoisted(() => ({ scheduleReindexAfterCommit: vi.fn() }));
vi.mock("@/lib/prime-radiant/shard-index", () => shard);

import { parsePage } from "@/lib/prime-radiant/frontmatter";
import { git, logForPath, verifiedTrailers } from "@/lib/prime-radiant/git";
import { revertCommit } from "@/lib/prime-radiant/history";
import { buildLinkGraph, createLinkResolver, isPathAlias, pathAliases } from "@/lib/prime-radiant/links";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { meaninglessSlug, planSlugRenames, renameMeaninglessPages } from "@/lib/prime-radiant/rename";
import { addReviewItem, getReviewItem } from "@/lib/prime-radiant/review-store";
import { ownerVerified, parseStamp, verifierKind, verifiedViaAssistant, type Claim } from "@/lib/prime-radiant/schema";
import { withStateDb } from "@/lib/prime-radiant/state-db";
import { planAssistantVerificationUpgrade, readStaleClaims, recordStaleClaims, upgradeAssistantVerifications, verifyClaim } from "@/lib/prime-radiant/verify";
import { readVaultSnapshot, vaultOperation } from "@/lib/prime-radiant/vault";
import { pathFor } from "@/lib/prime-radiant/writer";
import { verifierKey } from "@/components/prime-radiant-ui";
import { claim, pageText, snapshot } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-rename-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;
let vault = "";

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

const read = (rel: string) => fs.readFileSync(path.join(vault, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(vault, rel));
const frontmatterOf = (rel: string) => {
  const p = parsePage(read(rel));
  if (!p.ok) throw new Error(`${rel} does not parse`);
  return p.frontmatter;
};
async function head(): Promise<string> {
  return (await git(vault, ["rev-parse", "HEAD"])).stdout.trim();
}
async function seed(files: Record<string, string>): Promise<string> {
  const op = await vaultOperation("seed: pages", async (tx) => {
    for (const [p, text] of Object.entries(files)) await tx.write(p, text);
  });
  return op.commit!;
}

// ── the slugger in the writer ─────────────────────────────────────────────

describe("page paths for Cyrillic titles", () => {
  it("names a Bulgarian document by its transliterated title, and two documents of one title apart by -N", () => {
    const taken = new Set<string>();
    const first = pathFor("concept", "Граждански договор — Иван Иванов", taken);
    expect(first).toBe("concepts/grazhdanski-dogovor-ivan-ivanov.md");
    taken.add(first);
    expect(pathFor("concept", "Граждански договор — Иван Иванов", taken)).toBe("concepts/grazhdanski-dogovor-ivan-ivanov-2.md");
    // Different Bulgarian documents no longer collide into one `x`.
    expect(pathFor("concept", "Фактура 0042", taken)).toBe("concepts/faktura-0042.md");
    expect(pathFor("entity", "Индекс", taken)).toBe("entities/indeks.md");
    // A title with nothing to transliterate is still `x`, and a year is still a year.
    expect(pathFor("concept", "東京", taken)).toBe("concepts/x.md");
    expect(pathFor("concept", "2026", taken)).toBe("concepts/2026.md");
  });

  it("caps a long title at 80 characters, never on a dash", () => {
    const p = pathFor("concept", "Протокол от общото събрание на съдружниците в дружество с ограничена отговорност Глобекс", new Set());
    const stem = p.replace(/^concepts\//, "").replace(/\.md$/, "");
    expect(stem.length).toBeLessThanOrEqual(80);
    expect(stem.startsWith("protokol-ot-obshtoto-sabranie-na-sadruzhnitsite")).toBe(true);
    expect(stem.endsWith("-")).toBe(false);
  });
});

// ── pure parts ────────────────────────────────────────────────────────────

describe("meaningless names and former paths (pure)", () => {
  it("knows a meaningless file name: one letter, a number, a date, with -N suffixes", () => {
    for (const stem of ["x", "x-3", "3", "2026", "2026-2", "2026-09-14", "14-09-2026", "x-2-2"]) expect(meaninglessSlug(stem), stem).toBe(true);
    for (const stem of ["acme", "q3", "x-ray", "faktura-0042", "2026-report", "ab", "index"]) expect(meaninglessSlug(stem), stem).toBe(false);
  });

  it("reads path-shaped aliases as former paths, names as names", () => {
    expect(isPathAlias("concepts/x-3")).toBe(true);
    expect(isPathAlias("Acme Widgets")).toBe(false);
    expect(isPathAlias("AC/DC")).toBe(false);
    expect(pathAliases(["concepts/x-3", "Acme", "entities/2026.md"])).toEqual(["concepts/x-3.md", "entities/2026.md"]);
    expect(pathAliases("concepts/x")).toEqual(["concepts/x.md"]);
    expect(pathAliases(undefined)).toEqual([]);
  });

  it("resolves a link to a former path to the page that was there; a page actually there wins", () => {
    const resolver = createLinkResolver([
      { path: "concepts/grazhdanski-dogovor.md", title: "Граждански договор", aliases: pathAliases(["concepts/x-3"]) },
      { path: "concepts/pricing.md", title: "Pricing" },
    ]);
    expect(resolver.resolve("concepts/pricing.md", { kind: "wiki", target: "concepts/x-3" })).toBe("concepts/grazhdanski-dogovor.md");
    expect(resolver.resolve("concepts/pricing.md", { kind: "md", target: "x-3.md" })).toBe("concepts/grazhdanski-dogovor.md");
    const occupied = createLinkResolver([
      { path: "concepts/grazhdanski-dogovor.md", aliases: ["concepts/x-3.md"] },
      { path: "concepts/x-3.md" },
    ]);
    expect(occupied.resolve("index.md", { kind: "wiki", target: "concepts/x-3" })).toBe("concepts/x-3.md");
    // The link graph counts such a link as reaching the page (no orphan).
    const graph = buildLinkGraph(
      [
        { path: "concepts/grazhdanski-dogovor.md", aliases: ["concepts/x-3.md"], body: "" },
        { path: "concepts/pricing.md", body: "See [[concepts/x-3]]." },
      ],
      null,
    );
    expect([...(graph.inbound.get("concepts/grazhdanski-dogovor.md") ?? [])]).toEqual(["concepts/pricing.md"]);
  });

  it("plans names from titles in each page's own folder, -N on a taken one, and skips what it cannot name", () => {
    const plan = planSlugRenames(
      snapshot({
        "concepts/x.md": pageText({ title: "Граждански договор" }, "Текст.\n"),
        "concepts/x-2.md": pageText({ title: "Граждански договор" }, "Друг договор.\n"),
        "concepts/grazhdanski-dogovor-3.md": pageText({ title: "Something else" }, "Taken name.\n"),
        "entities/3.md": pageText({ type: "entity", title: "Иван Иванов" }, "Човек.\n"),
        "concepts/2026.md": pageText({ title: "2026" }, "A year.\n"),
        "concepts/2026-09-14.md": pageText({ title: "Отчет 14.09.2026" }, "Отчет.\n"),
        "concepts/acme.md": pageText({ title: "Акме" }, "A good name already.\n"),
        "concepts/y.md": "---\ntitle: [broken\n---\nBody\n",
      }),
    );
    expect(plan.result.renamed).toEqual([
      { from: "concepts/2026-09-14.md", to: "concepts/otchet-14-09-2026.md", title: "Отчет 14.09.2026" },
      { from: "concepts/x-2.md", to: "concepts/grazhdanski-dogovor.md", title: "Граждански договор" },
      { from: "concepts/x.md", to: "concepts/grazhdanski-dogovor-2.md", title: "Граждански договор" },
      { from: "entities/3.md", to: "entities/ivan-ivanov.md", title: "Иван Иванов" },
    ]);
    expect(plan.result.skipped).toEqual([
      { path: "concepts/2026.md", reason: "no-better-name" },
      { path: "concepts/y.md", reason: "unparsed" },
    ]);
    // A cap leaves the rest for the next run, and says how many.
    const capped = planSlugRenames(snapshot({ "concepts/x.md": pageText({ title: "Едно" }), "concepts/z.md": pageText({ title: "Две" }) }), 1);
    expect(capped.result.renamed.map((r) => r.to)).toEqual(["concepts/edno.md"]);
    expect(capped.result.more).toBe(1);
  });

  it("leaves a link by the page's title alone, and plans nothing on a vault with good names", () => {
    const plan = planSlugRenames(
      snapshot(
        {
          "concepts/x-3.md": pageText({ title: "Граждански договор" }, "Договор.\n"),
          "concepts/pricing.md": pageText({}, "By title [[Граждански договор]], by path [[concepts/x-3#Срок|срок]], by file [link](x-3.md#top).\n"),
        },
        "# Index\n\n- [[concepts/x-3]] — Граждански договор\n",
      ),
    );
    const pricing = plan.rewrites.find((w) => w.path === "concepts/pricing.md");
    expect(pricing?.body.trim()).toBe("By title [[Граждански договор]], by path [[concepts/grazhdanski-dogovor#Срок|срок]], by file [link](grazhdanski-dogovor.md#top).");
    expect(plan.index).toBe("# Index\n\n- [[concepts/grazhdanski-dogovor]] — Граждански договор\n");
    expect(plan.moves[0].frontmatter.aliases).toEqual(["concepts/x-3"]);
    expect(plan.result.links).toBe(3);
    expect(planSlugRenames(snapshot({ "concepts/acme.md": pageText() })).result).toMatchObject({ renamed: [], skipped: [], links: 0 });
  });
});

// ── on a vault ────────────────────────────────────────────────────────────

describe("renameMeaninglessPages", () => {
  const CONTRACT_CLAIM = claim("bg-legal/grazhdanski-dogovor/term", "Договорът е за 12 месеца.");
  const files = () => ({
    "concepts/x-3.md": pageText({ title: "Граждански договор — Иван Иванов", claims: [CONTRACT_CLAIM], id: "concepts/x-3" }, "Договор за услуги с [[entities/3]].\n"),
    "entities/3.md": pageText({ type: "entity", title: "Иван Иванов", aliases: ["Иван"] }, "Изпълнител по [[concepts/x-3|договора]].\n"),
    "concepts/pricing.md": pageText({}, "Prices. See [[concepts/x-3]] and [the contract](x-3.md).\n"),
    "concepts/2026.md": pageText({ title: "2026" }, "The year in review, see [[concepts/pricing]].\n"),
    "index.md": "# Index\n\n- [[concepts/pricing]] — Widget pricing\n- [[concepts/x-3]] — Граждански договор — Иван Иванов\n- [[entities/3]] — Иван Иванов\n",
  });
  const CONTRACT = "concepts/grazhdanski-dogovor-ivan-ivanov.md";
  const PERSON = "entities/ivan-ivanov.md";

  it("lists what it would do on a dry run and writes nothing", async () => {
    const seeded = await seed(files());
    const dry = await renameMeaninglessPages({ dryRun: true, vault });
    expect(dry).toMatchObject({
      dryRun: true,
      commit: null,
      renamed: [
        { from: "concepts/x-3.md", to: CONTRACT },
        { from: "entities/3.md", to: PERSON },
      ],
      skipped: [{ path: "concepts/2026.md", reason: "no-better-name" }],
      more: 0,
    });
    expect(dry.links).toBe(6);
    expect(await head()).toBe(seeded);
    expect(exists("concepts/x-3.md")).toBe(true);
  });

  it("renames in ONE commit: old paths kept as aliases, every link and the index rewritten, claims and their items following", async () => {
    await seed(files());
    const { item } = addReviewItem(vault, {
      kind: "contradiction",
      claimId: CONTRACT_CLAIM.id,
      pages: ["concepts/x-3.md"],
      candidates: [{ text: CONTRACT_CLAIM.text, page: "concepts/x-3.md", claimId: CONTRACT_CLAIM.id, evidence: [] }],
    });
    recordStaleClaims(vault, [{ claimId: CONTRACT_CLAIM.id, page: "concepts/x-3.md", verifiedClaimId: "bg-legal/other/term", verifiedPage: "entities/3.md", why: "", at: "2026-10-01T00:00:00.000Z" }]);
    const before = await head();
    const r = await renameMeaninglessPages({ vault });
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.reviewItems).toBe(1);
    // One commit on top of the seed.
    expect((await git(vault, ["rev-list", "--count", `${before}..HEAD`])).stdout.trim()).toBe("1");
    expect((await git(vault, ["log", "-1", "--format=%s"])).stdout.trim()).toBe("rename: 2 pages with meaningless names");

    expect(exists("concepts/x-3.md")).toBe(false);
    expect(exists("entities/3.md")).toBe(false);
    const contract = frontmatterOf(CONTRACT);
    expect(contract.aliases).toEqual(["concepts/x-3"]);
    expect(contract.id).toBe("concepts/grazhdanski-dogovor-ivan-ivanov");
    expect(contract.claims.map((c) => c.id)).toEqual([CONTRACT_CLAIM.id]);
    expect(frontmatterOf(PERSON).aliases).toEqual(["Иван", "entities/3"]);
    expect(read(CONTRACT)).toContain("Договор за услуги с [[entities/ivan-ivanov]].");
    expect(read(PERSON)).toContain("Изпълнител по [[concepts/grazhdanski-dogovor-ivan-ivanov|договора]].");
    expect(read("concepts/pricing.md")).toContain("See [[concepts/grazhdanski-dogovor-ivan-ivanov]] and [the contract](grazhdanski-dogovor-ivan-ivanov.md).");
    expect(read("index.md")).toBe(
      "# Index\n\n- [[concepts/pricing]] — Widget pricing\n- [[concepts/grazhdanski-dogovor-ivan-ivanov]] — Граждански договор — Иван Иванов\n- [[entities/ivan-ivanov]] — Иван Иванов\n",
    );
    expect(exists("concepts/2026.md")).toBe(true);

    // The waiting item, the claim registry and the stale note name the new page.
    expect(getReviewItem(vault, item.id)).toMatchObject({ status: "open", pages: [CONTRACT] });
    const row = withStateDb(vault, (db) => db.prepare("SELECT page FROM claim_registry WHERE id = ?").get(CONTRACT_CLAIM.id) as { page: string } | undefined);
    expect(row?.page).toBe(CONTRACT);
    expect(readStaleClaims(vault)).toEqual([expect.objectContaining({ page: CONTRACT, verifiedPage: PERSON })]);

    // History follows the page across its rename.
    const history = await logForPath(vault, CONTRACT, 10);
    expect(history.map((c) => c.subject)).toEqual(["rename: 2 pages with meaningless names", "seed: pages"]);

    // A second run has nothing left to rename.
    expect(await renameMeaninglessPages({ vault })).toMatchObject({ commit: null, renamed: [] });
  });

  it("is undone whole by one revert", async () => {
    await seed(files());
    const r = await renameMeaninglessPages({ vault });
    const undone = await revertCommit({ sha: r.commit! }, vault);
    expect(undone.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(exists("concepts/x-3.md")).toBe(true);
    expect(exists("entities/3.md")).toBe(true);
    expect(exists(CONTRACT)).toBe(false);
    expect(read("concepts/pricing.md")).toContain("See [[concepts/x-3]] and [the contract](x-3.md).");
    expect(read("index.md")).toContain("- [[concepts/x-3]] — Граждански договор");
  });
});

// ── owner-verified via the assistant ──────────────────────────────────────

describe("the owner's verification given through the assistant", () => {
  const AT = "2026-09-01T00:00:00.000Z";
  const via = { at: AT, by: "owner", via: "assistant" };

  it("is a stamp the page contract keeps, owner-verified, and worded as the owner's via the assistant", () => {
    expect(parseStamp({ at: AT, by: "owner", via: "assistant" })).toEqual(via);
    expect(parseStamp({ at: AT, by: "owner", via: "  " })).toEqual({ at: AT, by: "owner" });
    expect(parseStamp({ at: AT, by: "owner", via: 3 })).toEqual({ at: AT, by: "owner" });
    expect(ownerVerified({ verified: via, status: "verified" })).toBe(true);
    expect(verifiedViaAssistant(via)).toBe(true);
    expect(verifiedViaAssistant({ at: AT, by: "assistant", via: "assistant" })).toBe(false);
    expect(verifierKind(via)).toBe("owner-via-assistant");
    expect(verifierKind({ by: "owner" })).toBe("owner");
    expect(verifierKind({ by: "assistant" })).toBe("assistant");
    expect(verifierKind({ by: "Jane Roe" })).toBe("other");
    expect(verifierKey(via)).toBe("OwnerViaAssistant");
    expect(verifierKey({ by: "owner" })).toBe("Owner");
    expect(verifierKey({ by: "assistant" })).toBe("Assistant");
    expect(verifierKey({ by: "Jane Roe" })).toBeNull();
    // A page round-trips the stamp byte for byte.
    const text = pageText({ claims: [claim("acme-sales/pricing/blue", "The blue widget costs 10 EUR.", { status: "verified", verified: via })] });
    const parsed = parsePage(text);
    expect(parsed.ok && parsed.frontmatter.claims[0].verified).toEqual(via);
    expect(verifiedTrailers(via)).toEqual(["Verified-by: owner", "Verified-via: assistant"]);
    expect(verifiedTrailers({ by: "owner\nVerified-via: assistant" })).toEqual(["Verified-by: owner Verified-via assistant"]);
  });

  it("verifyClaim stamps it, marks the page checked by a human and says it in the commit's trailers", async () => {
    await seed({ "concepts/pricing.md": pageText({ claims: [claim("acme-sales/pricing/blue", "The blue widget costs 10 EUR.")] }) });
    const r = await verifyClaim({ claimId: "acme-sales/pricing/blue", text: "The blue widget costs 11 EUR.", by: "owner", via: "assistant", vault, now: new Date(AT) });
    const fm = frontmatterOf("concepts/pricing.md");
    expect(fm.claims[0]).toMatchObject({ text: "The blue widget costs 11 EUR.", status: "verified", verified: via });
    expect(fm.claims[0].evidence.at(-1)).toMatchObject({ kind: "human-verification", note: "verified by owner via assistant" });
    expect(fm.checked_by).toBe("human");
    const [commit] = await logForPath(vault, "concepts/pricing.md", 1);
    expect(commit).toMatchObject({ sha: r.commit, subject: "verify: acme-sales/pricing/blue", verified: { by: "owner", via: "assistant" } });
    // The seed commit carries no verifier.
    const all = await logForPath(vault, "concepts/pricing.md", 5);
    expect(all[1].verified).toBeUndefined();
  });
});

describe("upgradeAssistantVerifications (the one-off migration)", () => {
  const AT = "2026-09-01T00:00:00.000Z";
  const human = (note: string) => ({ kind: "human-verification", note, updatedAt: AT });
  const assistantClaim = (id: string, text: string, evidence: Claim["evidence"]): Claim =>
    claim(id, text, { status: "verified", confidence: 1, verified: { at: AT, by: "assistant" }, evidence });
  const files = () => ({
    "concepts/pricing.md": pageText({
      claims: [
        assistantClaim("acme-sales/pricing/blue", "The blue widget costs 10 EUR.", [{ kind: "claim", path: "sources/acme-catalogue.md" }, human("verified by assistant")]),
        assistantClaim("acme-sales/pricing/red", "The red widget costs 14 EUR.", [human("verified by assistant from review rev-0123456789ab")]),
        claim("acme-sales/pricing/green", "The green widget costs 9 EUR.", { status: "verified", verified: { at: AT, by: "owner" }, evidence: [human("verified by owner")] }),
      ],
    }),
    "concepts/catalogue.md": pageText({
      title: "Catalogue",
      claims: [
        // No human-verification line: nobody's word is on record behind it.
        assistantClaim("acme-sales/catalogue/size", "The catalogue lists three sizes.", [{ kind: "claim", path: "sources/acme-catalogue.md" }]),
        claim("acme-sales/catalogue/colour", "Widgets come in blue.", { status: "proposed" }),
      ],
    }),
  });

  it("plans only assistant stamps a human-verification line backs (pure)", () => {
    const plan = planAssistantVerificationUpgrade(snapshot(files()));
    expect(plan.upgraded).toEqual([
      { claimId: "acme-sales/pricing/blue", page: "concepts/pricing.md" },
      { claimId: "acme-sales/pricing/red", page: "concepts/pricing.md" },
    ]);
    expect(plan.skipped).toEqual([{ claimId: "acme-sales/catalogue/size", page: "concepts/catalogue.md" }]);
    expect(plan.writes.map((w) => w.path)).toEqual(["concepts/pricing.md"]);
  });

  it("lists on a dry run, then upgrades in one commit Undo reverses; a second run changes nothing", async () => {
    const seeded = await seed(files());
    const dry = await upgradeAssistantVerifications({ dryRun: true, vault });
    expect(dry).toMatchObject({ dryRun: true, commit: null, pages: ["concepts/pricing.md"], skipped: [{ claimId: "acme-sales/catalogue/size" }] });
    expect(dry.upgraded).toHaveLength(2);
    expect(await head()).toBe(seeded);

    const r = await upgradeAssistantVerifications({ vault, now: new Date("2026-10-17T00:00:00.000Z") });
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    const fm = frontmatterOf("concepts/pricing.md");
    const byId = new Map(fm.claims.map((c) => [c.id, c]));
    // The moment it was verified is kept; who becomes the owner, via the assistant.
    expect(byId.get("acme-sales/pricing/blue")?.verified).toEqual({ at: AT, by: "owner", via: "assistant" });
    expect(byId.get("acme-sales/pricing/blue")?.evidence).toEqual([{ kind: "claim", path: "sources/acme-catalogue.md" }, human("verified by owner via assistant")]);
    expect(byId.get("acme-sales/pricing/red")?.evidence).toEqual([human("verified by owner via assistant from review rev-0123456789ab")]);
    expect(byId.get("acme-sales/pricing/green")?.verified).toEqual({ at: AT, by: "owner" });
    expect(fm.checked_by).toBe("human");
    expect(ownerVerified(byId.get("acme-sales/pricing/blue")!)).toBe(true);
    expect(frontmatterOf("concepts/catalogue.md").claims[0].verified).toEqual({ at: AT, by: "assistant" });
    const [commit] = await logForPath(vault, "concepts/pricing.md", 1);
    expect(commit).toMatchObject({ subject: "migrate: 2 assistant verifications -> owner via the assistant", verified: { by: "owner", via: "assistant" } });

    expect(await upgradeAssistantVerifications({ vault })).toMatchObject({ commit: null, upgraded: [] });

    await revertCommit({ sha: r.commit! }, vault);
    expect(frontmatterOf("concepts/pricing.md").claims.find((c) => c.id === "acme-sales/pricing/blue")?.verified).toEqual({ at: AT, by: "assistant" });
    const after = await readVaultSnapshot(vault);
    expect(planAssistantVerificationUpgrade(after).upgraded).toHaveLength(2);
  });
});
