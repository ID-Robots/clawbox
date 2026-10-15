/**
 * The Map's data: every page of the vault as a node, and the edges between
 * them, in a compact shape the browser turns straight into typed arrays —
 * `{ nodes: [{ id, title, domain, degree, sources }], edges: [[a, b, w]] }`,
 * where `a` and `b` index `nodes`.
 *
 * Two kinds of edge, one per pair of pages:
 *   - a link (w = 1): a `[[wikilink]]` or Markdown link either way between
 *     the two (resolved as links.ts resolves them);
 *   - a shared source (w = 0.5): both pages name the same source document.
 *     A source shared by many pages would make a clique (n² edges), so its
 *     pages are tied in a ring to their next {@link SOURCE_RING} neighbours
 *     (five or fewer pages are still all tied), and no page takes more than
 *     {@link MAX_SOURCE_EDGES} such edges in all. A pair already linked keeps
 *     its link.
 * Built in O(pages + links + source mentions).
 *
 * The graph is kept for the vault's revision — HEAD, plus the size and time
 * of any page changed since — so a second open reads no page at all.
 *
 * SERVER ONLY.
 */

import fs from "fs/promises";
import { createHash } from "crypto";
import path from "@/lib/runtime-path";
import { buildLinkGraph } from "./links";
import { git } from "./git";
import { vaultDir } from "./paths";
import { readVaultSnapshot, vaultInitialised, type VaultSnapshot } from "./vault";

export interface GraphNode {
  /** Vault-relative page path. */
  id: string;
  title: string;
  domain: string | null;
  /** Edges this page has (links and shared sources). */
  degree: number;
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

export const LINK_WEIGHT = 1;
export const SOURCE_WEIGHT = 0.5;
/** A page is tied to this many following pages of each source it shares. */
export const SOURCE_RING = 2;
/** At most this many shared-source edges per page. */
export const MAX_SOURCE_EDGES = 6;

export interface GraphPage {
  path: string;
  title: string | null;
  domain: string | null;
  sources: readonly string[];
  body: string;
}

function leafTitle(rel: string): string {
  return (rel.split("/").pop() ?? rel).replace(/\.md$/i, "");
}

/** The graph of `pages` (in the order given, which becomes the node order). */
export function buildVaultGraph(pages: readonly GraphPage[], revision: string | null, truncated = false): VaultGraph {
  const n = pages.length;
  const index = new Map<string, number>();
  pages.forEach((p, i) => index.set(p.path, i));
  const degree = new Uint32Array(n);
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

  const bySource = new Map<string, number[]>();
  pages.forEach((p, i) => {
    for (const s of new Set(p.sources.map((x) => x.trim()).filter(Boolean))) {
      const list = bySource.get(s);
      if (list) list.push(i);
      else bySource.set(s, [i]);
    }
  });
  const sourceEdges = new Uint8Array(n);
  for (const members of bySource.values()) {
    const k = members.length;
    if (k < 2) continue;
    for (let i = 0; i < k; i++) {
      for (let d = 1; d <= SOURCE_RING && d < k; d++) {
        const a = members[i], b = members[(i + d) % k];
        if (sourceEdges[a] >= MAX_SOURCE_EDGES || sourceEdges[b] >= MAX_SOURCE_EDGES) continue;
        if (add(a, b, SOURCE_WEIGHT)) {
          sourceEdges[a]++;
          sourceEdges[b]++;
        }
      }
    }
  }

  return {
    revision,
    truncated,
    nodes: pages.map((p, i) => ({
      id: p.path,
      title: p.title?.trim() || leafTitle(p.path),
      domain: p.domain,
      degree: degree[i],
      sources: p.sources.length,
    })),
    edges,
  };
}

export function graphPages(snapshot: VaultSnapshot): GraphPage[] {
  return snapshot.pages.map((p) => {
    const fm = p.parsed.ok ? p.parsed.frontmatter : null;
    return { path: p.path, title: fm?.title ?? null, domain: fm?.domain ?? null, sources: fm?.sources ?? [], body: p.parsed.body };
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
