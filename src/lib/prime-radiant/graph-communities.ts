/**
 * Communities and insights over the Map's graph: Louvain modularity
 * clustering (the Map's "community" colours) and the strip of pages worth a
 * look — orphans, hubs and bridges between communities.
 *
 * Louvain (Blondel et al. 2008): every node starts alone; each one moves to
 * the neighbouring community that raises modularity most, until no move
 * helps; then every community becomes one node and the pass repeats on that
 * smaller graph. Nodes are visited in index order, so the same graph always
 * gives the same answer. O(m) a pass.
 *
 * Pure: runs in the Map's worker, tested directly.
 */

interface LevelGraph {
  n: number;
  /** CSR adjacency without self-loops. */
  offsets: Int32Array;
  adj: Int32Array;
  adjW: Float64Array;
  /** Weight of each node's self-loop (an aggregated community's inner edges). */
  loop: Float64Array;
  /** Weighted degree, a self-loop counted twice. */
  k: Float64Array;
  /** Twice the total edge weight. */
  m2: number;
}

function levelGraph(n: number, a: ArrayLike<number>, b: ArrayLike<number>, w: ArrayLike<number>, count: number): LevelGraph {
  const deg = new Int32Array(n + 1);
  const loop = new Float64Array(n);
  const k = new Float64Array(n);
  let m2 = 0;
  for (let e = 0; e < count; e++) {
    const x = a[e], y = b[e], wt = w[e];
    if (!(wt > 0)) continue;
    m2 += 2 * wt;
    k[x] += wt;
    k[y] += wt;
    if (x === y) loop[x] += wt;
    else {
      deg[x + 1]++;
      deg[y + 1]++;
    }
  }
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const offsets = deg;
  const fill = offsets.slice(0, n);
  const adj = new Int32Array(offsets[n]);
  const adjW = new Float64Array(offsets[n]);
  for (let e = 0; e < count; e++) {
    const x = a[e], y = b[e], wt = w[e];
    if (!(wt > 0) || x === y) continue;
    adj[fill[x]] = y;
    adjW[fill[x]++] = wt;
    adj[fill[y]] = x;
    adjW[fill[y]++] = wt;
  }
  return { n, offsets, adj, adjW, loop, k, m2 };
}

/** One level: local moves until none helps. Returns communities numbered 0..count-1. */
function oneLevel(g: LevelGraph): { comm: Int32Array; count: number } {
  const { n, offsets, adj, adjW, k, m2 } = g;
  const comm = new Int32Array(n);
  const tot = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    comm[i] = i;
    tot[i] = k[i];
  }
  if (m2 === 0) return { comm, count: n };
  const linkTo = new Float64Array(n);
  const touched = new Int32Array(n);
  for (let pass = 0; pass < 32; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const own = comm[i];
      const ki = k[i];
      let nt = 0;
      for (let j = offsets[i]; j < offsets[i + 1]; j++) {
        const c = comm[adj[j]];
        if (linkTo[c] === 0) touched[nt++] = c;
        linkTo[c] += adjW[j];
      }
      tot[own] -= ki;
      let best = own;
      let bestGain = linkTo[own] - (tot[own] * ki) / m2;
      for (let t = 0; t < nt; t++) {
        const c = touched[t];
        const gain = linkTo[c] - (tot[c] * ki) / m2;
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          best = c;
        }
      }
      tot[best] += ki;
      if (best !== own) {
        comm[i] = best;
        moved = true;
      }
      for (let t = 0; t < nt; t++) linkTo[touched[t]] = 0;
    }
    if (!moved) break;
  }
  // Renumber 0..count-1 in order of first appearance.
  const map = new Int32Array(n).fill(-1);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (map[comm[i]] === -1) map[comm[i]] = count++;
    comm[i] = map[comm[i]];
  }
  return { comm, count };
}

/**
 * Louvain communities of an undirected weighted graph (`ends` holds two node
 * indexes per edge). Communities are numbered by size, largest first; a page
 * with no edges is a community of its own.
 */
export function louvain(n: number, ends: ArrayLike<number>, weights: ArrayLike<number>, maxLevels = 12): Int32Array {
  const m = Math.floor(ends.length / 2);
  let a = new Int32Array(m);
  let b = new Int32Array(m);
  let w = new Float64Array(m);
  for (let e = 0; e < m; e++) {
    a[e] = ends[e * 2];
    b[e] = ends[e * 2 + 1];
    w[e] = weights[e] ?? 1;
  }
  let count = m;
  const result = new Int32Array(n);
  for (let i = 0; i < n; i++) result[i] = i;
  let size = n;
  for (let level = 0; level < maxLevels; level++) {
    const g = levelGraph(size, a, b, w, count);
    const { comm, count: groups } = oneLevel(g);
    if (groups === size) break;
    for (let i = 0; i < n; i++) result[i] = comm[result[i]];
    // Aggregate: one node per community, edge weights summed (inner edges become self-loops).
    const sums = new Map<number, number>();
    for (let e = 0; e < count; e++) {
      const x = comm[a[e]], y = comm[b[e]];
      const key = x < y ? x * groups + y : y * groups + x;
      sums.set(key, (sums.get(key) ?? 0) + w[e]);
    }
    a = new Int32Array(sums.size);
    b = new Int32Array(sums.size);
    w = new Float64Array(sums.size);
    let e = 0;
    for (const [key, wt] of sums) {
      a[e] = Math.floor(key / groups);
      b[e] = key % groups;
      w[e++] = wt;
    }
    count = sums.size;
    size = groups;
  }
  // Largest community first; ties by first appearance.
  const sizes = new Int32Array(size);
  for (let i = 0; i < n; i++) sizes[result[i]]++;
  const order = Array.from({ length: size }, (_, c) => c).sort((x, y) => sizes[y] - sizes[x] || x - y);
  const rank = new Int32Array(size);
  order.forEach((c, r) => {
    rank[c] = r;
  });
  for (let i = 0; i < n; i++) result[i] = rank[result[i]];
  return result;
}

/** Newman modularity of a partition, for tests and for judging a result. */
export function modularity(n: number, ends: ArrayLike<number>, weights: ArrayLike<number>, comm: ArrayLike<number>): number {
  const m = Math.floor(ends.length / 2);
  let total = 0;
  let inside = 0;
  const degree = new Float64Array(n);
  for (let e = 0; e < m; e++) {
    const x = ends[e * 2], y = ends[e * 2 + 1], wt = weights[e] ?? 1;
    total += wt;
    degree[x] += wt;
    degree[y] += wt;
    if (comm[x] === comm[y]) inside += wt;
  }
  if (total === 0) return 0;
  const byComm = new Map<number, number>();
  for (let i = 0; i < n; i++) byComm.set(comm[i], (byComm.get(comm[i]) ?? 0) + degree[i]);
  let expected = 0;
  for (const d of byComm.values()) expected += (d / (2 * total)) ** 2;
  return inside / total - expected;
}

export interface GraphInsights {
  /** Pages with no link in or out (a shared source does not count), by index. */
  orphans: number[];
  /** The most connected pages, busiest first. */
  hubs: number[];
  /** Pages whose links reach the most other communities, strongest first. */
  bridges: number[];
}

/**
 * The Insights strip. `degree` ranks the hubs; `communities` (from
 * {@link louvain}) decides what counts as a bridge.
 */
export function graphInsights(
  n: number,
  ends: ArrayLike<number>,
  weights: ArrayLike<number>,
  degree: ArrayLike<number>,
  communities: ArrayLike<number>,
  limit = 8,
): GraphInsights {
  const m = Math.floor(ends.length / 2);
  const links = new Int32Array(n);
  const offsets = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) {
    const x = ends[e * 2], y = ends[e * 2 + 1];
    if ((weights[e] ?? 1) >= 1) {
      links[x]++;
      links[y]++;
    }
    offsets[x + 1]++;
    offsets[y + 1]++;
  }
  for (let i = 0; i < n; i++) offsets[i + 1] += offsets[i];
  const fill = offsets.slice(0, n);
  const adj = new Int32Array(offsets[n]);
  const adjW = new Float64Array(offsets[n]);
  for (let e = 0; e < m; e++) {
    const x = ends[e * 2], y = ends[e * 2 + 1], wt = weights[e] ?? 1;
    adj[fill[x]] = y;
    adjW[fill[x]++] = wt;
    adj[fill[y]] = x;
    adjW[fill[y]++] = wt;
  }

  const orphans: number[] = [];
  for (let i = 0; i < n; i++) if (links[i] === 0) orphans.push(i);

  const all = Array.from({ length: n }, (_, i) => i);
  const hubs = all
    .filter((i) => degree[i] > 0)
    .sort((x, y) => degree[y] - degree[x] || x - y)
    .slice(0, limit);

  // A bridge: how many other communities a page's neighbours sit in, then how much weight crosses.
  const reach = new Int32Array(n);
  const cross = new Float64Array(n);
  const seen = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let j = offsets[i]; j < offsets[i + 1]; j++) {
      const c = communities[adj[j]];
      if (c === communities[i]) continue;
      cross[i] += adjW[j];
      if (seen[c] !== i) {
        seen[c] = i;
        reach[i]++;
      }
    }
  }
  const bridges = all
    .filter((i) => reach[i] > 0)
    .sort((x, y) => reach[y] - reach[x] || cross[y] - cross[x] || degree[y] - degree[x] || x - y)
    .slice(0, limit);

  return { orphans, hubs, bridges };
}
