/**
 * Links between pages: `[[wikilinks]]` (Obsidian style, with `|alias` and
 * `#heading`) and relative Markdown links `[text](../entities/acme.md)`.
 *
 * Pure. A link is resolved against the set of known page paths:
 *   - a Markdown link relative to the linking page's folder;
 *   - a wikilink by vault path (with or without `.md`), then by file name,
 *     then by page title (case-insensitive) — the first that is unambiguous.
 */

export interface LinkTargetPage {
  path: string;
  title?: string;
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
  const byName = new Map<string, string[]>();
  const byTitle = new Map<string, string[]>();
  for (const p of pages) {
    byPath.add(p.path);
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
        return joined !== null && byPath.has(joined) ? joined : null;
      }
      const t = link.target.replace(/^\.\//, "");
      const withExt = t.toLowerCase().endsWith(".md") ? t : `${t}.md`;
      if (byPath.has(withExt)) return withExt;
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
