/**
 * Links between pages: `[[wikilinks]]` (Obsidian style, with `|alias` and
 * `#heading`) and relative Markdown links `[text](../entities/acme.md)`.
 *
 * Pure. A link is resolved against the set of known page paths:
 *   - a Markdown link relative to the linking page's folder;
 *   - a wikilink by vault path (with or without `.md`), then by a page's
 *     former path (a path-shaped alias: rename.ts keeps a renamed page's old
 *     path in its `aliases`, so a link to it still leads there), then by file
 *     name, then by page title (case-insensitive) — the first that is
 *     unambiguous.
 */

export interface LinkTargetPage {
  path: string;
  title?: string;
  /** The page's `aliases`; only path-shaped ones ({@link isPathAlias}) are link targets. */
  aliases?: readonly string[];
}

const PATH_ALIAS_RE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/;

/** An alias that is a vault path a page was once at (`concepts/x-3`), not a name it goes by. */
export function isPathAlias(alias: string): boolean {
  return PATH_ALIAS_RE.test(alias.trim());
}

/** The path-shaped aliases in a frontmatter's `aliases` (a string or a list), as `.md` paths. */
export function pathAliases(aliases: unknown): string[] {
  const list = typeof aliases === "string" ? [aliases] : Array.isArray(aliases) ? aliases : [];
  return list
    .filter((a): a is string => typeof a === "string" && isPathAlias(a))
    .map((a) => {
      const t = a.trim();
      return t.toLowerCase().endsWith(".md") ? t : `${t}.md`;
    });
}

const WIKILINK_RE = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
const MD_LINK_RE = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export interface RawLink {
  kind: "wiki" | "md";
  target: string;
}

/** Strip fenced and inline code, where a `[[x]]` is an example and not a link. */
function withoutCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

export function extractLinks(body: string): RawLink[] {
  const text = withoutCode(body);
  const out: RawLink[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) out.push({ kind: "wiki", target: m[1].trim() });
  for (const m of text.matchAll(MD_LINK_RE)) {
    const target = m[1].trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/")) continue;
    const bare = target.split("#")[0];
    if (!bare.toLowerCase().endsWith(".md")) continue;
    out.push({ kind: "md", target: decodeURIComponentSafe(bare) });
  }
  return out;
}

// The two link shapes above with their parts captured (the same text matches).
const WIKILINK_PARTS_RE = /\[\[([^\]|#\n]+)(#[^\]|\n]*)?(\|[^\]\n]*)?\]\]/g;
const MD_LINK_PARTS_RE = /\[([^\]\n]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g;
const CODE_RE = /```[\s\S]*?```|`[^`\n]*`/g;

/** One link in a body, with the parts a rewrite keeps. `target` is what {@link extractLinks} reads. */
export type FoundLink =
  | { kind: "wiki"; target: string; heading: string | null; alias: string | null }
  | { kind: "md"; target: string; text: string; fragment: string | null; title: string | null };

/**
 * `body` with each link `retarget` answers a replacement for (the whole link's
 * new text) rewritten, every other character as it was. Code is left alone,
 * as {@link extractLinks} leaves it: a `[[x]]` there is an example.
 */
export function rewriteLinks(body: string, retarget: (link: FoundLink) => string | null): { body: string; rewritten: number } {
  let rewritten = 0;
  const prose = (text: string) =>
    text
      .replace(WIKILINK_PARTS_RE, (whole, target: string, heading: string | undefined, alias: string | undefined) => {
        const next = retarget({ kind: "wiki", target: target.trim(), heading: heading === undefined ? null : heading.slice(1), alias: alias === undefined ? null : alias.slice(1) });
        if (next === null || next === whole) return whole;
        rewritten++;
        return next;
      })
      .replace(MD_LINK_PARTS_RE, (whole, text: string, href: string, title: string | undefined) => {
        const target = href.trim();
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/")) return whole;
        const hash = target.indexOf("#");
        const bare = hash < 0 ? target : target.slice(0, hash);
        if (!bare.toLowerCase().endsWith(".md")) return whole;
        const next = retarget({
          kind: "md",
          target: decodeURIComponentSafe(bare),
          text,
          fragment: hash < 0 ? null : target.slice(hash + 1),
          title: title === undefined ? null : title.trim(),
        });
        if (next === null || next === whole) return whole;
        rewritten++;
        return next;
      });
  let out = "";
  let at = 0;
  for (const m of body.matchAll(CODE_RE)) {
    out += prose(body.slice(at, m.index)) + m[0];
    at = m.index + m[0].length;
  }
  out += prose(body.slice(at));
  return { body: out, rewritten };
}

/** The relative Markdown href from the page `fromPage` to the page `toPage` (both vault paths). */
export function relativeHref(fromPage: string, toPage: string): string {
  const from = fromPage.split("/").slice(0, -1);
  const to = toPage.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  const rel = [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/");
  return rel.replace(/ /g, "%20");
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function normalizeJoin(fromDir: string, rel: string): string | null {
  const parts = fromDir === "" ? [] : fromDir.split("/");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

export interface LinkResolver {
  resolve(fromPage: string, link: RawLink): string | null;
}

export function createLinkResolver(pages: Iterable<LinkTargetPage>): LinkResolver {
  const byPath = new Set<string>();
  const byFormerPath = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  const byTitle = new Map<string, string[]>();
  for (const p of pages) {
    byPath.add(p.path);
    for (const former of pathAliases(p.aliases)) byFormerPath.set(former, [...(byFormerPath.get(former) ?? []), p.path]);
    const name = p.path.slice(p.path.lastIndexOf("/") + 1).replace(/\.md$/i, "").toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), p.path]);
    if (p.title) {
      const t = p.title.trim().toLowerCase();
      byTitle.set(t, [...(byTitle.get(t) ?? []), p.path]);
    }
  }
  const unique = (list: string[] | undefined) => (list && list.length === 1 ? list[0] : null);
  return {
    resolve(fromPage, link) {
      if (link.kind === "md") {
        const dir = fromPage.includes("/") ? fromPage.slice(0, fromPage.lastIndexOf("/")) : "";
        const joined = normalizeJoin(dir, link.target);
        if (joined === null) return null;
        return byPath.has(joined) ? joined : unique(byFormerPath.get(joined));
      }
      const t = link.target.replace(/^\.\//, "");
      const withExt = t.toLowerCase().endsWith(".md") ? t : `${t}.md`;
      if (byPath.has(withExt)) return withExt;
      const moved = unique(byFormerPath.get(withExt));
      if (moved) return moved;
      const name = withExt.slice(withExt.lastIndexOf("/") + 1).replace(/\.md$/i, "").toLowerCase();
      return unique(byName.get(name)) ?? unique(byTitle.get(t.toLowerCase()));
    },
  };
}

export interface LinkGraph {
  /** page -> pages it links to */
  outbound: Map<string, Set<string>>;
  /** page -> pages that link to it (self-links excluded) */
  inbound: Map<string, Set<string>>;
  /** pages index.md links to */
  indexed: Set<string>;
}

export function buildLinkGraph(
  pages: Iterable<LinkTargetPage & { body: string }>,
  indexBody: string | null,
): LinkGraph {
  const list = [...pages];
  const resolver = createLinkResolver(list);
  const outbound = new Map<string, Set<string>>();
  const inbound = new Map<string, Set<string>>();
  for (const p of list) {
    const out = new Set<string>();
    for (const link of extractLinks(p.body)) {
      const target = resolver.resolve(p.path, link);
      if (target && target !== p.path) out.add(target);
    }
    outbound.set(p.path, out);
    for (const target of out) {
      const set = inbound.get(target) ?? new Set<string>();
      set.add(p.path);
      inbound.set(target, set);
    }
  }
  const indexed = new Set<string>();
  if (indexBody !== null) {
    for (const link of extractLinks(indexBody)) {
      const target = resolver.resolve("index.md", link);
      if (target) indexed.add(target);
    }
  }
  return { outbound, inbound, indexed };
}

/** The folders whose pages are the wiki's content: what orphans are counted over. */
export const CONTENT_FOLDERS: readonly string[] = ["concepts/", "entities/", "syntheses/"];

/** A content page: not index.md, not `_views/` or `reports/`, not a `sources/` page. */
export function isContentPage(rel: string): boolean {
  return CONTENT_FOLDERS.some((folder) => rel.startsWith(folder));
}

function anyContentOther(pages: ReadonlySet<string> | undefined, self: string): boolean {
  if (pages) for (const p of pages) if (p !== self && isContentPage(p)) return true;
  return false;
}

export interface ContentReach {
  /**
   * Content pages no OTHER content page links to. index.md lists every page,
   * so a listing there (or a link from `_views/`, a report or a source page)
   * does not count.
   */
  orphans: Set<string>;
  /** The orphans that link to no other content page either: no link in or out. */
  isolated: Set<string>;
}

/** Orphan and isolated content pages of a link graph, in one pass over its links. */
export function contentReach(graph: Pick<LinkGraph, "outbound" | "inbound">): ContentReach {
  const orphans = new Set<string>();
  const isolated = new Set<string>();
  for (const [page, out] of graph.outbound) {
    if (!isContentPage(page) || anyContentOther(graph.inbound.get(page), page)) continue;
    orphans.add(page);
    if (!anyContentOther(out, page)) isolated.add(page);
  }
  return { orphans, isolated };
}
