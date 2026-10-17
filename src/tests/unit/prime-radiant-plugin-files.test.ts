/**
 * What OpenClaw's memory-wiki plugin wrote into the vault on the live test —
 * a "## Related" block on every page, a "## Generated" block in index.md,
 * `<folder>/index.md` with no frontmatter, `reports/*.md` dashboards,
 * WIKI.md, inbox.md, `_views/`, `_attachments/` — and how the vault stays
 * right: never a page, never linted, never committed, taken out once by the
 * repair (one commit of its own, owner content untouched), and never the
 * reason a nightly merge or a revert finds the vault dirty. The plugin's
 * output is rebuilt here exactly as its `replaceManagedMarkdownBlock` writes
 * it. Fixtures are synthetic.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const shard = vi.hoisted(() => ({ scheduleReindexAfterCommit: vi.fn() }));
vi.mock("@/lib/prime-radiant/shard-index", () => shard);
/** How many of the next vault commits fail (a git lock, a full disk). */
const commitFault = vi.hoisted(() => ({ failures: 0 }));
vi.mock("@/lib/prime-radiant/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prime-radiant/git")>();
  return {
    ...actual,
    commitPaths: async (...args: Parameters<typeof actual.commitPaths>) => {
      if (commitFault.failures > 0) {
        commitFault.failures -= 1;
        throw new Error("git commit failed: index.lock exists");
      }
      return actual.commitPaths(...args);
    },
  };
});

import { parsePage, serializePage } from "@/lib/prime-radiant/frontmatter";
import { git, headCommit } from "@/lib/prime-radiant/git";
import { lintVault } from "@/lib/prime-radiant/lint";
import { isKnowledgePage, vaultDir } from "@/lib/prime-radiant/paths";
import { buildClaimIndex, isClaimId } from "@/lib/prime-radiant/claims";
import { adoptPluginFrontmatter } from "@/lib/prime-radiant/plugin-compat";
import { validateFrontmatter } from "@/lib/prime-radiant/schema";
import { editPage } from "@/lib/prime-radiant/edit";
import {
  isPluginFormatFrontmatter,
  isPluginOwnedPath,
  isPristineInbox,
  isPristinePluginIndex,
  isPristinePluginReport,
  isPristineWikiOverview,
  PLUGIN_GITIGNORE_LINES,
  stripManagedBlocks,
  withPluginGitignore,
} from "@/lib/prime-radiant/plugin-files";
import {
  ADOPT_COMMIT_PREFIX,
  adoptPluginPages,
  pluginRepairDone,
  REPAIR_COMMIT_MESSAGE,
  repairPluginWritesOnce,
  restorePluginOnlyEdits,
} from "@/lib/prime-radiant/plugin-repair";
import { ensureVault, readPage, readVaultSnapshot, vaultOperation } from "@/lib/prime-radiant/vault";
import { claim, frontmatter, pageText, snapshot } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// ── the plugin's output, as it writes it ──────────────────────────────────

/** `replaceManagedMarkdownBlock` appending a block to text that has none. */
function appendBlock(original: string, heading: string, name: string, body: string): string {
  const block = `${heading}\n<!-- openclaw:wiki:${name}:start -->\n${body}\n<!-- openclaw:wiki:${name}:end -->`;
  const trimmed = original.trimEnd();
  return trimmed.length === 0 ? `${block}\n` : `${trimmed}\n\n${block}\n`;
}

const related = (text: string) =>
  appendBlock(text, "## Related", "related", "### Related Pages\n- [Shipping](../concepts/shipping.md)\n- [Catalogue](../concepts/catalogue.md)");
const generatedIndex = (title: string, dir: string) =>
  appendBlock(`# ${title}\n`, "## Generated", `${dir}:index`, `- No ${title.toLowerCase()} yet.`);
const DASHBOARD = appendBlock(
  "---\npageType: report\nid: report.claim-health\ntitle: Claim Health\nstatus: active\nupdatedAt: 2026-10-14T08:00:00.000Z\n---\n\n# Claim Health\n",
  "## Generated",
  "claim-health",
  "- No claims missing evidence.",
);
const WIKI_MD = [
  "# Memory Wiki",
  "",
  "This vault is maintained by the OpenClaw memory-wiki plugin.",
  "",
  "- Vault mode: `isolated`",
  "- Render mode: `native`",
  "- Search corpus default: `wiki`",
  "",
  "## Architecture",
  "- Raw sources remain the evidence layer.",
  "- To keep unmanaged raw Markdown in `sources/`, add `<!-- openclaw:wiki:raw-source -->` near the top of the page.",
  "- Wiki pages are the human-readable synthesis layer.",
  "- Compiled query and prompt snapshots live in OpenClaw plugin state, not vault files.",
  "",
  "## Notes",
  "<!-- openclaw:human:start -->",
  "<!-- openclaw:human:end -->",
  "",
].join("\n");
const INBOX = "# Inbox\n\nDrop raw ideas, questions, and source links here.\n";

describe("memory-wiki's files and blocks (pure)", () => {
  it("knows the plugin's files from pages", () => {
    for (const p of ["WIKI.md", "inbox.md", "entities/index.md", "sources/index.md", "concepts/index.md", "syntheses/index.md", "reports/claim-health.md", "_views/x.md", "_attachments/a.png", ".openclaw-wiki/log.jsonl"]) {
      expect(isPluginOwnedPath(p), p).toBe(true);
      expect(isKnowledgePage(p), p).toBe(false);
    }
    for (const p of ["index.md", "entities/acme.md", "concepts/sub/index.md", "decisions/index-of-prices.md"]) expect(isPluginOwnedPath(p), p).toBe(false);
    expect(isKnowledgePage("entities/acme.md")).toBe(true);
  });

  it("takes a Related block out and gives back the page byte for byte", () => {
    const page = pageText({ claims: [claim("acme-sales/pricing/blue-widget")] });
    const touched = related(page);
    expect(touched).toContain("<!-- openclaw:wiki:related:start -->");
    expect(stripManagedBlocks(touched)).toEqual({ text: page, blocks: 1 });
    // Written twice by two compiles, still one block in the file; and a page without one is returned as is.
    expect(stripManagedBlocks(page)).toEqual({ text: page, blocks: 0 });
    // The parse never sees it: the body is the page's own, and written back it drops the block.
    const parsed = parsePage(touched);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.body).not.toContain("Related");
      expect(serializePage(parsed.frontmatter, parsed.body)).toBe(page);
    }
  });

  it("takes the Generated block out of index.md and keeps the owner's lines and human notes", () => {
    const index = "# Index\n\nEvery page of this wiki is listed here, one line each.\n- [[concepts/pricing]] — Widget pricing\n";
    expect(stripManagedBlocks(appendBlock(index, "## Generated", "index", "- Total pages: 1")).text).toBe(index);
    const human = "# Notes\n\n<!-- openclaw:human:start -->\nMine.\n<!-- openclaw:human:end -->\n<!-- openclaw:wiki:raw-source -->\n";
    expect(stripManagedBlocks(human)).toEqual({ text: human, blocks: 0 });
  });

  it("takes a block and the blank lines before it out of a CRLF page", () => {
    const page = "# Pricing\r\n\r\nAcme prices.\r\n";
    const touched = `${page.trimEnd()}\r\n\r\n## Related\r\n<!-- openclaw:wiki:related:start -->\r\n- [Shipping](../concepts/shipping.md)\r\n<!-- openclaw:wiki:related:end -->\r\n`;
    expect(stripManagedBlocks(touched)).toEqual({ text: page, blocks: 1 });
    // Two blocks in a row go with the blank lines between them.
    const twice = `${touched.trimEnd()}\r\n\r\n<!-- openclaw:wiki:extra:start -->\r\nx\r\n<!-- openclaw:wiki:extra:end -->\r\n`;
    expect(stripManagedBlocks(twice)).toEqual({ text: page, blocks: 2 });
  });

  it("reads a long run of line breaks in one pass (no ReDoS)", () => {
    const run = "\r\n".repeat(50_000);
    const started = performance.now();
    // No marker at all: returned as is.
    expect(stripManagedBlocks(run)).toEqual({ text: run, blocks: 0 });
    // A marker somewhere, so the pattern does run over every line break — and finds no block.
    const raw = `${run}<!-- openclaw:wiki:raw-source -->\r\n`;
    expect(stripManagedBlocks(raw)).toEqual({ text: raw, blocks: 0 });
    const heading = `## Related${run}x <!-- openclaw:wiki:related:start -->\r\n`;
    expect(stripManagedBlocks(heading)).toEqual({ text: heading, blocks: 0 });
    // A block after the run still takes the run with it.
    const page = "# Page\r\n\r\nBody.\r\n";
    const touched = `${page}${run}## Related\r\n<!-- openclaw:wiki:related:start -->\r\n- [A](a.md)\r\n<!-- openclaw:wiki:related:end -->\r\n`;
    expect(stripManagedBlocks(touched)).toEqual({ text: page, blocks: 1 });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("deletes only a plugin file still exactly as the plugin made it", () => {
    expect(isPristinePluginIndex(generatedIndex("Entities", "entities"))).toBe(true);
    expect(isPristinePluginIndex(`${generatedIndex("Entities", "entities")}\nMy own note about entities.\n`)).toBe(false);
    expect(isPristinePluginIndex(pageText())).toBe(false);
    expect(isPristinePluginReport(DASHBOARD)).toBe(true);
    expect(isPristinePluginReport(DASHBOARD.replace("# Claim Health\n", "# Claim Health\n\nChecked by hand on Monday.\n"))).toBe(false);
    expect(isPristinePluginReport(pageText())).toBe(false);
    expect(isPristineWikiOverview(WIKI_MD)).toBe(true);
    expect(isPristineWikiOverview(WIKI_MD.replace("<!-- openclaw:human:start -->", "<!-- openclaw:human:start -->\nAsk Ana first."))).toBe(false);
    expect(isPristineInbox(INBOX)).toBe(true);
    expect(isPristineInbox(`${INBOX}- call the landlord\n`)).toBe(false);
  });

  it("adds the plugin's names to .gitignore once", () => {
    const old = "# memory-wiki keeps its compiled state here; it is rebuildable and not history.\n.openclaw-wiki/\n";
    const next = withPluginGitignore(old)!;
    expect(next.startsWith(old)).toBe(true);
    for (const line of PLUGIN_GITIGNORE_LINES) expect(next.split("\n")).toContain(line);
    expect(next.match(/openclaw-wiki/g)).toHaveLength(1);
    expect(withPluginGitignore(next)).toBeNull();
    expect(withPluginGitignore(null)).toContain("/entities/index.md");
  });

  it("lints a vault the plugin wrote into as if it had not", () => {
    const pages = {
      "concepts/pricing.md": pageText({ claims: [claim("acme-sales/pricing/blue-widget")] }, "Acme prices.\n"),
      "concepts/shipping.md": pageText({ title: "Shipping", claims: [claim("acme-ops/shipping/days")] }, "Acme ships.\n"),
    };
    const clean = lintVault(snapshot(pages), {});
    const touched = lintVault(
      snapshot(Object.fromEntries(Object.entries(pages).map(([p, t]) => [p, related(t)]))),
      {},
    );
    // The Related links rescue no orphan, and nothing new is found.
    expect(touched.findings).toEqual(clean.findings);
    expect(clean.findings.some((f) => f.rule === "orphan")).toBe(true);
  });
});

// ── a real vault ──────────────────────────────────────────────────────────

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-plugin-files-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;

beforeEach(() => {
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
  commitFault.failures = 0;
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

const at = (rel: string) => path.join(vaultDir(), ...rel.split("/"));
const read = (rel: string) => fs.readFileSync(at(rel), "utf8");
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text);
};
const exists = (rel: string) => fs.existsSync(at(rel));
async function status(): Promise<string> {
  return (await git(vaultDir(), ["status", "--porcelain"])).stdout.trim();
}

const PRICING = pageText({ claims: [claim("acme-sales/pricing/blue-widget", "The blue widget costs 10 EUR per unit.")] }, "Acme prices.\n\n[[concepts/shipping]]\n");
const SHIPPING = pageText({ title: "Shipping", claims: [claim("acme-ops/shipping/days", "Acme orders ship within three days.")] }, "Acme ships.\n\n[[concepts/pricing]]\n");
const CATALOGUE = pageText({ title: "Catalogue", claims: [claim("acme-sales/catalogue/size", "The blue widget is 4 cm wide.")] }, "Acme sizes.\n");

/**
 * A vault of three pages as an older ClawBox left it (the old `.gitignore`),
 * then compiled by memory-wiki: a Related block on every page (one of them
 * committed since, as a verification that re-wrote the page used to), a
 * Generated block in index.md, the scaffold, the group indexes, a dashboard
 * — and an inbox the owner already dropped a note in.
 */
async function pollutedVault(): Promise<void> {
  await ensureVault();
  write(".gitignore", "# memory-wiki keeps its compiled state here; it is rebuildable and not history.\n.openclaw-wiki/\n");
  await git(vaultDir(), ["add", ".gitignore"]);
  await git(vaultDir(), ["commit", "--quiet", "-m", "older ClawBox"]);
  await vaultOperation("ingest: acme", async (tx) => {
    await tx.write("concepts/pricing.md", PRICING);
    await tx.write("concepts/shipping.md", SHIPPING);
    await tx.write("concepts/catalogue.md", CATALOGUE);
    await tx.write("index.md", `${read("index.md")}- [[concepts/pricing]] — Widget pricing\n- [[concepts/shipping]] — Shipping\n- [[concepts/catalogue]] — Catalogue\n`);
  });
  // A Related block that reached a commit.
  write("concepts/catalogue.md", related(CATALOGUE));
  await git(vaultDir(), ["commit", "--quiet", "-am", "verify: acme-sales/catalogue/size"]);
  // The compile.
  for (const p of ["concepts/pricing.md", "concepts/shipping.md"]) write(p, related(read(p)));
  write("index.md", appendBlock(read("index.md"), "## Generated", "index", "- Render mode: `native`\n- Total pages: 3"));
  for (const [dir, title] of [["entities", "Entities"], ["sources", "Sources"], ["syntheses", "Syntheses"], ["concepts", "Concepts"]]) {
    write(`${dir}/index.md`, generatedIndex(title, dir));
  }
  write("reports/claim-health.md", DASHBOARD);
  write("WIKI.md", WIKI_MD);
  write("inbox.md", `${INBOX}- ask Ana about the new warehouse\n`);
  write(".openclaw-wiki/log.jsonl", '{"type":"init"}\n');
  fs.mkdirSync(at("_views"), { recursive: true });
  fs.mkdirSync(at("_attachments/empty"), { recursive: true });
}

/** A page as the plugin's create_synthesis writes it: its own frontmatter, none of Prime Radiant's contract. */
const PLUGIN_SYNTHESIS = [
  "---",
  "pageType: synthesis",
  "id: synthesis.acme-roadmap",
  "title: Acme roadmap",
  "sourceIds:",
  "  - source.acme-plan",
  "status: active",
  'updatedAt: "2026-03-02T09:00:00.000Z"',
  "claims:",
  "  - id: claim.acme.roadmap.green",
  "    text: Acme Widgets Ltd ships the green widget in the third quarter.",
  "    status: supported",
  "    confidence: 0.7",
  "    evidence:",
  "      - kind: source",
  "        sourceId: source.acme-plan",
  "---",
  "# Acme roadmap",
  "",
  "Acme Widgets Ltd plans the green widget for the third quarter.",
  "",
].join("\n");

describe("a page memory-wiki wrote in its own format", () => {
  it("is told apart from Prime Radiant's own pages (which carry pageType too)", () => {
    expect(isPluginFormatFrontmatter({ pageType: "synthesis", sourceIds: ["source.x"], status: "active" })).toBe(true);
    expect(isPluginFormatFrontmatter({ ...frontmatter(), pageType: "concept" })).toBe(false);
    expect(isPluginFormatFrontmatter({ title: "No kind" })).toBe(false);
    expect(isPluginFormatFrontmatter(null)).toBe(false);
  });

  it("is converted to a valid page whatever the plugin left out or set oddly", () => {
    const now = new Date("2026-05-20T03:00:00.000Z");
    const taken = claim("general/acme-roadmap/acme-ships-the-green-widget-in-q3", "Acme ships the green widget in Q3.");
    const claimIndex = buildClaimIndex([{ path: "concepts/plans.md", frontmatter: frontmatter({ claims: [taken] }) }]);
    const { frontmatter: fm, claims } = adoptPluginFrontmatter(
      "syntheses/acme-roadmap.md",
      {
        pageType: "dashboard",
        domain: "Not A Slug",
        privacyTier: "local-private",
        updatedAt: "yesterday",
        claims: [
          { id: "claim.a", text: "Acme ships the green widget in Q3.", status: "verified", confidence: 7 },
          { id: "claim.b", text: "   " },
          "not a claim",
        ],
      },
      "# Acme roadmap\n\nPlans.\n",
      { claimIndex, now },
    );
    expect(validateFrontmatter(fm).ok).toBe(true);
    // An unknown kind takes its folder's; the title its first heading; the domain and the date safe defaults.
    expect(fm).toMatchObject({ type: "synthesis", title: "Acme roadmap", domain: "general", privacy: "confidential", generated: { at: now.toISOString(), by: "memory-wiki" } });
    // Only a claim with text is kept: never verified by the plugin's say-so, its confidence in range, its id free.
    expect(claims).toBe(1);
    expect(fm.claims[0]).toMatchObject({ text: "Acme ships the green widget in Q3.", status: "proposed", confidence: 0.5 });
    expect(isClaimId(fm.claims[0].id)).toBe(true);
    expect(fm.claims[0].id).not.toBe(taken.id);

    // No title, no heading: the file name; outside the plugin's folders, a concept; a tier Prime Radiant knows is kept.
    const bare = adoptPluginFrontmatter("notes/globex_launch-plan.md", { pageType: "page", privacyTier: "public" }, "No heading here.\n", { claimIndex, now }).frontmatter;
    expect(bare).toMatchObject({ type: "concept", title: "globex launch plan", privacy: "public", sources: [], claims: [] });
    expect(validateFrontmatter(bare).ok).toBe(true);
  });

  it("converts the pages it can, and leaves out one the commit would be refused for", async () => {
    await pollutedVault();
    write("syntheses/acme-roadmap.md", PLUGIN_SYNTHESIS);
    // A synthetic token shape, built so no literal credential sits in the file.
    const token = "ghp" + "_" + "Ab3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5";
    write("syntheses/acme-keys.md", PLUGIN_SYNTHESIS.replace("id: synthesis.acme-roadmap", "id: synthesis.acme-keys").replace("plans the green widget", `stores ${token} for the green widget`));
    // A field of its own that breaks the page contract even converted.
    write("syntheses/acme-old.md", PLUGIN_SYNTHESIS.replace("id: synthesis.acme-roadmap", "id: synthesis.acme-old\nversion_of: 7"));

    const adopted = await adoptPluginPages(vaultDir(), () => new Date("2026-05-20T03:00:00.000Z"));
    expect(adopted.adopted).toEqual(["syntheses/acme-roadmap.md"]);
    expect((await headCommit(vaultDir()))?.subject).toBe(`${ADOPT_COMMIT_PREFIX} (1)`);
    expect((await readPage("syntheses/acme-roadmap.md"))?.parsed.ok).toBe(true);
    // The two left out are as the plugin wrote them, still a warning (and the secret its own error).
    expect(read("syntheses/acme-keys.md")).toContain("pageType: synthesis");
    expect(read("syntheses/acme-old.md")).toContain("version_of: 7");
    const report = lintVault(await readVaultSnapshot(), {});
    expect(report.findings.filter((f) => f.rule === "plugin-format").map((f) => f.path).sort()).toEqual(["syntheses/acme-keys.md", "syntheses/acme-old.md"]);
    expect(report.findings.filter((f) => f.blocksCommit).map((f) => [f.rule, f.path])).toEqual([["secret-pattern", "syntheses/acme-keys.md"]]);
    // A second pass has nothing more it can do, and commits nothing.
    expect(await adoptPluginPages()).toEqual({ adopted: [], commit: null });
  });

  it("never breaks the lint, and the next pass makes it a Prime Radiant page the owner can edit", async () => {
    await pollutedVault();
    write("syntheses/acme-roadmap.md", PLUGIN_SYNTHESIS);
    const report = lintVault(await readVaultSnapshot(), {});
    expect(report.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(report.findings.filter((f) => f.path === "syntheses/acme-roadmap.md").map((f) => [f.rule, f.blocksCommit])).toEqual([["plugin-format", false]]);
    // Nothing else is held by it: a change to another page commits.
    await vaultOperation("edit: shipping", async (tx) => tx.write("concepts/shipping.md", SHIPPING.replace("Shipping", "Shipping and returns")));

    const adopted = await adoptPluginPages(vaultDir(), () => new Date("2026-05-20T03:00:00.000Z"));
    expect(adopted.adopted).toEqual(["syntheses/acme-roadmap.md"]);
    expect((await headCommit(vaultDir()))?.subject).toBe(`${ADOPT_COMMIT_PREFIX} (1)`);
    const page = await readPage("syntheses/acme-roadmap.md");
    expect(page?.parsed.ok).toBe(true);
    const fm = page!.parsed.ok ? page!.parsed.frontmatter : null;
    expect(fm).toMatchObject({
      type: "synthesis",
      title: "Acme roadmap",
      status: "draft",
      sources: ["source.acme-plan"],
      generated: { at: "2026-03-02T09:00:00.000Z", by: "memory-wiki" },
      pageType: "synthesis",
      id: "synthesis.acme-roadmap",
    });
    expect(fm!.claims).toHaveLength(1);
    expect(fm!.claims[0]).toMatchObject({ text: "Acme Widgets Ltd ships the green widget in the third quarter.", status: "supported", confidence: 0.7 });
    expect(isClaimId(fm!.claims[0].id)).toBe(true);
    expect(page!.parsed.body).toContain("Acme Widgets Ltd plans the green widget for the third quarter.");
    expect(read("index.md")).toContain("[[syntheses/acme-roadmap]]");
    const after = lintVault(await readVaultSnapshot(), {});
    expect(after.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(after.findings.some((f) => f.rule === "plugin-format")).toBe(false);

    // The owner edits it like any page; a second pass has nothing to do.
    await editPage("syntheses/acme-roadmap.md", { summary: "Acme Widgets Ltd's plan for the green widget." }, { by: "owner", person: true });
    expect(await adoptPluginPages()).toEqual({ adopted: [], commit: null });
  });
});

describe("a vault memory-wiki wrote into", () => {
  it("is read, linted and listed as if the plugin had not been there", async () => {
    await pollutedVault();
    const snap = await readVaultSnapshot();
    expect(snap.pages.map((p) => p.path)).toEqual(["concepts/catalogue.md", "concepts/pricing.md", "concepts/shipping.md"]);
    expect(snap.indexBody).not.toContain("openclaw:wiki");
    const report = lintVault(snap, {});
    expect(report.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(report.findings.some((f) => f.rule === "frontmatter-invalid")).toBe(false);
  });

  it("is repaired once: blocks and pristine plugin files out, one commit for what HEAD held, owner content kept", async () => {
    await pollutedVault();
    const before = (await headCommit(vaultDir()))!.sha;
    const result = await repairPluginWritesOnce();
    expect(result.ran).toBe(true);
    expect(result.cleaned.sort()).toEqual(["concepts/catalogue.md", "concepts/pricing.md", "concepts/shipping.md", "index.md"]);
    expect(result.removed.sort()).toEqual(
      ["WIKI.md", "_attachments/", "_views/", "concepts/index.md", "entities/index.md", "reports/", "reports/claim-health.md", "sources/index.md", "syntheses/index.md"].sort(),
    );
    // The pages are what Prime Radiant wrote.
    expect(read("concepts/pricing.md")).toBe(PRICING);
    expect(read("concepts/catalogue.md")).toBe(CATALOGUE);
    expect(read("index.md")).not.toContain("openclaw:wiki");
    // The owner's note and the plugin's own state stay.
    expect(read("inbox.md")).toContain("ask Ana");
    expect(exists(".openclaw-wiki/log.jsonl")).toBe(true);
    // ONE commit, of its own: the block HEAD held and the .gitignore — nothing only the working tree had.
    expect(result.commit).not.toBeNull();
    const head = (await headCommit(vaultDir()))!;
    expect(head.subject).toBe(REPAIR_COMMIT_MESSAGE);
    expect((await git(vaultDir(), ["rev-parse", "HEAD~1"])).stdout.trim()).toBe(before);
    const files = (await git(vaultDir(), ["show", "--name-only", "--format=", "HEAD"])).stdout.trim().split("\n").sort();
    expect(files).toEqual([".gitignore", "concepts/catalogue.md"]);
    // Clean, and what the plugin re-creates when it starts stays out of git.
    expect(await status()).toBe("");
    write("WIKI.md", WIKI_MD);
    write("entities/index.md", generatedIndex("Entities", "entities"));
    fs.mkdirSync(at("_views"), { recursive: true });
    expect(await status()).toBe("");

    // Once: the plugin's files are back, the repair does not run again.
    expect(pluginRepairDone()).toBe(true);
    expect(await repairPluginWritesOnce()).toEqual({ ran: false, cleaned: [], removed: [], commit: null });
    expect(exists("WIKI.md")).toBe(true);
  });

  it("commits on a retry what a repair whose commit failed had already deleted and written", async () => {
    await pollutedVault();
    // An older ClawBox committed a dashboard and a group index just as the plugin wrote them.
    await git(vaultDir(), ["add", "reports/claim-health.md", "entities/index.md"]);
    await git(vaultDir(), ["commit", "--quiet", "-m", "older ClawBox: everything"]);
    commitFault.failures = 1;
    await expect(repairPluginWritesOnce()).rejects.toThrow("git commit failed");
    // The working tree is repaired, HEAD is not, and the repair is not marked done.
    expect(exists("reports/claim-health.md")).toBe(false);
    expect(exists("entities/index.md")).toBe(false);
    expect(pluginRepairDone()).toBe(false);

    const result = await repairPluginWritesOnce();
    expect(result.ran).toBe(true);
    expect(result.removed).toEqual(expect.arrayContaining(["reports/claim-health.md", "entities/index.md"]));
    const head = (await headCommit(vaultDir()))!;
    expect(head.subject).toBe(REPAIR_COMMIT_MESSAGE);
    const files = (await git(vaultDir(), ["show", "--name-only", "--format=", "HEAD"])).stdout.trim().split("\n").sort();
    expect(files).toEqual([".gitignore", "concepts/catalogue.md", "entities/index.md", "reports/claim-health.md"]);
    expect((await git(vaultDir(), ["cat-file", "-e", "HEAD:reports/claim-health.md"], { allowFail: true })).code).not.toBe(0);
    expect(await status()).toBe("");
    expect(pluginRepairDone()).toBe(true);
  });

  it("never commits an owner's own edit with the repair, and keeps it", async () => {
    await pollutedVault();
    // The owner edited the page whose Related block HEAD holds, and did not commit.
    write("concepts/catalogue.md", related(CATALOGUE.replace("Acme sizes.", "Acme sizes, checked by hand.")));
    await repairPluginWritesOnce();
    expect(read("concepts/catalogue.md")).toBe(CATALOGUE.replace("Acme sizes.", "Acme sizes, checked by hand."));
    const files = (await git(vaultDir(), ["show", "--name-only", "--format=", "HEAD"])).stdout.trim().split("\n");
    expect(files).toEqual([".gitignore"]);
    expect(await status()).toBe("M concepts/catalogue.md");
  });

  it("has nothing to repair in a new vault, and is not run before one exists", async () => {
    expect(await repairPluginWritesOnce()).toEqual({ ran: false, cleaned: [], removed: [], commit: null });
    expect(exists("")).toBe(false);
    await ensureVault();
    const commits = (await git(vaultDir(), ["rev-list", "--count", "HEAD"])).stdout.trim();
    expect(await repairPluginWritesOnce()).toEqual({ ran: true, cleaned: [], removed: [], commit: null });
    expect((await git(vaultDir(), ["rev-list", "--count", "HEAD"])).stdout.trim()).toBe(commits);
    // A new vault's .gitignore already names the plugin's files.
    for (const line of PLUGIN_GITIGNORE_LINES) expect(read(".gitignore").split("\n")).toContain(line);
  });

  it("puts back a page whose only change is a block the plugin wrote since, and nothing else", async () => {
    await pollutedVault();
    await repairPluginWritesOnce();
    // The plugin compiles again (an owner who switched its backlinks on by hand).
    write("concepts/pricing.md", related(read("concepts/pricing.md")));
    write("index.md", appendBlock(read("index.md"), "## Generated", "index", "- Total pages: 3"));
    write("concepts/shipping.md", related(read("concepts/shipping.md").replace("Acme ships.", "Acme ships fast.")));
    expect(await restorePluginOnlyEdits(vaultDir())).toEqual(["concepts/pricing.md", "index.md"]);
    expect(read("concepts/pricing.md")).toBe(PRICING);
    expect(await status()).toBe("M concepts/shipping.md");
  });

  it("never writes a page to memory-wiki's own <folder>/index.md", async () => {
    await ensureVault();
    const { buildPage } = await import("@/lib/prime-radiant/writer");
    const { buildClaimIndex } = await import("@/lib/prime-radiant/claims");
    const built = buildPage(
      { i: 0, useful: true, type: "concept", title: "Index", domain: "general", summary: "An index of parts.", details: "", facts: [], privacy: "internal", confidence: 0.7 },
      "~/Documents/index.txt",
      { takenPaths: new Set(), pagesBySource: new Map(), claimIndex: buildClaimIndex([], []), now: new Date("2026-10-15T00:00:00Z") },
    );
    expect(built).toMatchObject({ ok: true, path: "concepts/index-2.md" });
    expect(frontmatter().type).toBe("concept");
  });
});
