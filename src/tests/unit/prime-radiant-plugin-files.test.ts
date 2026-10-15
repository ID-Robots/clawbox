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

import { parsePage, serializePage } from "@/lib/prime-radiant/frontmatter";
import { git, headCommit } from "@/lib/prime-radiant/git";
import { lintVault } from "@/lib/prime-radiant/lint";
import { isKnowledgePage, vaultDir } from "@/lib/prime-radiant/paths";
import {
  isPluginOwnedPath,
  isPristineInbox,
  isPristinePluginIndex,
  isPristinePluginReport,
  isPristineWikiOverview,
  PLUGIN_GITIGNORE_LINES,
  stripManagedBlocks,
  withPluginGitignore,
} from "@/lib/prime-radiant/plugin-files";
import { pluginRepairDone, REPAIR_COMMIT_MESSAGE, repairPluginWritesOnce, restorePluginOnlyEdits } from "@/lib/prime-radiant/plugin-repair";
import { ensureVault, readVaultSnapshot, vaultOperation } from "@/lib/prime-radiant/vault";
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
    const clean = lintVault(snapshot(pages), { scope: null });
    const touched = lintVault(
      snapshot(Object.fromEntries(Object.entries(pages).map(([p, t]) => [p, related(t)]))),
      { scope: null },
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

describe("a vault memory-wiki wrote into", () => {
  it("is read, linted and listed as if the plugin had not been there", async () => {
    await pollutedVault();
    const snap = await readVaultSnapshot();
    expect(snap.pages.map((p) => p.path)).toEqual(["concepts/catalogue.md", "concepts/pricing.md", "concepts/shipping.md"]);
    expect(snap.indexBody).not.toContain("openclaw:wiki");
    const report = lintVault(snap, { scope: null });
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
