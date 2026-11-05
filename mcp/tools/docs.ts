// The product docs as tools: `docs_search` and `docs_read` over the pages that
// SHIP WITH THE INSTALLED VERSION — docs-site/**/*.mdx (the user guide, the
// support pages: troubleshooting, recovery, updating, FAQ; the technical
// reference) and docs/agents/*.md (the engineering notes) — so an agent on the
// box can troubleshoot from the official docs, offline, and from the docs that
// describe the software it is actually running (TASK-2177).
//
// WHY ON DISK AND NOT docs.clawbox.com: the box that most needs the docs is the
// one whose network, update or gateway just failed, and the published site
// describes the latest release, not the one on this box. The install is a full
// git clone kept by `git fetch` + `git reset --hard` (install.sh,
// src/lib/updater.ts), so both folders are on every box after install and after
// every update; nothing in .dockerignore or the installers leaves them out
// (src/tests/unit/mcp-docs-tools.test.ts holds that).
//
// READ-ONLY AND FENCED. A page is named by a RELATIVE path under one of the two
// roots — `support/troubleshooting`, `agents/mcp` — and the roots come from the
// install folder the server already knows (DEFAULT_CWD, the same answer the
// field guide is read from). `..`, an absolute path, a hidden or build segment
// and a link whose target leaves its root are refused, and only `.mdx` under
// docs-site and `.md` under docs/agents are ever opened — the extension is
// appended here, never taken from the caller — so nothing else in the checkout
// can be read through these two tools.
//
// SEARCH is a small in-process index: every heading's block is one unit, scored
// so that a word in the page title or the section heading outranks the same
// word in a body (a symptom is usually a heading on the troubleshooting page),
// with a light suffix stemmer so "update failed" finds "Updates fail" and
// "updating". Built on first use and re-checked against the files' sizes and
// mtimes every 30 s, so an update that replaced the pages under a long-lived
// server is seen without a restart.

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, join, sep } from "path";
import { ToolError } from "../lib/errors";
import { DEFAULT_CWD } from "../lib/guard";
import { json, LIST_MAX_CHARS, text, type Registrar } from "../lib/register";
import { zInt, zOptText, zText } from "../lib/schema";

export interface DocsRoots {
  /** docs-site/ — the published user and technical docs, MDX. */
  site: string;
  /** docs/agents/ — the engineering notes, Markdown, top level only. */
  agents: string;
}

type RootKey = keyof DocsRoots;

/** The two roots under the installed ClawBox folder. */
export function defaultDocsRoots(): DocsRoots {
  return { site: join(DEFAULT_CWD, "docs-site"), agents: join(DEFAULT_CWD, "docs", "agents") };
}

/** How a page under each root is named and which files count as pages. */
const ROOT_SPEC: Record<RootKey, { ext: string; prefix: string; recursive: boolean }> = {
  site: { ext: ".mdx", prefix: "", recursive: true },
  agents: { ext: ".md", prefix: "agents/", recursive: false },
};

/** The published copy of a docs-site page, for the owner's own browser. */
const PUBLISHED_DOCS = "https://docs.clawbox.com";

/**
 * `docs_read`'s output cap, and the body cap it applies itself underneath it.
 *
 * The register's `capText` would also cut the text, but at an arbitrary
 * character and with a generic note. Cutting here, at a line, leaves room under
 * the tool cap for a note that says WHAT was left out and how to read it a
 * section at a time — which is the whole point of saying so.
 */
export const DOCS_READ_MAX_CHARS = 16_000;
const BODY_CAP = 14_000;

/** The longest list of headings a truncation note or a NOT_FOUND carries. */
const HEADING_LIST_CAP = 1_200;

/** Most hits one page may take, so one long page cannot fill the list. */
const HITS_PER_PAGE = 3;

const DEFAULT_LIMIT = 8;
const REVALIDATE_MS = 30_000;

// ── Pages ────────────────────────────────────────────────────────────────────

export interface DocSection {
  /** The heading text; "" for the text before the first heading. */
  heading: string;
  /** 1–6; 0 for the intro block. */
  level: number;
  /** The heading's anchor, as the published site spells it. */
  slug: string;
  /** This heading's own text, readable, up to the next heading of any level. */
  text: string;
}

export interface DocPage {
  /** `support/troubleshooting`, `agents/mcp` — what docs_read takes. */
  path: string;
  root: RootKey;
  /** The real file, vetted at index time. */
  file: string;
  title: string;
  summary: string;
  sections: DocSection[];
}

interface IndexedSection extends DocSection {
  tokens: Map<string, number>;
  headingTokens: Set<string>;
  lower: string;
  headingLower: string;
}

interface IndexedPage extends DocPage {
  sections: IndexedSection[];
  titleTokens: Set<string>;
  summaryTokens: Set<string>;
  titleLower: string;
}

/** `---` frontmatter at the top of a page, as `key: value` lines. */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = unquote(kv[2].trim());
  }
  return { meta, body: raw.slice(m[0].length) };
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

const FENCE_RE = /^\s*(```|~~~)/;
/** An MDX component tag: capitalised, so `<img>` and `<br>` are not it. */
const COMPONENT_TAG_RE = /<(\/?)([A-Z][A-Za-z0-9]*)\b([^<>]*?)(\/?)>/g;
const IMG_TAG_RE = /<img\b([^<>]*?)\/?>/gi;
const BR_TAG_RE = /<br\s*\/?>/gi;
/** A `title="…"` style attribute (also single-quoted, also `{`…`}`). */
function attr(tag: string, name: string): string {
  const m = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)'|\\{\`([^\`]*)\`\\})`).exec(tag);
  return (m && (m[1] ?? m[2] ?? m[3])) || "";
}

const CALLOUTS = new Set(["Note", "Tip", "Warning", "Info", "Check", "Danger", "Callout"]);
const TITLED = new Set(["Accordion", "Card", "Tab", "Expandable", "ParamField", "ResponseField"]);

/**
 * MDX to readable text: components become their titles and callout labels,
 * images their alt text, wrappers nothing; fenced code and everything in it
 * is kept as written (a `<Tag>` inside a code block is content, not markup).
 */
export function mdxToText(body: string): string {
  const out: string[] = [];
  let inFence = false;
  let fence = "";
  let inComment: "html" | "jsx" | null = null;
  let steps = 0;
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    const fenceOpen = FENCE_RE.exec(line);
    if (inFence) {
      out.push(line);
      if (fenceOpen && fenceOpen[1] === fence) inFence = false;
      continue;
    }
    if (fenceOpen) {
      inFence = true;
      fence = fenceOpen[1];
      out.push(line);
      continue;
    }
    // A tag that opens on this line and closes on a later one is joined first,
    // so its attributes are read whole (an <img> with alt on its own line).
    if (/<[A-Za-z][^<>]*$/.test(line) && !line.includes(">")) {
      let joined = line;
      let j = i + 1;
      while (j < lines.length && j - i < 12 && !lines[j].includes(">")) {
        joined += " " + lines[j].trim();
        j += 1;
      }
      if (j < lines.length) {
        joined += " " + lines[j].trim();
        line = joined;
        i = j;
      }
    }
    // Comments, HTML and JSX, possibly spanning lines.
    line = stripComments(line, (state) => { inComment = state; }, inComment);
    if (inComment) continue;
    if (/^\s*(import\s.+\sfrom\s+["'].+["']|export\s+(const|default|function)\b)/.test(line)) continue;

    line = line.replace(IMG_TAG_RE, (tag) => {
      const alt = attr(tag, "alt");
      return alt ? `[Image: ${alt}]` : "";
    });
    line = line.replace(BR_TAG_RE, "\n");
    line = line.replace(COMPONENT_TAG_RE, (_whole, closing: string, name: string, attrs: string) => {
      if (closing) return "";
      if (name === "Steps") {
        steps = 0;
        return "";
      }
      if (name === "Step") {
        steps += 1;
        const title = attr(attrs, "title");
        return title ? `${steps}. **${title}**` : `${steps}.`;
      }
      if (TITLED.has(name)) {
        const title = attr(attrs, "title");
        const href = attr(attrs, "href");
        if (!title) return "";
        return href ? `**${title}** (${href})` : `**${title}**`;
      }
      if (name === "Frame") {
        const caption = attr(attrs, "caption");
        return caption ? `_${caption}_` : "";
      }
      if (CALLOUTS.has(name)) return `**${name}:** `;
      return "";
    });
    out.push(line.replace(/[ \t]+$/, ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripComments(
  line: string,
  setState: (state: "html" | "jsx" | null) => void,
  state: "html" | "jsx" | null,
): string {
  let rest = line;
  let kept = "";
  let current = state;
  for (let guard = 0; guard < 20; guard += 1) {
    if (current) {
      const close = current === "html" ? rest.indexOf("-->") : rest.indexOf("*/}");
      if (close < 0) {
        setState(current);
        return kept;
      }
      rest = rest.slice(close + 3);
      current = null;
      continue;
    }
    const html = rest.indexOf("<!--");
    const jsx = rest.indexOf("{/*");
    const at = html < 0 ? jsx : jsx < 0 ? html : Math.min(html, jsx);
    if (at < 0) {
      setState(null);
      return kept + rest;
    }
    kept += rest.slice(0, at);
    current = at === html ? "html" : "jsx";
    rest = rest.slice(at + (current === "html" ? 4 : 3));
  }
  setState(current);
  return kept;
}

/** A heading's anchor the way the published site writes it. */
export function headingSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Split readable text into its heading blocks; headings inside fences are text. */
export function splitSections(readable: string): DocSection[] {
  const sections: DocSection[] = [];
  let current: DocSection = { heading: "", level: 0, slug: "", text: "" };
  const buf: string[] = [];
  let inFence = false;
  let fence = "";
  const flush = () => {
    current.text = buf.join("\n").trim();
    buf.length = 0;
    sections.push(current);
  };
  for (const line of readable.split("\n")) {
    const fenceOpen = FENCE_RE.exec(line);
    if (inFence) {
      buf.push(line);
      if (fenceOpen && fenceOpen[1] === fence) inFence = false;
      continue;
    }
    if (fenceOpen) {
      inFence = true;
      fence = fenceOpen[1];
      buf.push(line);
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      flush();
      const heading = h[2].trim();
      current = { heading, level: h[1].length, slug: headingSlug(heading), text: "" };
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
}

/** One page from its raw text: title and summary from the frontmatter or the H1, sections from the rest. */
export function parseDocPage(raw: string, path: string, root: RootKey, file: string): DocPage {
  const { meta, body } = parseFrontmatter(raw);
  const readable = mdxToText(body);
  let sections = splitSections(readable);
  let title = meta.title ?? "";
  // A Markdown page carries its title as the first H1; it is the title, not a
  // section, so it is lifted out and the text under it becomes the intro.
  if (!title) {
    const at = sections.findIndex((s) => s.level === 1);
    if (at >= 0 && sections.slice(0, at).every((s) => !s.text)) {
      title = sections[at].heading;
      sections = [{ heading: "", level: 0, slug: "", text: sections[at].text }, ...sections.slice(at + 1)];
    }
  }
  if (!title) title = path.split("/").pop() ?? path;
  return { path, root, file, title, summary: meta.summary ?? meta.description ?? "", sections };
}

// ── The index ────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "it", "its", "my", "i", "this", "that",
  "with", "be", "not", "do", "does", "how", "what", "why", "when", "at", "by", "from", "as", "are", "was", "me",
  "you", "your", "if", "but", "so", "no", "up", "out", "into", "there", "then", "than", "have", "has", "get",
  "got", "will", "would", "should", "could", "about", "any", "some", "all", "just", "also", "am", "can",
]);

/**
 * A light suffix stemmer, applied to the index and the query alike, so the
 * two sides agree on "update" / "updates" / "updated" / "updating" without a
 * dictionary. It is not English — "hermes" becomes "herm" on both sides — and
 * that is fine: only equality between the two sides matters.
 */
export function normaliseToken(token: string): string {
  let s = token;
  if (s.length > 4 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else if (s.length > 3 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("es")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  if (s.length > 4 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

function rawTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

function tokenCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of rawTokens(value)) {
    const n = normaliseToken(t);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return counts;
}

function tokenSet(value: string): Set<string> {
  return new Set(rawTokens(value).map(normaliseToken));
}

function indexPage(page: DocPage): IndexedPage {
  return {
    ...page,
    titleTokens: tokenSet(page.title),
    summaryTokens: tokenSet(page.summary),
    titleLower: page.title.toLowerCase(),
    sections: page.sections.map((s) => ({
      ...s,
      tokens: tokenCounts(s.text),
      headingTokens: tokenSet(s.heading),
      lower: s.text.toLowerCase(),
      headingLower: s.heading.toLowerCase(),
    })),
  };
}

interface DocFile {
  root: RootKey;
  path: string;
  file: string;
  size: number;
  mtimeMs: number;
}

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function within(real: string, realRoot: string): boolean {
  return real === realRoot || real.startsWith(realRoot + sep);
}

/** A hidden file, a Mintlify build folder (`_site`), node_modules: never a page. */
function skippedSegment(name: string): boolean {
  return name.startsWith(".") || name.startsWith("_") || name === "node_modules";
}

/**
 * Every page under one root, as vetted real files. A link is followed only
 * when its target is a regular file inside the same root; a linked folder is
 * never descended (a loop, or a way out).
 */
function listRoot(root: RootKey, dir: string): DocFile[] {
  const spec = ROOT_SPEC[root];
  const realRoot = tryRealpath(dir);
  if (!realRoot) return [];
  const out: DocFile[] = [];
  const walk = (at: string, rel: string[]) => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skippedSegment(entry.name)) continue;
      const full = join(at, entry.name);
      if (entry.isDirectory()) {
        if (spec.recursive) walk(full, [...rel, entry.name]);
        continue;
      }
      if (!entry.name.endsWith(spec.ext)) continue;
      let real = full;
      if (entry.isSymbolicLink()) {
        const target = tryRealpath(full);
        if (!target || !within(target, realRoot)) continue;
        real = target;
      } else if (!entry.isFile()) {
        continue;
      }
      let st;
      try {
        st = statSync(real);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const base = entry.name.slice(0, -spec.ext.length);
      out.push({
        root,
        path: spec.prefix + [...rel, base].join("/"),
        file: real,
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  };
  walk(realRoot, []);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

interface CachedIndex {
  pages: IndexedPage[];
  fingerprint: string;
  checkedAt: number;
}

const cache = new Map<string, CachedIndex>();

/** For tests: forget every built index. */
export function resetDocsIndexCache(): void {
  cache.clear();
}

/**
 * The pages under both roots, parsed and indexed; built once, re-checked
 * against the files' sizes and mtimes every REVALIDATE_MS.
 */
export function loadDocsIndex(roots: DocsRoots, now: number = Date.now()): DocPage[] {
  return loadIndexed(roots, now);
}

function loadIndexed(roots: DocsRoots, now: number): IndexedPage[] {
  const key = `${roots.site}\n${roots.agents}`;
  const have = cache.get(key);
  if (have && now - have.checkedAt < REVALIDATE_MS) return have.pages;
  const files = [...listRoot("site", roots.site), ...listRoot("agents", roots.agents)];
  const fingerprint = files.map((f) => `${f.file}:${f.size}:${f.mtimeMs}`).join("\n");
  if (have && have.fingerprint === fingerprint) {
    have.checkedAt = now;
    return have.pages;
  }
  const pages: IndexedPage[] = [];
  for (const f of files) {
    let raw: string;
    try {
      raw = readFileSync(f.file, "utf-8");
    } catch {
      continue;
    }
    pages.push(indexPage(parseDocPage(raw, f.path, f.root, f.file)));
  }
  cache.set(key, { pages, fingerprint, checkedAt: now });
  return pages;
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface DocHit {
  title: string;
  path: string;
  section: string;
  snippet: string;
  score: number;
}

export interface DocSearchResult {
  hits: DocHit[];
  /** Matching sections before the per-page cap and the limit. */
  matches: number;
  /** Distinct pages among them. */
  pages: number;
}

/**
 * The query's search terms — normalised, stopwords dropped unless nothing else
 * is left — and the phrase: the query as typed, lower-cased, when it has more
 * than one word, so "can't reach the box" is looked for as written.
 */
function queryTerms(query: string): { terms: string[]; raw: string[]; phrase: string } {
  const raw = [...new Set(rawTokens(query))];
  const kept = raw.filter((t) => !STOPWORDS.has(t));
  const use = kept.length ? kept : raw;
  const phrase = raw.length > 1 ? query.toLowerCase().replace(/\s+/g, " ").trim() : "";
  return { terms: [...new Set(use.map(normaliseToken))], raw: use, phrase };
}

/**
 * Where a page lives says who it is for: the support pages are the ones
 * written symptom-first for the owner, the rest of docs-site is the user guide
 * and the technical reference, docs/agents are engineering notes. A small prior,
 * so a symptom finds the page whose steps the agent should follow before the
 * developer note that happens to use the same words.
 */
function areaPrior(page: DocPage): number {
  if (page.root === "agents") return 0;
  return page.path.startsWith("support/") ? 4 : 2;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SNIPPET_CHARS = 220;

function snippetFor(section: IndexedSection, page: IndexedPage, needles: string[], phrase: string): string {
  const plain = section.text.replace(/\s+/g, " ").trim() || page.summary || section.heading;
  if (!plain) return "";
  const lower = plain.toLowerCase();
  let at = phrase ? lower.indexOf(phrase) : -1;
  if (at < 0 && needles.length) {
    const m = new RegExp(`\\b(${needles.map(escapeRe).join("|")})`, "i").exec(plain);
    at = m ? m.index : -1;
  }
  if (at < 0) at = 0;
  let start = Math.max(0, at - 70);
  if (start > 0) {
    const space = plain.indexOf(" ", start);
    if (space >= 0 && space < at) start = space + 1;
  }
  let end = Math.min(plain.length, start + SNIPPET_CHARS);
  if (end < plain.length) {
    const space = plain.lastIndexOf(" ", end);
    if (space > at) end = space;
  }
  return `${start > 0 ? "…" : ""}${plain.slice(start, end).trim()}${end < plain.length ? "…" : ""}`;
}

/**
 * Rank every heading block against the query.
 *
 * The weights, so the order is explainable: a term in the section heading
 * counts 8, in the page title 6, in the frontmatter summary 2, in the body 1
 * per occurrence up to 2; the whole phrase (two or more words) in the title
 * 20, in the heading 12, in the body 6; plus up to 4 for the share of terms
 * found anywhere on the page, 2 when the block itself holds every term, and
 * the area prior (support pages 4, the rest of docs-site 2, docs/agents 0). A
 * block is a hit only when a term is in ITS OWN heading or text (the intro
 * block also for the title and summary) — otherwise every section of the
 * Troubleshooting page would answer "troubleshooting".
 */
export function searchDocs(pages: DocPage[], query: string, limit: number = DEFAULT_LIMIT): DocSearchResult {
  const { terms, raw, phrase } = queryTerms(query);
  if (!terms.length) {
    throw new ToolError(
      "BAD_ARGUMENT",
      "The query has no words to search for.",
      "Pass a few plain words naming the symptom, e.g. \"update failed\" or \"cannot reach the box\".",
    );
  }
  const indexed = pages.map((p) => ("titleTokens" in p ? (p as IndexedPage) : indexPage(p)));
  const scored: { page: IndexedPage; section: IndexedSection; order: number; score: number }[] = [];
  for (const page of indexed) {
    const inTitle = terms.filter((t) => page.titleTokens.has(t));
    const inSummary = terms.filter((t) => page.summaryTokens.has(t));
    const titlePhrase = phrase && page.titleLower.includes(phrase) ? 20 : 0;
    const prior = areaPrior(page);
    page.sections.forEach((section, order) => {
      const inHeading = terms.filter((t) => section.headingTokens.has(t));
      const inBody = terms.filter((t) => section.tokens.has(t));
      const own = new Set([...inHeading, ...inBody, ...(section.level === 0 ? [...inTitle, ...inSummary] : [])]);
      if (!own.size) return;
      const matched = new Set([...own, ...inTitle, ...inSummary]);
      let score = 8 * inHeading.length + 6 * inTitle.length + 2 * inSummary.length + titlePhrase + prior;
      for (const t of inBody) score += Math.min(section.tokens.get(t) ?? 0, 2);
      if (phrase) {
        if (section.headingLower.includes(phrase)) score += 12;
        if (section.lower.includes(phrase)) score += 6;
      }
      score += (4 * matched.size) / terms.length;
      if (own.size === terms.length) score += 2;
      scored.push({ page, section, order, score });
    });
  }
  const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  scored.sort((a, b) => b.score - a.score || byPath(a.page.path, b.page.path) || a.order - b.order);
  const perPage = new Map<string, number>();
  const hits: DocHit[] = [];
  for (const s of scored) {
    if (hits.length >= limit) break;
    const taken = perPage.get(s.page.path) ?? 0;
    if (taken >= HITS_PER_PAGE) continue;
    perPage.set(s.page.path, taken + 1);
    hits.push({
      title: s.page.title,
      path: s.page.path,
      section: s.section.heading || "(introduction)",
      snippet: snippetFor(s.section, s.page, [...new Set([...raw, ...terms])], phrase),
      score: Math.round(s.score * 10) / 10,
    });
  }
  return { hits, matches: scored.length, pages: new Set(scored.map((s) => s.page.path)).size };
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface ResolvedDocPath {
  root: RootKey;
  path: string;
  /** The real file to open — the vetted path, not the typed one. */
  file: string;
  /** A `#fragment` the caller attached, as a section to read. */
  anchor: string;
}

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function blocked(message: string, next: string): ToolError {
  return new ToolError("BLOCKED_PATH", message, next);
}

function notFound(path: string, pages: readonly DocPage[] | undefined): ToolError {
  const hints = pages ? suggestPaths(pages, path) : [];
  return new ToolError(
    "NOT_FOUND",
    `There is no docs page at "${path}".`,
    hints.length
      ? `Did you mean ${hints.map((h) => `"${h}"`).join(", ")}? Otherwise docs_search for it and use the path a hit returns.`
      : "docs_search for the page and use the path a hit returns (e.g. support/troubleshooting).",
  );
}

/** Pages whose path shares a segment with what was asked for, nearest first. */
export function suggestPaths(pages: readonly DocPage[], wanted: string): string[] {
  const parts = wanted.toLowerCase().replace(/\.(mdx|md)$/i, "").split(/[/\\]+/).filter(Boolean);
  if (!parts.length) return [];
  const last = parts[parts.length - 1];
  return pages
    .map((p) => {
      const segs = p.path.toLowerCase().split("/");
      const score = (segs.includes(last) ? 4 : segs.some((s) => s.includes(last) || last.includes(s)) ? 2 : 0)
        + parts.filter((part) => segs.includes(part)).length;
      return { path: p.path, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1))
    .slice(0, 5)
    .map((s) => s.path);
}

/**
 * Turn what the caller typed into a vetted file under one of the two roots, or
 * refuse. The checks run on the TYPED path first — `..`, an absolute path, a
 * hidden segment — so nothing is resolved on disk that was never a docs path,
 * and then on the REAL path, so a link out of the root is refused whether it is
 * the page itself or a folder on the way to it.
 */
export function resolveDocPath(input: string, roots: DocsRoots, pages?: readonly DocPage[]): ResolvedDocPath {
  const typed = input.trim();
  if (!typed) {
    throw new ToolError("BAD_ARGUMENT", "The path was empty.", "Pass a page path as docs_search returns it, e.g. support/troubleshooting.");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(typed) || typed.includes("\\")) {
    throw blocked(
      "That path has characters a docs path never has.",
      "Pass the path exactly as docs_search returned it: words, hyphens and forward slashes.",
    );
  }
  const hash = typed.indexOf("#");
  let p = hash >= 0 ? typed.slice(0, hash) : typed;
  const anchor = hash >= 0 ? typed.slice(hash + 1).trim() : "";
  if (/^(\/|~|[A-Za-z]:[\\/])/.test(p) || /^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
    const stripped = p.replace(/^(\/+|~\/?|[A-Za-z]:[\\/]+)/, "").replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\/?/i, "");
    const known = pages?.find((page) => page.path === stripped.replace(/\.(mdx|md)$/i, "").replace(/\/+$/, ""));
    throw blocked(
      "Docs paths are relative to the installed docs; an absolute path, a home-folder path or a URL is never opened.",
      known
        ? `Call docs_read again with path "${known.path}".`
        : "Call docs_read with the relative path a docs_search hit returned, e.g. support/troubleshooting.",
    );
  }
  p = p.replace(/^\.\//, "").replace(/\/+$/, "");
  const segs = p.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) {
    throw blocked(
      "A docs path cannot contain `..`, `.` or an empty segment.",
      "Pass the path exactly as docs_search returned it, e.g. support/troubleshooting or agents/mcp.",
    );
  }
  let root: RootKey = "site";
  if (segs[0] === "docs-site") segs.shift();
  else if (segs[0] === "docs" && segs[1] === "agents") {
    segs.splice(0, 2);
    root = "agents";
  } else if (segs[0] === "agents") {
    segs.shift();
    root = "agents";
  }
  if (!segs.length) {
    throw new ToolError("BAD_ARGUMENT", `"${typed}" names a folder of the docs, not a page.`, "docs_search for the page you want and pass the path a hit returns.");
  }
  segs[segs.length - 1] = segs[segs.length - 1].replace(/\.(mdx|md)$/i, "");
  for (const seg of segs) {
    if (skippedSegment(seg)) {
      throw blocked("Hidden files and build folders are not docs pages.", "Pass the path of a page, as docs_search returns it.");
    }
    if (!SEGMENT_RE.test(seg)) {
      throw new ToolError("BAD_ARGUMENT", `"${seg}" is not a docs path segment.`, "Docs paths use letters, digits, hyphens, dots and underscores, separated by forward slashes.");
    }
  }
  const spec = ROOT_SPEC[root];
  const path = spec.prefix + segs.join("/");
  if (!spec.recursive && segs.length > 1) throw notFound(path, pages);
  const realRoot = tryRealpath(roots[root]);
  if (!realRoot) {
    throw new ToolError(
      "NOT_FOUND",
      "The docs are not installed on this ClawBox.",
      `Do not retry. The published copy is at ${PUBLISHED_DOCS}; tell the owner the install is missing its docs folder.`,
    );
  }
  const candidate = `${join(realRoot, ...segs)}${spec.ext}`;
  // The FOLDER first, before anything says whether the page exists: a linked
  // folder that leaves the root must not even answer "no such page" about
  // what is on the other side of it.
  const realDir = tryRealpath(dirname(candidate));
  if (!realDir) throw notFound(path, pages);
  if (!within(realDir, realRoot)) {
    throw blocked("That path leads out of the docs folder.", "Pass the path of a page, as docs_search returns it.");
  }
  let link = false;
  try {
    link = lstatSync(candidate).isSymbolicLink();
  } catch {
    throw notFound(path, pages);
  }
  const realFile = tryRealpath(candidate);
  if (!realFile) throw notFound(path, pages);
  if (!within(realFile, realRoot)) {
    throw blocked(
      link ? "That page is a link to a file outside the docs, which is never opened." : "That path leads out of the docs folder.",
      "Pass the path of a page, as docs_search returns it.",
    );
  }
  if (!statSync(realFile).isFile()) throw notFound(path, pages);
  return { root, path, file: realFile, anchor };
}

/** One page by its path: from the index when it is there, else read and parsed now. */
export function readDocPage(input: string, roots: DocsRoots, pages: readonly DocPage[]): { page: DocPage; anchor: string } {
  const resolved = resolveDocPath(input, roots, pages);
  const indexed = pages.find((p) => p.file === resolved.file);
  if (indexed) return { page: indexed, anchor: resolved.anchor };
  const raw = readFileSync(resolved.file, "utf-8");
  return { page: parseDocPage(raw, resolved.path, resolved.root, resolved.file), anchor: resolved.anchor };
}

/** The section a caller named — by heading text, anchor slug or a prefix of either — or null. */
export function findSection(sections: readonly DocSection[], wanted: string): number {
  const asked = wanted.replace(/^#+\s*/, "").trim();
  if (!asked) return -1;
  const slug = headingSlug(asked);
  const lower = asked.toLowerCase();
  const candidates = sections.map((s, i) => ({ s, i })).filter(({ s }) => s.level > 0);
  const pick = (test: (s: DocSection) => boolean) => candidates.find(({ s }) => test(s))?.i ?? -1;
  let at = pick((s) => s.slug === slug || s.heading.toLowerCase() === lower);
  if (at < 0 && slug) at = pick((s) => s.slug.startsWith(slug));
  if (at < 0) at = pick((s) => s.heading.toLowerCase().includes(lower));
  if (at < 0 && slug) at = pick((s) => s.slug.includes(slug));
  return at;
}

/** Section headings as one line, capped, for a note or a refusal. */
export function headingList(sections: readonly DocSection[], maxLevel = 3): string {
  const names = sections.filter((s) => s.level > 0 && s.level <= maxLevel).map((s) => s.heading);
  const shown: string[] = [];
  let used = 0;
  for (const name of names) {
    if (used + name.length + 3 > HEADING_LIST_CAP) break;
    shown.push(name);
    used += name.length + 3;
  }
  const rest = names.length - shown.length;
  return `${shown.map((n) => `"${n}"`).join(" | ")}${rest > 0 ? ` | +${rest} more` : ""}`;
}

function renderBlock(section: DocSection): string {
  const head = section.level > 0 ? `${"#".repeat(section.level)} ${section.heading}` : "";
  return [head, section.text].filter(Boolean).join("\n\n");
}

export interface RenderedPage {
  text: string;
  truncated: boolean;
}

/**
 * The page as the agent reads it: title and path, then the whole body or one
 * section with its subsections, cut at a line under the body cap with a note
 * that says what is missing and how to get it.
 */
export function renderDocPage(page: DocPage, section?: string): RenderedPage {
  const header = [
    `# ${page.title}`,
    `path: ${page.path}${page.root === "site" ? ` · ${PUBLISHED_DOCS}/${page.path}` : ""}`,
    page.summary ? `summary: ${page.summary}` : "",
  ].filter(Boolean).join("\n");

  let body: string;
  let scope: string;
  let hint: string;
  if (section !== undefined && section.trim() !== "") {
    const at = findSection(page.sections, section);
    if (at < 0) {
      throw new ToolError(
        "NOT_FOUND",
        `"${page.title}" has no section called "${section.trim()}".`,
        `Its sections are ${headingList(page.sections) || "(none — read the page without a section)"}. Pass one of those, or leave section out for the whole page.`,
      );
    }
    const top = page.sections[at];
    const blocks: DocSection[] = [top];
    for (let i = at + 1; i < page.sections.length && page.sections[i].level > top.level; i += 1) blocks.push(page.sections[i]);
    body = blocks.map(renderBlock).join("\n\n");
    scope = `section "${top.heading}"`;
    const subs = headingList(blocks.slice(1), 6);
    hint = subs
      ? `Read a part of it with docs_read { path: "${page.path}", section: … } for one of ${subs}.`
      : page.root === "site"
        ? `The rest of this section is not shown; the published page is at ${PUBLISHED_DOCS}/${page.path}.`
        : "The rest of this section is not shown.";
  } else {
    body = page.sections.map(renderBlock).filter(Boolean).join("\n\n");
    scope = "page";
    const list = headingList(page.sections);
    hint = list
      ? `Read one part at a time with docs_read { path: "${page.path}", section: … } for one of ${list}.`
      : "The rest of this page is not shown.";
  }

  let truncated = false;
  if (body.length > BODY_CAP) {
    let cut = body.lastIndexOf("\n", BODY_CAP);
    if (cut < BODY_CAP * 0.6) cut = BODY_CAP;
    const omitted = body.length - cut;
    body = `${body.slice(0, cut).trimEnd()}\n\n…[truncated: this ${scope} goes on for ${omitted.toLocaleString("en-US")} more characters. ${hint}]`;
    truncated = true;
  }
  return { text: `${header}\n\n${body}`, truncated };
}

// ── Registration ─────────────────────────────────────────────────────────────

const DOCS_SEARCH_DESCRIPTION =
  "Search the official ClawBox docs installed on this device — user guide, troubleshooting, recovery, updating, "
  + "FAQ, technical notes — offline. When something on this box fails, search the symptom first (\"update failed\", "
  + "\"cannot reach the box\"), then docs_read the best hit. Each hit: title, path, section, snippet; title and "
  + "heading matches rank first.";

const DOCS_READ_DESCRIPTION =
  "Read one page of the official ClawBox docs installed on this device as plain text — the whole page, or one "
  + "section by its heading. Use the path a docs_search hit returned (e.g. support/troubleshooting, agents/mcp). "
  + "A long page is cut at the cap and the note says which sections to ask for.";

/**
 * Both tools, on both editions and in the core profile: the box running a
 * small on-device model is the one whose agent most needs the docs to hand.
 *
 * @param roots the docs folders; the installed ClawBox's by default, resolved
 *              at CALL time so a test's fixture and a box's real folder are the
 *              same code path.
 */
export function registerDocsTools(reg: Registrar, roots?: DocsRoots): void {
  const rootsNow = () => roots ?? defaultDocsRoots();
  const pagesNow = () => {
    const pages = loadDocsIndex(rootsNow());
    if (!pages.length) {
      throw new ToolError(
        "NOT_FOUND",
        "The docs are not installed on this ClawBox: neither docs-site nor docs/agents is under its install folder.",
        `Do not retry. The published copy is at ${PUBLISHED_DOCS}; tell the owner the install is missing its docs.`,
      );
    }
    return pages;
  };

  reg.tool(
    "docs_search",
    DOCS_SEARCH_DESCRIPTION,
    {
      query: zText(200, "Words or a phrase naming what you look for, e.g. \"update failed\" or \"wifi hotspot\"."),
      limit: zInt(1, 20, DEFAULT_LIMIT, "How many hits to return (1–20)."),
    },
    { editions: ["openclaw", "hermes"], readOnly: true, profile: "core", maxChars: LIST_MAX_CHARS },
    async ({ query, limit }: { query: string; limit?: number }) => {
      const pages = pagesNow();
      const result = searchDocs(pages, query, limit ?? DEFAULT_LIMIT);
      const shown = result.hits.length;
      return json({
        query,
        hits: result.hits.map(({ title, path, section, snippet }) => ({ title, path, section, snippet })),
        matches: result.matches,
        pages: result.pages,
        ...(result.matches > shown ? { not_shown: result.matches - shown } : {}),
        next: shown
          ? "Read a hit with docs_read { path, section }. For a fault on this box, support/troubleshooting is the page whose steps to follow in order."
          : "No page mentions those words. Try other words for the symptom, or docs_read support/troubleshooting and support/faq.",
      });
    },
  );

  reg.tool(
    "docs_read",
    DOCS_READ_DESCRIPTION,
    {
      path: zText(200, "The page's path as docs_search returns it, e.g. support/troubleshooting or agents/mcp."),
      section: zOptText(160, "One heading of the page to return instead of the whole page, as written or as its anchor."),
    },
    { editions: ["openclaw", "hermes"], readOnly: true, profile: "core", maxChars: DOCS_READ_MAX_CHARS },
    async ({ path, section }: { path: string; section?: string }) => {
      const pages = pagesNow();
      const { page, anchor } = readDocPage(path, rootsNow(), pages);
      const rendered = renderDocPage(page, section ?? (anchor || undefined));
      return text(rendered.text);
    },
  );
}
