import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLAWBOX_READ_ONLY_TOOLS } from "@/lib/clawbox-run-read-tools";
import { contractViolations, paramDescriptionViolations } from "../../../mcp/lib/register";
import {
  DOCS_READ_MAX_CHARS,
  type DocsRoots,
  findSection,
  headingList,
  headingSlug,
  loadDocsIndex,
  mdxToText,
  normaliseToken,
  parseFrontmatter,
  registerDocsTools,
  renderDocPage,
  resetDocsIndexCache,
  resolveDocPath,
  searchDocs,
  splitSections,
} from "../../../mcp/tools/docs";
import { captureRegistrar, type CaptureHarness } from "../helpers/mcp-registrar";

/**
 * TASK-2177 — `docs_search` and `docs_read`: the official docs shipped with the
 * install, searched and read offline by the agent on the box, fenced to
 * docs-site/ and docs/agents/.
 *
 * Four things have to hold: the ranking puts a title or heading hit before a
 * body hit; a section read returns that section and nothing else; a long page
 * is cut under the tool cap WITH a note that says so; and no path — `..`, an
 * absolute one, a hidden file, a link out of the root — opens anything beyond
 * the two roots. The last block checks the real docs in this checkout and that
 * nothing in the packaging leaves them off a box.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

let tmp: string;
let roots: DocsRoots;

function write(rel: string, content: string): void {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const TROUBLESHOOTING = `---
title: "Troubleshooting"
icon: "wrench"
summary: "Symptom-first fixes: connection, login, updates."
---

Find your symptom below. Run the checks in order.

<Frame caption="Settings → System">
  <img src="/images/4.0/settings-system.png" alt="The System settings panel" />
</Frame>

<Tip>
**Fast triage:** is the box reachable at all?
</Tip>

## I can't reach the ClawBox

<AccordionGroup>
  <Accordion title="Use the plain IP">
    Use the raw IP address, never \`clawbox.local\` on Windows.
  </Accordion>
</AccordionGroup>

## Update finished but the box misbehaves

If the update failed half way, the service files may be stale.

<Steps>
  <Step title="Restart the services">
    \`\`\`bash
    sudo systemctl restart clawbox-setup
    # not a heading
    <Fake>kept verbatim</Fake>
    \`\`\`
  </Step>
  <Step title="Re-run the installer">
    Run \`install.sh\` again.
  </Step>
</Steps>

### Still broken after that

Collect the logs and open a ticket.

## Reading logs

Use \`journalctl -u clawbox-setup\`. Reach the box at \`http://<LAN-IP>\`; the guide's fences are \`<!-- edition:x -->\` blocks.
Some text <!-- a comment that
runs on to the next line --> and the rest of it.
`;

const UPDATING = `---
title: "Updating"
summary: "How to update the box."
---

Updates arrive through the System Update app.

## Update from the screen

Open System Update and press the button.

## Update failed or got stuck

The recovery updater hard-syncs the box to the latest release.
`;

const INDEX = `---
title: "ClawBox"
summary: "Your AI. Your hardware."
---

Welcome. An update arrives every few weeks.
`;

const MCP_MD = `# MCP server

The ClawBox MCP server: the tool set per edition. Each <Provider> row names a provider; a < b holds.

## Registration

Every tool goes through \`register.ts\`.
`;

const UPDATE_MD = `# Updates, install and system integration

Routes and the updater.

## The updater

A \`git fetch\` then \`git reset --hard\`; a failed step is recorded.
`;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-mcp-docs-"));
  roots = { site: path.join(tmp, "docs-site"), agents: path.join(tmp, "docs", "agents") };
  write(".env", "SECRETINENV=1\n");
  write("package.json", '{"name":"not-a-doc"}\n');
  write("outside/page.mdx", '---\ntitle: "Outside"\n---\n\nOUTSIDEPAGETEXT\n');
  write("outside/sub/deeper.mdx", '---\ntitle: "Deeper"\n---\n\nOUTSIDEDEEPERTEXT\n');
  write("docs-site/index.mdx", INDEX);
  write("docs-site/.gitignore", "export.zip\n");
  write("docs-site/README.md", "# READMENOTAPAGE\n");
  write("docs-site/llms.txt", "LLMSNOTAPAGE\n");
  write("docs-site/images/x.png", "PNG");
  write("docs-site/_site/leak.mdx", '---\ntitle: "Leak"\n---\n\nBUILDFOLDERLEAK\n');
  write("docs-site/support/troubleshooting.mdx", TROUBLESHOOTING);
  write("docs-site/support/updating.mdx", UPDATING);
  fs.symlinkSync(path.join(tmp, ".env"), path.join(tmp, "docs-site", "support", "escape.mdx"));
  fs.symlinkSync(path.join(tmp, "docs-site", "support", "troubleshooting.mdx"), path.join(tmp, "docs-site", "support", "twin.mdx"));
  fs.symlinkSync(path.join(tmp, "outside"), path.join(tmp, "docs-site", "linkdir"));
  fs.symlinkSync(path.join(tmp, "nowhere", "gone.mdx"), path.join(tmp, "docs-site", "support", "broken.mdx"));
  write("docs/agents/mcp.md", MCP_MD);
  write("docs/agents/update-and-install.md", UPDATE_MD);
  write("docs/agents/nested/deep.md", "# Deep\n\nNESTEDNOTAPAGE\n");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  resetDocsIndexCache();
});

function harness(edition: "openclaw" | "hermes" = "openclaw"): CaptureHarness {
  const h = captureRegistrar(edition);
  registerDocsTools(h.reg, roots);
  return h;
}

async function search(query: string, limit?: number) {
  const out = await harness().call("docs_search", limit === undefined ? { query } : { query, limit });
  if (out.isError) throw new Error(`docs_search failed: ${out.error.code} ${out.error.message}`);
  return JSON.parse(out.text) as {
    hits: { title: string; path: string; section: string; snippet: string }[];
    matches: number;
    pages: number;
    not_shown?: number;
  };
}

async function read(args: Record<string, unknown>) {
  return harness().call("docs_read", args);
}

async function readText(args: Record<string, unknown>): Promise<string> {
  const out = await read(args);
  if (out.isError) throw new Error(`docs_read failed: ${out.error.code} ${out.error.message}`);
  return out.text;
}

describe("the index", () => {
  it("holds every .mdx under docs-site and every top-level .md under docs/agents, and nothing else", () => {
    const paths = loadDocsIndex(roots).map((p) => p.path).sort();
    expect(paths).toEqual([
      "agents/mcp",
      "agents/update-and-install",
      "index",
      "support/troubleshooting",
      // A link to a page INSIDE the root is a page.
      "support/twin",
      "support/updating",
    ]);
  });

  it("takes the title and summary from the frontmatter, or the first H1 of a Markdown page", () => {
    const pages = loadDocsIndex(roots);
    const site = pages.find((p) => p.path === "support/troubleshooting")!;
    expect(site.title).toBe("Troubleshooting");
    expect(site.summary).toBe("Symptom-first fixes: connection, login, updates.");
    const md = pages.find((p) => p.path === "agents/mcp")!;
    expect(md.title).toBe("MCP server");
    // The H1 is the title, not a section; the text under it is the intro.
    expect(md.sections.map((s) => s.heading)).toEqual(["", "Registration"]);
    expect(md.sections[0].text).toContain("the tool set per edition");
  });

  it("is rebuilt when a page changes, checked at most every 30 s", () => {
    const file = path.join(roots.site, "support", "updating.mdx");
    const t0 = 1_000_000;
    expect(loadDocsIndex(roots, t0).find((p) => p.path === "support/updating")!.summary).toBe("How to update the box.");
    fs.writeFileSync(file, UPDATING.replace("How to update the box.", "CHANGED SUMMARY"));
    // A later mtime, whatever the clock did between the two writes.
    const later = new Date(fs.statSync(file).mtimeMs + 5_000);
    fs.utimesSync(file, later, later);
    try {
      // Inside the window: the cached index answers.
      expect(loadDocsIndex(roots, t0 + 10_000).find((p) => p.path === "support/updating")!.summary).toBe("How to update the box.");
      // Past it: the changed file is seen.
      expect(loadDocsIndex(roots, t0 + 31_000).find((p) => p.path === "support/updating")!.summary).toBe("CHANGED SUMMARY");
    } finally {
      fs.writeFileSync(file, UPDATING);
    }
  });
});

describe("search ranking", () => {
  it("puts a heading hit before a body hit, and the page whose title matches before a page mentioning the words", async () => {
    const { hits, matches, pages } = await search("update failed", 20);
    const order = hits.map((h) => `${h.path} :: ${h.section}`);
    // Both words in the heading, the phrase too, and the title says Updating.
    expect(order[0]).toBe("support/updating :: Update failed or got stuck");
    // One word in the heading, the phrase in the body…
    expect(order[1]).toBe("support/troubleshooting :: Update finished but the box misbehaves");
    // …and the same section again through the link, a page of its own.
    expect(order[2]).toBe("support/twin :: Update finished but the box misbehaves");
    const at = (hit: string) => {
      expect(order, hit).toContain(hit);
      return order.indexOf(hit);
    };
    // A heading with one of the words beats a developer note whose title and body have them…
    expect(at("support/updating :: Update from the screen")).toBeLessThan(at("agents/update-and-install :: The updater"));
    // …which beats a page that merely mentions an update in passing.
    expect(at("agents/update-and-install :: The updater")).toBeLessThan(at("index :: (introduction)"));
    expect(matches).toBe(hits.length);
    expect(pages).toBe(5);
  });

  it("stems both sides, so other forms of the words find the heading", async () => {
    const { hits } = await search("updating fails", 2);
    expect(hits[0]).toMatchObject({ path: "support/updating", section: "Update failed or got stuck" });
  });

  it("answers a word found only in a title or summary with that page's introduction, once", async () => {
    const { hits } = await search("hardware");
    expect(hits).toEqual([expect.objectContaining({ path: "index", section: "(introduction)", title: "ClawBox" })]);
  });

  it("returns a snippet around the first matching word, and no more than `limit` hits", async () => {
    const one = await search("update", 1);
    expect(one.hits).toHaveLength(1);
    expect(one.not_shown).toBe(one.matches - 1);
    const { hits } = await search("recovery updater");
    expect(hits[0].snippet).toMatch(/recovery updater/i);
  });

  it("refuses a query with nothing to search for", async () => {
    const out = await harness().call("docs_search", { query: "?? !!" });
    expect(out.isError && out.error.code).toBe("BAD_ARGUMENT");
  });

  it("never indexes what is not a docs page: dotfiles, README, build folders, images, nested notes, links out", async () => {
    // One word each, so the tokenizer cannot split a marker into words a real page has.
    for (const word of ["SECRETINENV", "READMENOTAPAGE", "LLMSNOTAPAGE", "BUILDFOLDERLEAK", "OUTSIDEPAGETEXT", "OUTSIDEDEEPERTEXT", "NESTEDNOTAPAGE"]) {
      const { hits, matches } = await search(word);
      expect({ word, hits, matches }).toEqual({ word, hits: [], matches: 0 });
    }
  });
});

describe("reading a page", () => {
  it("renders the frontmatter title, the path and readable text with the MDX reduced", async () => {
    const text = await readText({ path: "support/troubleshooting" });
    expect(text).toMatch(/^# Troubleshooting\npath: support\/troubleshooting · https:\/\/docs\.clawbox\.com\/support\/troubleshooting\nsummary: Symptom-first/);
    expect(text).not.toMatch(/<\/?(Frame|Accordion|AccordionGroup|Steps|Step|Tip)\b/);
    expect(text).not.toContain("<img");
    expect(text).toContain("[Image: The System settings panel]");
    expect(text).toContain("_Settings → System_");
    expect(text).toContain("**Tip:**\n**Fast triage:**");
    expect(text).toContain("**Use the plain IP**");
    expect(text).toContain("1. **Restart the services**");
    expect(text).toContain("2. **Re-run the installer**");
    // Everything inside a fence is content, tags and hash lines included…
    expect(text).toContain("<Fake>kept verbatim</Fake>");
    expect(text).toContain("# not a heading");
    // …and so is everything inside inline code, however much it looks like markup.
    expect(text).toContain("Reach the box at `http://<LAN-IP>`; the guide's fences are `<!-- edition:x -->` blocks.");
    // Text on either side of a comment that runs over lines survives.
    expect(text).toContain("Some text\n and the rest of it.");
    expect(text).not.toContain("runs on to the next line");
    for (const heading of ["## I can't reach the ClawBox", "## Update finished but the box misbehaves", "### Still broken after that", "## Reading logs"]) {
      expect(text).toContain(heading);
    }
  });

  it("accepts the path with a root prefix or an extension, and a Markdown note by agents/<name>", async () => {
    for (const spelling of ["docs-site/support/troubleshooting.mdx", "support/troubleshooting.mdx", "./support/troubleshooting", "support/troubleshooting/"]) {
      expect(await readText({ path: spelling }), spelling).toContain("path: support/troubleshooting");
    }
    for (const spelling of ["agents/mcp", "agents/mcp.md", "docs/agents/mcp.md"]) {
      const text = await readText({ path: spelling });
      expect(text, spelling).toMatch(/^# MCP server\npath: agents\/mcp\n/);
      expect(text).toContain("## Registration");
      // A Markdown note is not MDX: an angle-bracketed word in prose is text.
      expect(text).toContain("Each <Provider> row names a provider; a < b holds.");
    }
  });

  it("returns one section with its subsections and none of its neighbours", async () => {
    const text = await readText({ path: "support/troubleshooting", section: "Update finished but the box misbehaves" });
    expect(text).toContain("## Update finished but the box misbehaves");
    expect(text).toContain("### Still broken after that");
    expect(text).toContain("Collect the logs");
    expect(text).not.toContain("I can't reach");
    expect(text).not.toContain("## Reading logs");
    expect(text).not.toContain("journalctl");
  });

  it("finds a section by its anchor, by a case-insensitive prefix, and from path#anchor", async () => {
    const byAnchor = await readText({ path: "support/troubleshooting", section: "#update-finished-but-the-box-misbehaves" });
    expect(byAnchor).toContain("## Update finished but the box misbehaves");
    const byPrefix = await readText({ path: "support/troubleshooting", section: "reading LOGS" });
    expect(byPrefix).toContain("## Reading logs");
    expect(byPrefix).not.toContain("## Update finished");
    const fromPath = await readText({ path: "support/troubleshooting#still-broken-after-that" });
    expect(fromPath).toContain("### Still broken after that");
    expect(fromPath).not.toContain("## Reading logs");
    // An explicit section wins over the anchor.
    const explicit = await readText({ path: "support/troubleshooting#still-broken-after-that", section: "Reading logs" });
    expect(explicit).toContain("## Reading logs");
    expect(explicit).not.toContain("Still broken");
  });

  it("refuses an unknown section and names the ones there are", async () => {
    const out = await read({ path: "support/troubleshooting", section: "Nowhere" });
    expect(out.isError && out.error.code).toBe("NOT_FOUND");
    expect(out.isError && out.error.next).toContain('"I can\'t reach the ClawBox" | "Update finished but the box misbehaves"');
  });

  it("names near paths for a page that does not exist", async () => {
    const out = await read({ path: "support/troubleshoot" });
    expect(out.isError && out.error.code).toBe("NOT_FOUND");
    expect(out.isError && out.error.next).toContain('"support/troubleshooting"');
  });
});

describe("truncation", () => {
  const LONG = "support/long";
  beforeAll(() => {
    const sections = Array.from({ length: 12 }, (_, i) => `## Part ${i + 1}\n\n${`Line of part ${i + 1} with words in it.\n`.repeat(120)}`);
    write(`docs-site/${LONG}.mdx`, `---\ntitle: "Long"\n---\n\nIntro.\n\n${sections.join("\n")}`);
  });

  it("cuts a long page under the tool cap, at a line, and says which sections to ask for", async () => {
    const out = await read({ path: LONG });
    expect(out.isError).toBe(false);
    const text = out.isError ? "" : out.text;
    expect(text.length).toBeLessThanOrEqual(DOCS_READ_MAX_CHARS);
    // Our own note, not the register's generic one: it survived the cap.
    expect(text).toMatch(/…\[truncated: this page goes on for [\d,]+ more characters\./);
    expect(text).not.toContain("narrow the query");
    expect(text).toContain('docs_read { path: "support/long", section: … } for one of "Part 1" | "Part 2"');
    // Cut at a line boundary, not mid-word.
    const beforeNote = text.slice(0, text.indexOf("\n\n…[truncated"));
    expect(beforeNote.endsWith(".")).toBe(true);
  });

  it("cuts a long section too, and says so", async () => {
    write("docs-site/support/longsection.mdx", `---\ntitle: "Long section"\n---\n\n## Only\n\n${"A long line of a long section.\n".repeat(600)}\n## After\n\nShort.\n`);
    resetDocsIndexCache();
    const text = await readText({ path: "support/longsection", section: "Only" });
    expect(text.length).toBeLessThanOrEqual(DOCS_READ_MAX_CHARS);
    expect(text).toMatch(/…\[truncated: this section "Only" goes on for [\d,]+ more characters\. The rest of this section is not shown; the published page is at https:\/\/docs\.clawbox\.com\/support\/longsection\.\]/);
    expect(text).not.toContain("## After");
  });

  it("leaves a page that fits alone", () => {
    const page = loadDocsIndex(roots).find((p) => p.path === "support/troubleshooting")!;
    const { text, truncated } = renderDocPage(page);
    expect(truncated).toBe(false);
    expect(text).not.toContain("truncated");
  });

  it("keeps header, body and its own note under the cap however long the summary and the heading list", async () => {
    const summary = "S".repeat(600);
    const sections = Array.from({ length: 160 }, (_, i) => `## A rather long heading number ${i + 1} about something\n\n${"Words words words.\n".repeat(20)}`);
    write("docs-site/support/wide-and-deep-page-with-a-long-path-name.mdx", `---\ntitle: "${"T".repeat(300)}"\nsummary: "${summary}"\n---\n\n${sections.join("\n")}`);
    resetDocsIndexCache();
    const out = await read({ path: "support/wide-and-deep-page-with-a-long-path-name" });
    expect(out.isError).toBe(false);
    const text = out.isError ? "" : out.text;
    expect(text.length).toBeLessThanOrEqual(DOCS_READ_MAX_CHARS);
    expect(text).toMatch(/…\[truncated: this page goes on for [\d,]+ more characters\. Read one part at a time with docs_read .*\+\d+ more\.\]$/s);
    expect(text).not.toContain("narrow the query");
    // The heading list itself never outgrows its own cap.
    const page = loadDocsIndex(roots).find((p) => p.path === "support/wide-and-deep-page-with-a-long-path-name")!;
    expect(headingList(page.sections).length).toBeLessThanOrEqual(1_200);
  });
});

describe("the path guard", () => {
  const BLOCKED = [
    "../package.json",
    "support/../../.env",
    "docs-site/../.env",
    "support/./../.env",
    "/etc/passwd",
    "/home/clawbox/clawbox/.env",
    "~/.ssh/id_rsa",
    "~",
    "C:\\Windows\\win.ini",
    "support\\troubleshooting",
    "support/trouble\u0000shooting",
    ".gitignore",
    "support/.hidden",
    "_site/leak",
    "node_modules/x",
    "https://docs.clawbox.com/support/troubleshooting",
    // A page that is a link to a file outside the docs, and one whose link
    // resolves to nothing at all.
    "support/escape",
    "support/broken",
    // Pages behind a linked folder that leaves the docs — existing or not, at
    // any depth: none may say anything about the far side.
    "linkdir/page",
    "linkdir/missing",
    "linkdir/sub/deeper",
    "linkdir/sub/missing",
    "linkdir/nope/missing",
  ];

  it.each(BLOCKED)("refuses %s with BLOCKED_PATH", async (p) => {
    const out = await read({ path: p });
    expect(out.isError && out.error.code, p).toBe("BLOCKED_PATH");
    if (!out.isError) return;
    expect(out.error.message).not.toContain(tmp);
    expect(out.error.next).not.toContain(tmp);
  });

  it("tells a caller who typed a leading slash or a docs URL the relative path to use", async () => {
    for (const p of ["/support/troubleshooting", "/support/troubleshooting.mdx", "https://docs.clawbox.com/support/troubleshooting"]) {
      const out = await read({ path: p });
      expect(out.isError && out.error.code, p).toBe("BLOCKED_PATH");
      expect(out.isError && out.error.next, p).toContain('path "support/troubleshooting"');
    }
    const unknown = await read({ path: "/etc/passwd" });
    expect(unknown.isError && unknown.error.next).not.toContain("etc/passwd");
  });

  it("opens only .mdx under docs-site and .md under docs/agents, so other files there are not found", async () => {
    for (const p of ["README", "README.md", "llms", "llms.txt", "docs", "images/x", "images/x.png", "agents/nested/deep", "support/nothing", "agents/nope"]) {
      const out = await read({ path: p });
      expect(out.isError && out.error.code, p).toBe("NOT_FOUND");
    }
  });

  it("refuses a folder and an empty path as arguments, not as paths", async () => {
    for (const p of ["agents", "docs-site", "docs/agents", "  "]) {
      const out = await read({ path: p });
      expect(out.isError && out.error.code, p).toBe("BAD_ARGUMENT");
    }
  });

  it("follows a link to a page inside the docs", async () => {
    const text = await readText({ path: "support/twin" });
    expect(text).toContain("# Troubleshooting");
  });

  it("resolves to the real file under the real root, never the typed string", () => {
    const resolved = resolveDocPath("docs-site/support/twin.mdx", roots);
    expect(resolved).toMatchObject({ root: "site", path: "support/twin", anchor: "" });
    expect(resolved.file).toBe(fs.realpathSync(path.join(roots.site, "support", "troubleshooting.mdx")));
    expect(resolveDocPath("agents/mcp#registration", roots)).toMatchObject({ root: "agents", path: "agents/mcp", anchor: "registration" });
  });
});

describe("the pure parts", () => {
  it("parses frontmatter and leaves a page without one alone", () => {
    expect(parseFrontmatter('---\ntitle: "A \\"quoted\\" title"\nicon: x\n---\nbody')).toEqual({
      meta: { title: 'A "quoted" title', icon: "x" },
      body: "body",
    });
    expect(parseFrontmatter("# H1\n\nbody")).toEqual({ meta: {}, body: "# H1\n\nbody" });
  });

  it("slugs headings as the published site does", () => {
    expect(headingSlug('Updates say "up to date" but the version is old')).toBe("updates-say-up-to-date-but-the-version-is-old");
    expect(headingSlug('AI provider errors (401 "Incorrect API key")')).toBe("ai-provider-errors-401-incorrect-api-key");
    expect(headingSlug("I can't reach the ClawBox")).toBe("i-cant-reach-the-clawbox");
  });

  it("stems the common suffixes the same way on both sides", () => {
    for (const word of ["update", "updates", "updated", "updating"]) expect(normaliseToken(word), word).toBe("updat");
    for (const word of ["fail", "fails", "failed", "failing"]) expect(normaliseToken(word), word).toBe("fail");
    // A short plural meets its singular, and a plural -es only where English puts one.
    for (const [a, b] of [["file", "files"], ["note", "notes"], ["page", "pages"], ["setting", "settings"], ["box", "boxes"], ["address", "addresses"], ["release", "releases"], ["match", "matches"]]) {
      expect(normaliseToken(a), `${a} vs ${b}`).toBe(normaliseToken(b));
    }
    expect(normaliseToken("note")).toBe("note");
    expect(normaliseToken("address")).toBe("address");
    expect(normaliseToken("entries")).toBe("entry");
    expect(normaliseToken("ssh")).toBe("ssh");
  });

  it("joins a tag that runs over lines, but never prose with a stray angle bracket", () => {
    expect(mdxToText('<img src="/x.png"\n  alt="Two lines"\n/>\n\nAfter.')).toBe("[Image: Two lines]\n\nAfter.");
    expect(mdxToText("a <b holds here\n\n## Next\n\nText.")).toBe("a <b holds here\n\n## Next\n\nText.");
    expect(mdxToText("<Unclosed forever\n## Next\n\nText.")).toBe("<Unclosed forever\n## Next\n\nText.");
  });

  it("splits sections outside fences only, and finds one by text, slug or prefix", () => {
    const sections = splitSections("intro\n\n## One\n\n```\n# not two\n```\n\n### One A\n\ntext\n\n## Two\n");
    expect(sections.map((s) => [s.level, s.heading])).toEqual([[0, ""], [2, "One"], [3, "One A"], [2, "Two"]]);
    expect(findSection(sections, "two")).toBe(3);
    expect(findSection(sections, "#one-a")).toBe(2);
    expect(findSection(sections, "On")).toBe(1);
    expect(findSection(sections, "nothing")).toBe(-1);
  });

  it("drops comments and imports, keeps callouts as labels", () => {
    expect(mdxToText('import { X } from "y";\n\n<!-- hidden -->\n{/* also\nhidden */}\n<Warning>\nCareful.\n</Warning>\n<Columns cols={2}>\n<Card title="Go" href="/go" icon="x">\nBody.\n</Card>\n</Columns>'))
      .toBe("**Warning:**\nCareful.\n\n**Go** (/go)\nBody.");
  });

  it("searches plain pages handed to it directly, without the registrar", () => {
    const result = searchDocs(loadDocsIndex(roots), "journalctl", 3);
    expect(result.hits[0]).toMatchObject({ path: "support/troubleshooting", section: "Reading logs" });
  });
});

describe("registration", () => {
  it("registers both tools on both editions, read-only, in the core profile, within the description contract", () => {
    for (const edition of ["openclaw", "hermes"] as const) {
      const h = harness(edition);
      expect(h.names().sort()).toEqual(["docs_read", "docs_search"]);
      for (const tool of h.reg.list()) {
        expect(tool.opts, tool.name).toMatchObject({ readOnly: true, profile: "core" });
        expect(tool.opts.destructive, tool.name).toBeUndefined();
        expect([...contractViolations(tool), ...paramDescriptionViolations(tool)], tool.name).toEqual([]);
      }
      expect(h.get("docs_search").shape).toHaveProperty("query");
      expect(h.get("docs_search").shape).toHaveProperty("limit");
      expect(h.get("docs_read").shape).toHaveProperty("path");
      expect(h.get("docs_read").shape).toHaveProperty("section");
      expect(h.get("docs_read").opts.maxChars).toBe(DOCS_READ_MAX_CHARS);
    }
  });

  it("is in the read-only set a run may be handed", () => {
    expect(CLAWBOX_READ_ONLY_TOOLS).toContain("docs_search");
    expect(CLAWBOX_READ_ONLY_TOOLS).toContain("docs_read");
  });

  it("answers NOT_FOUND, not a missing tool, on a box without its docs folders", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-mcp-nodocs-"));
    try {
      const h = captureRegistrar("openclaw");
      registerDocsTools(h.reg, { site: path.join(empty, "docs-site"), agents: path.join(empty, "docs", "agents") });
      const out = await h.call("docs_search", { query: "update" });
      expect(out.isError && out.error.code).toBe("NOT_FOUND");
      expect(out.isError && out.error.message).toContain("not installed");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("the docs shipped in this checkout", () => {
  const real: DocsRoots = { site: path.join(REPO_ROOT, "docs-site"), agents: path.join(REPO_ROOT, "docs", "agents") };

  it("index every page with a title, and the support pages are among them", () => {
    const pages = loadDocsIndex(real);
    const site = pages.filter((p) => p.root === "site");
    const agents = pages.filter((p) => p.root === "agents");
    expect(site.length).toBeGreaterThanOrEqual(37);
    expect(agents.length).toBeGreaterThanOrEqual(26);
    expect(pages.filter((p) => !p.title).map((p) => p.path)).toEqual([]);
    for (const must of ["support/troubleshooting", "support/recovery", "support/updating", "support/faq", "agents/mcp", "agents/update-and-install"]) {
      expect(pages.map((p) => p.path)).toContain(must);
    }
  });

  it("find the support pages for a symptom", async () => {
    const h = captureRegistrar("openclaw");
    registerDocsTools(h.reg, real);
    const out = await h.call("docs_search", { query: "update failed", limit: 8 });
    expect(out.isError).toBe(false);
    const { hits } = JSON.parse(out.isError ? "{}" : out.text) as { hits: { path: string; section: string }[] };
    expect(hits.length).toBe(8);
    expect(hits.some((hit) => hit.path === "support/troubleshooting" || hit.path === "support/updating")).toBe(true);
    const reach = await h.call("docs_search", { query: "can't reach the box", limit: 5 });
    const reachHits = JSON.parse(reach.isError ? "{}" : reach.text) as { hits: { path: string; section: string }[] };
    expect(reachHits.hits.map((hit) => hit.path)).toContain("support/troubleshooting");
  });

  it("answer whole JSON under the list cap at the widest limit and the longest query", async () => {
    const h = captureRegistrar("openclaw");
    registerDocsTools(h.reg, real);
    const query = "update gateway network password hermes openclaw telegram backup memory shard prime radiant coding agent ".repeat(2).slice(0, 200);
    const out = await h.call("docs_search", { query, limit: 20 });
    expect(out.isError).toBe(false);
    const text = out.isError ? "" : out.text;
    expect(text.length).toBeLessThanOrEqual(8_000);
    expect(text).not.toContain("narrow the query");
    const parsed = JSON.parse(text) as { hits: unknown[]; matches: number; not_shown?: number };
    expect(parsed.hits.length).toBeGreaterThan(0);
    expect(parsed.hits.length + (parsed.not_shown ?? 0)).toBe(parsed.matches);
  });

  it("read the troubleshooting page whole and by section, with no heading taken from a code block", async () => {
    const h = captureRegistrar("hermes");
    registerDocsTools(h.reg, real);
    const whole = await h.call("docs_read", { path: "support/troubleshooting" });
    expect(whole.isError).toBe(false);
    const text = whole.isError ? "" : whole.text;
    expect(text).toMatch(/^# Troubleshooting\n/);
    expect(text).toContain("clawbox.local");
    expect(text).toContain("## I can't reach the ClawBox");
    expect(text.length).toBeLessThanOrEqual(DOCS_READ_MAX_CHARS);
    const page = loadDocsIndex(real).find((p) => p.path === "support/troubleshooting")!;
    expect(page.sections.map((s) => s.heading)).not.toContain(expect.stringContaining("[access]"));
    const section = await h.call("docs_read", { path: "support/troubleshooting", section: "Update finished but the box misbehaves" });
    expect(section.isError).toBe(false);
    expect(section.isError ? "" : section.text).toContain("## Update finished but the box misbehaves");
    expect(section.isError ? "" : section.text).not.toContain("## Reading logs");
    const note = await h.call("docs_read", { path: "agents/mcp" });
    expect(note.isError).toBe(false);
    expect(note.isError ? "" : note.text).toMatch(/^# MCP server\npath: agents\/mcp\n/);
  });

  it("are not left out of the install by the packaging or the installers", () => {
    const text = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8");
    // A full clone, kept by fetch + reset --hard: no sparse checkout, no
    // export-ignore, and no ignore RULE — however spelled — that matches a
    // docs page or a folder on the way to one.
    const SAMPLES = ["docs-site", "docs-site/support", "docs-site/support/troubleshooting.mdx", "docs", "docs/agents", "docs/agents/mcp.md"];
    const ruleMatches = (rule: string, sample: string): boolean => {
      // gitignore semantics, the part that matters here: a pattern without a
      // slash matches a basename anywhere; `**` crosses folders; `*` and `?`
      // stay within one; a leading `/` anchors; a trailing `/` names a folder.
      let pattern = rule.trim().replace(/\/$/, "");
      const anchored = pattern.startsWith("/") || pattern.slice(0, -1).includes("/");
      pattern = pattern.replace(/^\//, "");
      const re = pattern
        .split("**").map((part) => part.split("*").map((p) => p.split("?").map((q) => q.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("[^/]")).join("[^/]*")).join(".*");
      return new RegExp(anchored ? `^${re}$` : `(^|/)${re}$`).test(sample);
    };
    const rules = text(".dockerignore").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("!"));
    const offending = rules.filter((rule) => SAMPLES.some((sample) => ruleMatches(rule, sample)));
    expect(offending, ".dockerignore").toEqual([]);
    expect(ruleMatches("docs-site", "docs-site")).toBe(true); // the matcher sees what it is for
    expect(ruleMatches("**/*.mdx", "docs-site/support/troubleshooting.mdx")).toBe(true);
    expect(ruleMatches("*.md", "docs/agents/mcp.md")).toBe(true);
    expect(ruleMatches("node_modules", "docs/agents/mcp.md")).toBe(false);
    expect(text(".gitattributes")).not.toMatch(/export-ignore/);
    for (const file of ["install.sh", "install-x64.sh", "src/lib/updater.ts"]) {
      expect(text(file), file).not.toMatch(/sparse-checkout/);
    }
    expect(fs.existsSync(path.join(REPO_ROOT, "docs-site", "support", "troubleshooting.mdx"))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, "docs", "agents", "mcp.md"))).toBe(true);
  });
});
