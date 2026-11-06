/**
 * Meaningless page names, renamed.
 *
 * Before the slugger transliterated Cyrillic (claims.ts `slugify`), a title
 * with no Latin letters left nothing to name its page by: Bulgarian documents
 * became `concepts/x.md`, `x-3.md`, `2026.md`, `3.md`, and different documents
 * collided into `-N` suffixes. This pass gives each such page the name its
 * title transliterates to, in its own folder:
 *
 *   - a page is renamed when its file name is MEANINGLESS ({@link meaninglessSlug}:
 *     only digits, a single letter, or a date, with any `-N` suffixes) and its
 *     title slugs to a name that is not (a title that is itself only a year
 *     keeps its page, `no-better-name`); a taken name gets `-2`, `-3`, …;
 *     a page whose old path cannot be a working alias (an upper-case letter
 *     or a space in a folder name) is left as it is (`no-alias`);
 *   - the old path stays the page's own: it joins its `aliases`
 *     (`concepts/x-3`), and the link resolver (links.ts) leads a link to it
 *     to the page — a redirect for whatever still names it;
 *   - every `[[link]]` (`#heading`, `|alias`) and relative Markdown link that
 *     reaches a renamed page by its path or file name, index.md's included,
 *     names the new path; a link by the page's title still reaches it and is
 *     left as it is; a page whose frontmatter does not parse is not rewritten
 *     (`unparsed`: the alias still resolves its links);
 *   - claims keep their ids (an id names a fact, not a page); the claim
 *     registry, the waiting review items and the stale notes follow the page.
 *
 * ONE commit `rename: N pages with meaningless names`, which Undo reverses
 * whole; at most {@link MAX_RENAMES} pages a run (`more` says how many wait
 * for the next). `dryRun` answers the same and writes nothing — run it first.
 *
 * SERVER ONLY (the planner is pure).
 */

import { slugify } from "./claims";
import type { VaultAuthor } from "./git";
import { createLinkResolver, extractLinks, isPathAlias, pathAliases, relativeHref, rewriteLinks, type FoundLink } from "./links";
import { isKnowledgePage, vaultDir } from "./paths";
import { followMovedClaims } from "./review-store";
import type { PageFrontmatter } from "./schema";
import { syncActiveClaims } from "./state-db";
import { followMovedStaleNotes } from "./verify";
import { INDEX_FILE, readVaultSnapshot, vaultOperation, type VaultSnapshot } from "./vault";

/** A file name that says nothing: one letter or a number (a year, a day) and its `-N` / date parts. */
const MEANINGLESS_SLUG_RE = /^(?:[a-z]|\d+)(?:-\d+)*$/;

/** Whether a page's file name (without `.md`) is meaningless: `x`, `x-3`, `3`, `2026`, `2026-09-14`, `2026-2`. */
export function meaninglessSlug(stem: string): boolean {
  return MEANINGLESS_SLUG_RE.test(stem.toLowerCase());
}

/** Pages one run renames, at most (one commit; the rest wait for the next run). */
export const MAX_RENAMES = 500;
/** The longest new file name, as the writer names pages (writer.ts `pathFor`). */
const SLUG_CHARS = 80;
/** File names a page never takes (memory-wiki's folder index). */
const RESERVED_SLUGS: ReadonlySet<string> = new Set(["index"]);

export interface PageRename {
  from: string;
  to: string;
  title: string;
}

export interface RenameSkip {
  path: string;
  /**
   * `unparsed`: its frontmatter does not parse; `no-better-name`: its title
   * slugs to a meaningless name too; `no-alias`: its path (an upper-case
   * letter or a space in a folder) is no path-shaped alias the link resolver
   * reads, so the redirect would lead nowhere.
   */
  reason: "unparsed" | "no-better-name" | "no-alias";
}

export interface SlugRenameResult {
  dryRun: boolean;
  commit: string | null;
  renamed: PageRename[];
  skipped: RenameSkip[];
  /** Meaningless pages past {@link MAX_RENAMES}, left for the next run. */
  more: number;
  /** Pages whose links were rewritten (index.md included), with how many. */
  relinked: Array<{ path: string; links: number }>;
  links: number;
  /** Pages that link a renamed page but whose frontmatter does not parse: not rewritten (the alias still leads there). */
  unparsed: string[];
  /** Waiting review items that now name the new paths. */
  reviewItems: number;
}

interface RenamePlan {
  result: Omit<SlugRenameResult, "dryRun" | "commit" | "reviewItems">;
  /** Renamed pages, each written at its new path. */
  moves: Array<{ from: string; to: string; frontmatter: PageFrontmatter; body: string }>;
  /** Other pages whose links change. */
  rewrites: Array<{ path: string; frontmatter: PageFrontmatter; body: string }>;
  index: string | null;
}

function stemOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

function folderOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function aliasList(value: unknown): string[] {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return list.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
}

function mdLink(link: FoundLink & { kind: "md" }, href: string): string {
  return `[${link.text}](${href}${link.fragment !== null ? `#${link.fragment}` : ""}${link.title ? ` ${link.title}` : ""})`;
}

/**
 * The whole rename, worked out from a snapshot and written nowhere (pure):
 * which pages move where, the new frontmatter of each (its old path among
 * its aliases), every other page whose links change, and index.md.
 */
export function planSlugRenames(snapshot: Pick<VaultSnapshot, "pages" | "indexBody">, limit = MAX_RENAMES): RenamePlan {
  const taken = new Set(snapshot.pages.map((p) => p.path.toLowerCase()));
  const renamed: PageRename[] = [];
  const skipped: RenameSkip[] = [];
  let more = 0;
  const candidates = snapshot.pages.filter((p) => meaninglessSlug(stemOf(p.path))).sort((a, b) => a.path.localeCompare(b.path));
  for (const p of candidates) {
    if (!p.parsed.ok) {
      skipped.push({ path: p.path, reason: "unparsed" });
      continue;
    }
    if (!isPathAlias(p.path.replace(/\.md$/, ""))) {
      skipped.push({ path: p.path, reason: "no-alias" });
      continue;
    }
    const base = slugify(p.parsed.frontmatter.title, SLUG_CHARS);
    if (meaninglessSlug(base)) {
      skipped.push({ path: p.path, reason: "no-better-name" });
      continue;
    }
    if (renamed.length >= limit) {
      more++;
      continue;
    }
    const folder = folderOf(p.path);
    const at = (name: string) => `${folder === "" ? "" : `${folder}/`}${name}.md`;
    const free = (candidate: string) => !taken.has(candidate.toLowerCase()) && isKnowledgePage(candidate);
    let to = RESERVED_SLUGS.has(base) ? at(`${base}-2`) : at(base);
    for (let n = RESERVED_SLUGS.has(base) ? 3 : 2; !free(to) && n < 10_000; n++) to = at(`${base}-${n}`);
    if (!free(to)) {
      skipped.push({ path: p.path, reason: "no-better-name" });
      continue;
    }
    taken.add(to.toLowerCase());
    renamed.push({ from: p.path, to, title: p.parsed.frontmatter.title });
  }

  const moved = new Map(renamed.map((r) => [r.from, r.to]));
  const resolver = createLinkResolver(
    snapshot.pages.map((p) => ({
      path: p.path,
      title: p.parsed.ok ? p.parsed.frontmatter.title : undefined,
      aliases: p.parsed.ok ? pathAliases(p.parsed.frontmatter.aliases) : undefined,
    })),
  );
  const titleOf = new Map(renamed.map((r) => [r.from, r.title.trim().toLowerCase()]));
  /** Each link from `page` (by its path BEFORE the rename) that reaches a renamed page by path or file name, re-pointed. */
  const retarget = (page: string) => (link: FoundLink): string | null => {
    const target = resolver.resolve(page, link);
    const to = target === null ? undefined : moved.get(target);
    if (target === null || to === undefined) return null;
    if (link.kind === "md") return mdLink(link, relativeHref(moved.get(page) ?? page, to));
    // A link by the page's title still reaches it: the title did not move.
    if (link.target.trim().toLowerCase() === titleOf.get(target)) return null;
    return `[[${to.replace(/\.md$/, "")}${link.heading !== null ? `#${link.heading}` : ""}${link.alias !== null ? `|${link.alias}` : ""}]]`;
  };

  const relinked: Array<{ path: string; links: number }> = [];
  let links = 0;
  const moves: RenamePlan["moves"] = [];
  const rewrites: RenamePlan["rewrites"] = [];
  const unparsed: string[] = [];
  if (renamed.length > 0) {
    for (const p of snapshot.pages) {
      if (!p.parsed.ok) {
        if (extractLinks(p.parsed.body).some((l) => moved.has(resolver.resolve(p.path, l) ?? ""))) unparsed.push(p.path);
        continue;
      }
      const r = rewriteLinks(p.parsed.body, retarget(p.path));
      const to = moved.get(p.path);
      if (r.rewritten > 0) {
        relinked.push({ path: to ?? p.path, links: r.rewritten });
        links += r.rewritten;
      }
      if (to === undefined) {
        if (r.rewritten > 0) rewrites.push({ path: p.path, frontmatter: p.parsed.frontmatter, body: r.body });
        continue;
      }
      const fm = p.parsed.frontmatter;
      const formerPath = p.path.replace(/\.md$/, "");
      const aliases = aliasList(fm.aliases);
      const frontmatter: PageFrontmatter = { ...fm, aliases: aliases.includes(formerPath) ? aliases : [...aliases, formerPath] };
      // memory-wiki's id follows the path it was made from; one set by hand stays.
      if (typeof fm.id === "string" && fm.id.trim() === formerPath) delete frontmatter.id;
      moves.push({ from: p.path, to, frontmatter, body: r.body });
    }
  }

  let index: string | null = null;
  if (renamed.length > 0 && snapshot.indexBody !== null) {
    const r = rewriteLinks(snapshot.indexBody, retarget(INDEX_FILE));
    if (r.rewritten > 0) {
      index = r.body;
      relinked.push({ path: INDEX_FILE, links: r.rewritten });
      links += r.rewritten;
    }
  }

  return { result: { renamed, skipped, more, relinked, links, unparsed: unparsed.sort() }, moves, rewrites, index };
}

function followState(vault: string, plan: RenamePlan, dryRun: boolean): number {
  const moved = new Map(plan.moves.map((m) => [m.from, m.to]));
  const claimIds = plan.moves.flatMap((m) => m.frontmatter.claims.map((c) => c.id));
  let items = 0;
  try {
    items = followMovedClaims(vault, claimIds, moved, { dryRun });
  } catch {
    // The items still name the claims, which is how they are settled.
  }
  if (dryRun) return items;
  try {
    syncActiveClaims(vault, plan.moves.flatMap((m) => m.frontmatter.claims.map((c) => ({ id: c.id, page: m.to, updatedAt: c.updatedAt }))));
  } catch {
    // The ledger is a second copy; the page holds the claim.
  }
  try {
    followMovedStaleNotes(vault, moved);
  } catch {
    // A stale note naming the old path only stops showing; the next pass writes it again.
  }
  return items;
}

/**
 * The maintenance route's `rename-slugs` (owner only): {@link planSlugRenames}
 * as ONE commit that Undo reverses whole, none when no page needs a new name.
 */
export async function renameMeaninglessPages(
  options: { dryRun?: boolean; vault?: string; author?: VaultAuthor; now?: Date; limit?: number } = {},
): Promise<SlugRenameResult> {
  const vault = options.vault ?? vaultDir();
  const limit = Math.max(1, Math.min(options.limit ?? MAX_RENAMES, MAX_RENAMES));
  if (options.dryRun) {
    const plan = planSlugRenames(await readVaultSnapshot(vault), limit);
    return { ...plan.result, dryRun: true, commit: null, reviewItems: followState(vault, plan, true) };
  }
  const op = await vaultOperation(
    (plan: RenamePlan) => `rename: ${plan.result.renamed.length} page${plan.result.renamed.length === 1 ? "" : "s"} with meaningless names`,
    async (tx) => {
      const plan = planSlugRenames(await tx.snapshot(), limit);
      for (const m of plan.moves) {
        await tx.remove(m.from);
        await tx.writePage(m.to, m.frontmatter, m.body);
      }
      for (const w of plan.rewrites) await tx.writePage(w.path, w.frontmatter, w.body);
      if (plan.index !== null) await tx.write(INDEX_FILE, plan.index);
      return plan;
    },
    { vault, now: options.now, author: options.author },
  );
  const plan = op.result;
  const reviewItems = op.commit ? followState(vault, plan, false) : 0;
  return { ...plan.result, dryRun: false, commit: op.commit, reviewItems };
}
