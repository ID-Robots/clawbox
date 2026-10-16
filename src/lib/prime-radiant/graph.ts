/**
 * The Map's data: every page of the vault as a node, and the edges between
 * them, in a compact shape the browser turns straight into typed arrays —
 * `{ nodes: [{ id, title, domain, degree, sources }], edges: [[a, b, w]] }`,
 * where `a` and `b` index `nodes`.
 *
 * Three kinds of edge, one per pair of pages (graph-weights.ts):
 *   - a link (w = 1): a `[[wikilink]]` or Markdown link either way between
 *     the two (resolved as links.ts resolves them);
 *   - a shared source (w = 0.5): both pages name the same source document.
 *     A source shared by many pages would make a clique (n² edges), so its
 *     pages are tied in a ring to their next {@link SOURCE_RING} neighbours
 *     (five or fewer pages are still all tied), and no page takes more than
 *     {@link MAX_SOURCE_EDGES} such edges in all. A pair already linked keeps
 *     its link.
 *   - a related hint (w = 0.25), only for a page with no link: pages written
 *     from separate documents link nowhere, and a map of loose dots says
 *     nothing. Such a page is tied to pages that share a topic with it — an
 *     entity, subject or tag in its frontmatter, or the entity its claims are
 *     about — in the same ring as sources; a page still without any edge
 *     then gets up to two neighbours in its own domain. At most
 *     {@link MAX_RELATED_EDGES} a page. Counted in `degree`, not in `links`.
 * Built in O(pages + links + source and topic mentions).
 *
 * The graph is kept for the vault's revision — HEAD, plus the size and time
 * of any page changed since — so a second open reads no page at all.
 *
 * SERVER ONLY.
 */

import fs from "fs/promises";
import { createHash } from "crypto";
import path from "@/lib/runtime-path";
import { parseClaimId } from "./claims";
import { LINK_WEIGHT, RELATED_WEIGHT, SOURCE_WEIGHT } from "./graph-weights";
import { buildLinkGraph } from "./links";
import { git } from "./git";
import { vaultDir } from "./paths";
import type { PageFrontmatter } from "./schema";
import { readVaultSnapshot, vaultInitialised, type VaultSnapshot } from "./vault";

export { LINK_WEIGHT, RELATED_WEIGHT, SOURCE_WEIGHT };

export interface GraphNode {
  /** Vault-relative page path. */
  id: string;
  title: string;
  domain: string | null;
  /** Every edge this page has: links, shared sources and related hints. */
  degree: number;
  /** Its `[[wikilink]]` / Markdown links, either way (a shared source or a hint is not one). */
  links: number;
  /** Source documents the page names. */
  sources: number;
}

/** `[a, b, weight]` with `a < b`, indexes into `nodes`. */
export type GraphEdge = [number, number, number];

export interface VaultGraph {
  /** What the graph was built from; null for a vault that does not exist yet. */
  revision: string | null;
  /** True when the vault walk stopped at its page limit. */
  truncated: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** A page is tied to this many following pages of each source it shares. */
export const SOURCE_RING = 2;
/** At most this many shared-source edges per page. */
export const MAX_SOURCE_EDGES = 6;
/** At most this many related hints per page. */
export const MAX_RELATED_EDGES = 4;

export interface GraphPage {
  path: string;
  title: string | null;
  domain: string | null;
  sources: readonly string[];
  /** What the page is about, for related hints: frontmatter entities, subjects and tags, its claims' entity. */
  topics?: readonly string[];
  body: string;
}

function leafTitle(rel: string): string {
  return (rel.split("/").pop() ?? rel).replace(/\.md$/i, "");
}

/** A topic as a key: "Acme Widgets", "acme-widgets" and "ACME widgets" are one; any script, accents folded. */
export function topicKey(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/** Strings from a frontmatter field that may be one string or a list of them. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Offer `tie` each list's members in a ring with their next
 * {@link SOURCE_RING} neighbours (every pair of a list of five or fewer); it
 * decides whether there is room. Linear in the members, whatever a list's size.
 */
function ringTie(lists: Iterable<readonly number[]>, tie: (a: number, b: number) => void): void {
  for (const members of lists) {
    const k = members.length;
    if (k < 2) continue;
    for (let i = 0; i < k; i++) {
      for (let d = 1; d <= SOURCE_RING && d < k; d++) tie(members[i], members[(i + d) % k]);
    }
  }
}

function groupBy(n: number, keysOf: (i: number) => Iterable<string>): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    for (const key of new Set(keysOf(i))) {
      const list = out.get(key);
      if (list) list.push(i);
      else out.set(key, [i]);
    }
  }
  return out;
}

/** The graph of `pages` (in the order given, which becomes the node order). */
export function buildVaultGraph(pages: readonly GraphPage[], revision: string | null, truncated = false): VaultGraph {
  const n = pages.length;
  const index = new Map<string, number>();
  pages.forEach((p, i) => index.set(p.path, i));
  const degree = new Uint32Array(n);
  const linkCount = new Uint32Array(n);
  const edges: GraphEdge[] = [];
  const pairs = new Set<number>();
  const add = (x: number, y: number, w: number): boolean => {
    if (x === y) return false;
    const a = Math.min(x, y), b = Math.max(x, y);
    const key = a * n + b;
    if (pairs.has(key)) return false;
    pairs.add(key);
    edges.push([a, b, w]);
    degree[a]++;
    degree[b]++;
    if (w === LINK_WEIGHT) {
      linkCount[a]++;
      linkCount[b]++;
    }
    return true;
  };

  const links = buildLinkGraph(
    pages.map((p) => ({ path: p.path, title: p.title ?? undefined, body: p.body })),
    null,
  );
  pages.forEach((p, i) => {
    for (const target of links.outbound.get(p.path) ?? []) {
      const j = index.get(target);
      if (j !== undefined) add(i, j, LINK_WEIGHT);
    }
  });
  const linked = new Uint8Array(n);
  for (const [a, b] of edges) linked[a] = linked[b] = 1;

  const sourceEdges = new Uint8Array(n);
  ringTie(groupBy(n, (i) => pages[i].sources.map((x) => x.trim()).filter(Boolean)).values(), (a, b) => {
    if (sourceEdges[a] >= MAX_SOURCE_EDGES || sourceEdges[b] >= MAX_SOURCE_EDGES) return;
    if (add(a, b, SOURCE_WEIGHT)) {
      sourceEdges[a]++;
      sourceEdges[b]++;
    }
  });

  // Related hints, for the pages no link reaches: a shared topic first…
  const related = new Uint8Array(n);
  const relate = (a: number, b: number) => {
    if ((linked[a] && linked[b]) || related[a] >= MAX_RELATED_EDGES || related[b] >= MAX_RELATED_EDGES) return;
    if (add(a, b, RELATED_WEIGHT)) {
      related[a]++;
      related[b]++;
    }
  };
  ringTie(groupBy(n, (i) => (pages[i].topics ?? []).map(topicKey).filter(Boolean)).values(), relate);
  // …then, for a page with no edge at all yet, its neighbours in its domain.
  const loose = Array.from({ length: n }, (_, i) => degree[i] === 0);
  for (const members of groupBy(n, (i) => (pages[i].domain ? [pages[i].domain!] : [])).values()) {
    const k = members.length;
    members.forEach((i, at) => {
      if (!loose[i] || k < 2) return;
      relate(i, members[(at + 1) % k]);
      relate(i, members[(at + k - 1) % k]);
    });
  }

  return {
    revision,
    truncated,
    nodes: pages.map((p, i) => ({
      id: p.path,
      title: p.title?.trim() || leafTitle(p.path),
      domain: p.domain,
      degree: degree[i],
      links: linkCount[i],
      sources: p.sources.length,
    })),
    edges,
  };
}

/** What a page is about: the entities, subjects and tags in its frontmatter, and what its claims are about. */
export function pageTopics(fm: PageFrontmatter): string[] {
  const out = [...strings(fm.entities), ...strings(fm.entity), ...strings(fm.subjects), ...strings(fm.subject), ...strings(fm.tags)];
  for (const c of Array.isArray(fm.claims) ? fm.claims : []) {
    // A claim id is `<domain>/<entity>/<fact>`: the entity is what it is about.
    const entity = typeof c?.id === "string" ? parseClaimId(c.id)?.entity : undefined;
    if (entity) out.push(entity);
    out.push(...strings(c?.subject));
  }
  return out;
}

export function graphPages(snapshot: VaultSnapshot): GraphPage[] {
  return snapshot.pages.map((p) => {
    const fm = p.parsed.ok ? p.parsed.frontmatter : null;
    return {
      path: p.path,
      title: fm?.title ?? null,
      domain: fm?.domain ?? null,
      sources: fm?.sources ?? [],
      topics: fm ? pageTopics(fm) : [],
      body: p.parsed.body,
    };
  });
}

/** At most this many changed files are looked at one by one for the revision. */
const MAX_DIRTY_STATS = 2_000;

/**
 * HEAD, and — when the working tree has changes (a page memory-wiki wrote and
 * nobody committed) — a hash of which files changed and their size and time,
 * so a second edit to an already-changed page is a new revision too.
 */
export async function vaultRevision(vault: string): Promise<string> {
  const head = (await git(vault, ["rev-parse", "HEAD"])).stdout.trim();
  const status = (await git(vault, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
  if (status === "") return head;
  const hash = createHash("sha1").update(status);
  const fields = status.split("\0");
  let stats = 0;
  for (let i = 0; i < fields.length && stats < MAX_DIRTY_STATS; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    // A rename or copy is followed by the path it came from.
    if (entry[0] === "R" || entry[0] === "C") i++;
    const rel = entry.slice(3);
    stats++;
    try {
      const st = await fs.stat(path.join(vault, ...rel.split("/")));
      hash.update(`\0${st.size}:${st.mtimeMs}`);
    } catch {
      hash.update("\0-");
    }
  }
  return `${head}+${hash.digest("hex").slice(0, 12)}`;
}

const EMPTY: VaultGraph = { revision: null, truncated: false, nodes: [], edges: [] };

let cached: { key: string; graph: VaultGraph } | null = null;
let building: { key: string; promise: Promise<VaultGraph> } | null = null;

/** Forget the kept graph (tests). */
export function clearGraphCache(): void {
  cached = null;
  building = null;
}

/**
 * The vault's graph, rebuilt only when its revision moved; two requests for
 * the same revision share one build. Never creates the vault.
 */
export async function getVaultGraph(vault: string = vaultDir()): Promise<VaultGraph> {
  if (!(await vaultInitialised(vault))) return EMPTY;
  const revision = await vaultRevision(vault);
  const key = `${path.resolve(vault)}\n${revision}`;
  if (cached?.key === key) return cached.graph;
  if (building?.key === key) return building.promise;
  const promise = readVaultSnapshot(vault).then((snapshot) => buildVaultGraph(graphPages(snapshot), revision, snapshot.truncated));
  building = { key, promise };
  try {
    const graph = await promise;
    cached = { key, graph };
    return graph;
  } finally {
    if (building?.promise === promise) building = null;
  }
}
