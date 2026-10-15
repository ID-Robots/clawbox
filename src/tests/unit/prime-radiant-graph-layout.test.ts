/**
 * The Map's pure layout logic: the Barnes-Hut octree, the force layout,
 * Louvain communities and the Insights, on small graphs whose answer is
 * known — plus the engine's message protocol the worker speaks.
 */
import { describe, expect, it } from "vitest";
import { createLayout, isSettled, LINK_DISTANCE, Octree, prng, seedPositions, tick, writePositions } from "@/lib/prime-radiant/graph-layout";
import { graphInsights, louvain, modularity } from "@/lib/prime-radiant/graph-communities";
import { createLayoutEngine, readToEngine, type FromEngine } from "@/components/prime-radiant-map/layout-engine";

/** Positions for `n` random points in a cube of side `size`. */
function cloud(n: number, size = 1000, seed = 7): Float64Array {
  const rand = prng(seed);
  const pos = new Float64Array(n * 3);
  for (let i = 0; i < n * 3; i++) pos[i] = (rand() - 0.5) * size;
  return pos;
}

/** The exact many-body force (k / d² along the vector), for checking the tree. */
function bruteForce(pos: Float64Array, n: number, i: number, k: number): [number, number, number] {
  let fx = 0, fy = 0, fz = 0;
  for (let j = 0; j < n; j++) {
    if (j === i) continue;
    const dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2];
    let d = dx * dx + dy * dy + dz * dz;
    if (d >= 900 * 900) continue;
    if (d < 1) d = Math.sqrt(d);
    fx += (dx * k) / d;
    fy += (dy * k) / d;
    fz += (dz * k) / d;
  }
  return [fx, fy, fz];
}

/** Two 4-cliques (0-3 and 4-7) joined by the single edge 3-4. */
const TWO_CLIQUES = (() => {
  const ends: number[] = [];
  for (const base of [0, 4]) for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) ends.push(base + a, base + b);
  ends.push(3, 4);
  return { n: 8, ends: Uint32Array.from(ends), weights: new Float32Array(ends.length / 2).fill(1) };
})();

describe("Octree", () => {
  it("holds every point once: the root's mass is the count and its centre of mass the mean", () => {
    const n = 500;
    const pos = cloud(n);
    const tree = new Octree(n);
    tree.build(pos, n);
    expect(tree.mass[0]).toBe(n);
    for (let a = 0; a < 3; a++) {
      let mean = 0;
      for (let i = 0; i < n; i++) mean += pos[i * 3 + a];
      expect([tree.mx[0], tree.my[0], tree.mz[0]][a]).toBeCloseTo(mean / n, 6);
    }
    // Every point sits in exactly one slot (or one chain).
    const seen = new Uint8Array(n);
    for (let c = 0; c < tree.count; c++) {
      for (let o = 0; o < 8; o++) {
        const v = tree.child[c * 8 + o];
        if (v <= -2) for (let p = -2 - v; p !== -1; p = tree.next[p]) seen[p]++;
      }
    }
    expect([...seen].every((s) => s === 1)).toBe(true);
  });

  it("chains points that share a position instead of splitting forever", () => {
    const n = 50;
    const pos = new Float64Array(n * 3).fill(3);
    const tree = new Octree(n);
    tree.build(pos, n);
    expect(tree.mass[0]).toBe(n);
    expect(tree.count).toBeLessThan(5);
    const vel = new Float64Array(n * 3);
    tree.applyCharge(pos, vel, 0, n, -30);
    expect([...vel].every(Number.isFinite)).toBe(true);
  });

  it("matches the exact force within a few percent (θ = 1.2)", () => {
    // Inside the charge's reach (900), so only the tree's approximation is measured.
    const n = 400;
    const pos = cloud(n, 400, 11);
    const tree = new Octree(n);
    tree.build(pos, n);
    const vel = new Float64Array(n * 3);
    tree.applyCharge(pos, vel, 0, n, -30);
    let err = 0, norm = 0;
    for (let i = 0; i < n; i++) {
      const exact = bruteForce(pos, n, i, -30);
      for (let a = 0; a < 3; a++) {
        err += (vel[i * 3 + a] - exact[a]) ** 2;
        norm += exact[a] ** 2;
      }
    }
    expect(Math.sqrt(err / norm)).toBeLessThan(0.08);
  });

  it("pushes two points apart along the line between them", () => {
    const pos = new Float64Array([0, 0, 0, 10, 0, 0]);
    const tree = new Octree(2);
    tree.build(pos, 2);
    const vel = new Float64Array(6);
    tree.applyCharge(pos, vel, 0, 2, -30);
    expect(vel[0]).toBeCloseTo(-3, 6); // k·dx/d² = -30·10/100
    expect(vel[3]).toBeCloseTo(3, 6);
    expect(vel[1]).toBe(0);
    expect(vel[5]).toBe(0);
  });
});

describe("seedPositions", () => {
  it("starts each domain around its own point, and is the same every time", () => {
    const n = 300;
    const groups = Uint16Array.from({ length: n }, (_, i) => i % 3);
    const a = seedPositions(n, groups, 3);
    expect(seedPositions(n, groups, 3)).toEqual(a);
    const centre = (g: number) => {
      const c = [0, 0, 0];
      for (let i = g; i < n; i += 3) for (let k = 0; k < 3; k++) c[k] += a[i * 3 + k] / (n / 3);
      return c;
    };
    const spread = (g: number, c: number[]) => {
      let s = 0;
      for (let i = g; i < n; i += 3) s += Math.hypot(a[i * 3] - c[0], a[i * 3 + 1] - c[1], a[i * 3 + 2] - c[2]);
      return s / (n / 3);
    };
    const [c0, c1] = [centre(0), centre(1)];
    expect(Math.hypot(c0[0] - c1[0], c0[1] - c1[1], c0[2] - c1[2])).toBeGreaterThan(spread(0, c0));
  });

  it("keeps a flat seed flat", () => {
    const pos = seedPositions(50, new Uint16Array(50), 2);
    for (let i = 0; i < 50; i++) expect(pos[i * 3 + 2]).toBe(0);
  });
});

describe("force layout", () => {
  it("settles, pulls linked pages together and keeps every position finite", () => {
    const g = TWO_CLIQUES;
    const layout = createLayout(g, seedPositions(g.n, new Uint16Array(g.n), 3), 3);
    while (!isSettled(layout) && layout.ticks < 1000) tick(layout);
    expect(isSettled(layout)).toBe(true);
    expect(layout.ticks).toBeLessThanOrEqual(300);
    expect([...layout.pos].every(Number.isFinite)).toBe(true);
    const d = (a: number, b: number) => Math.hypot(layout.pos[a * 3] - layout.pos[b * 3], layout.pos[a * 3 + 1] - layout.pos[b * 3 + 1], layout.pos[a * 3 + 2] - layout.pos[b * 3 + 2]);
    // Inside a clique: about a link apart. Across the cliques (not linked): further.
    expect(d(0, 1)).toBeLessThan(LINK_DISTANCE * 2);
    expect(d(0, 7)).toBeGreaterThan(d(0, 1));
    const out = writePositions(layout, new Float32Array(g.n * 3));
    expect(out[3]).toBeCloseTo(layout.pos[3], 3);
  });

  it("lays a flat layout out in the plane", () => {
    const g = TWO_CLIQUES;
    const layout = createLayout(g, seedPositions(g.n, new Uint16Array(g.n), 3), 2);
    for (let t = 0; t < 50; t++) tick(layout);
    for (let i = 0; i < g.n; i++) expect(layout.pos[i * 3 + 2]).toBe(0);
  });

  it("starts a warm layout cool, so it only nudges", () => {
    const g = TWO_CLIQUES;
    const layout = createLayout(g, seedPositions(g.n, new Uint16Array(g.n), 3), 3, 0.3);
    tick(layout);
    expect(layout.alpha).toBeLessThan(0.3);
  });
});

describe("louvain", () => {
  it("splits two cliques joined by one edge into the two cliques", () => {
    const g = TWO_CLIQUES;
    const comm = louvain(g.n, g.ends, g.weights);
    expect(new Set(comm).size).toBe(2);
    expect(new Set([...comm.slice(0, 4)]).size).toBe(1);
    expect(new Set([...comm.slice(4, 8)]).size).toBe(1);
    expect(comm[0]).not.toBe(comm[4]);
    expect(modularity(g.n, g.ends, g.weights, comm)).toBeCloseTo(0.423, 2);
  });

  it("finds each triangle of a ring of five triangles", () => {
    const ends: number[] = [];
    for (let t = 0; t < 5; t++) {
      const a = t * 3;
      ends.push(a, a + 1, a + 1, a + 2, a, a + 2);
      ends.push(a + 2, ((t + 1) % 5) * 3); // one edge to the next triangle
    }
    const comm = louvain(15, ends, new Float32Array(ends.length / 2).fill(1));
    expect(new Set(comm).size).toBe(5);
    for (let t = 0; t < 5; t++) expect(new Set([comm[t * 3], comm[t * 3 + 1], comm[t * 3 + 2]]).size).toBe(1);
  });

  it("leaves pages without edges alone, numbers communities largest first, and copes with nothing", () => {
    // Nodes 0-3 a clique, 4 and 5 a pair, 6 alone.
    const ends = [0, 1, 0, 2, 0, 3, 1, 2, 1, 3, 2, 3, 4, 5];
    const comm = louvain(7, ends, new Float32Array(7).fill(1));
    expect(comm[0]).toBe(0);
    expect(comm[4]).toBe(comm[5]);
    expect(comm[4]).toBe(1);
    expect(comm[6]).toBe(2);
    expect(louvain(0, [], [])).toHaveLength(0);
    expect([...louvain(3, [], [])]).toEqual([0, 1, 2]);
  });

  it("is deterministic and respects weights", () => {
    // A square 0-1-2-3 whose 0-1 and 2-3 sides are heavy: those pairs group.
    const ends = [0, 1, 1, 2, 2, 3, 3, 0];
    const comm = louvain(4, ends, [5, 0.1, 5, 0.1]);
    expect(comm[0]).toBe(comm[1]);
    expect(comm[2]).toBe(comm[3]);
    expect(comm[0]).not.toBe(comm[2]);
    expect(louvain(4, ends, [5, 0.1, 5, 0.1])).toEqual(comm);
  });
});

describe("graphInsights", () => {
  const degreeOf = (n: number, ends: ArrayLike<number>) => {
    const degree = new Float32Array(n);
    for (let e = 0; e < ends.length / 2; e++) {
      degree[ends[e * 2]]++;
      degree[ends[e * 2 + 1]]++;
    }
    return degree;
  };

  it("names orphans (a shared source is not a link) and hubs by degree", () => {
    // Two cliques joined by 3-4; node 8 only shares a source with 0; node 9 has nothing.
    const ends = [...TWO_CLIQUES.ends, 0, 8];
    const weights = [...TWO_CLIQUES.weights, 0.5];
    const n = 10;
    const degree = degreeOf(n, ends);
    const insights = graphInsights(n, ends, weights, degree, louvain(n, ends, weights), 3);
    expect(insights.orphans).toEqual([8, 9]);
    expect(insights.hubs).toEqual([0, 3, 4]); // 0: three links and a source; 3 and 4: three links and the join
  });

  it("names the page that joins two communities as a bridge, apart from the hubs", () => {
    // Cliques 0-3 and 4-7, joined only through page 8 (3-8-4).
    const ends: number[] = [];
    for (const base of [0, 4]) for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) ends.push(base + a, base + b);
    ends.push(3, 8, 8, 4);
    const n = 9;
    const weights = new Float32Array(ends.length / 2).fill(1);
    const degree = degreeOf(n, ends);
    const comm = louvain(n, ends, weights);
    expect(comm[0]).not.toBe(comm[7]);
    const insights = graphInsights(n, ends, weights, degree, comm, 3);
    expect(insights.hubs).toEqual([3, 4, 0]);
    expect(insights.bridges[0]).toBe(8);
    expect(insights.bridges.some((i) => insights.hubs.includes(i))).toBe(false);
  });

  it("has nothing to say about an empty graph", () => {
    expect(graphInsights(0, [], [], [], [])).toEqual({ orphans: [], hubs: [], bridges: [] });
  });
});

describe("layout engine (the worker's protocol)", () => {
  it("answers a start with the seed, then the communities, then positions until settled — only into buffers handed back", async () => {
    const messages: FromEngine[] = [];
    let engine: ReturnType<typeof createLayoutEngine> | null = null;
    const done = new Promise<void>((resolve) => {
      engine = createLayoutEngine((msg) => {
        messages.push(msg);
        if (msg.type === "positions") {
          if (msg.settled) resolve();
          // The page copies and hands the buffer back, as the view does.
          else setTimeout(() => engine?.handle({ type: "buffer", positions: msg.positions }), 0);
        }
      });
    });
    const g = TWO_CLIQUES;
    engine!.handle({
      type: "start",
      n: g.n,
      ends: g.ends,
      weights: g.weights,
      groups: new Uint16Array(g.n),
      degree: new Float32Array(g.n).fill(3),
      dims: 3,
    });
    await done;
    expect(messages[0].type).toBe("positions");
    expect(messages[1].type).toBe("communities");
    const last = messages[messages.length - 1];
    expect(last).toMatchObject({ type: "positions", settled: true });
    if (last.type === "positions") expect(last.positions).toHaveLength(g.n * 3);
    // Never more than the two buffers it owns are out at once.
    const buffers = new Set(messages.flatMap((m) => (m.type === "positions" ? [m.positions] : [])));
    expect(buffers.size).toBeLessThanOrEqual(2);
    engine!.stop();
  });

  it("starts from a warm layout's known positions", () => {
    const messages: FromEngine[] = [];
    const engine = createLayoutEngine((msg) => messages.push(msg));
    const warm = new Float32Array(6).fill(0);
    warm.set([100, 200, 300, -100, -200, -300]);
    engine.handle({
      type: "start",
      n: 2,
      ends: new Uint32Array([0, 1]),
      weights: new Float32Array([1]),
      groups: new Uint16Array(2),
      degree: new Float32Array([1, 1]),
      dims: 3,
      warm: { positions: warm, known: new Uint8Array([1, 1]) },
    });
    engine.stop();
    const first = messages[0];
    expect(first.type).toBe("positions");
    if (first.type === "positions") expect([...first.positions]).toEqual([100, 200, 300, -100, -200, -300]);
  });
});

describe("readToEngine", () => {
  const start = () => ({
    type: "start",
    n: 3,
    ends: new Uint32Array([0, 1, 1, 2]),
    weights: new Float32Array([1, 0.5]),
    groups: new Uint16Array([0, 0, 1]),
    degree: new Float32Array([1, 2, 1]),
    dims: 3,
  });

  it("passes a well-formed start through, with its own copies of the indexes", () => {
    const sent = start();
    const msg = readToEngine(sent);
    expect(msg).toMatchObject({ type: "start", n: 3, dims: 3 });
    if (msg?.type !== "start") throw new Error("not a start");
    expect([...msg.ends]).toEqual([0, 1, 1, 2]);
    expect(msg.ends).not.toBe(sent.ends);
    expect([...msg.groups]).toEqual([0, 0, 1]);
    expect(msg.warm).toBeUndefined();
  });

  it("passes a buffer through", () => {
    const positions = new Float32Array(9);
    expect(readToEngine({ type: "buffer", positions })).toEqual({ type: "buffer", positions });
  });

  it("refuses an edge that names no node, so nothing outside the arrays is written", () => {
    expect(readToEngine({ ...start(), ends: new Uint32Array([0, 3, 1, 2]) })).toBeNull();
  });

  it("refuses what is not the protocol", () => {
    for (const bad of [
      null,
      "start",
      { type: "other" },
      { type: "buffer", positions: [0, 0, 0] },
      { ...start(), n: -1 },
      { ...start(), n: 1.5 },
      { ...start(), n: "3" },
      { ...start(), dims: 4 },
      { ...start(), ends: [0, 1, 1, 2] },
      { ...start(), ends: new Uint32Array([0, 1, 2]) },
      { ...start(), weights: new Float32Array([1]) },
      { ...start(), groups: new Uint16Array(2) },
      { ...start(), degree: new Float32Array(2) },
      { ...start(), warm: { positions: new Float32Array(9), known: new Uint8Array(2) } },
      { ...start(), warm: null },
    ]) {
      expect(readToEngine(bad)).toBeNull();
    }
  });
});
