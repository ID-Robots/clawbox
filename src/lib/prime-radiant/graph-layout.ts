/**
 * The Map's layout: a force-directed placement of the vault graph in 3D (or
 * 2D for the flat fallback), run in a Web Worker
 * (components/prime-radiant-map/layout.worker.ts).
 *
 * The forces are d3-force's, written for typed arrays:
 *   - many-body repulsion through a Barnes-Hut octree, O(n log n) a tick;
 *   - springs along the edges, a link's pull scaled by its weight and eased
 *     on the busier end (d3's bias);
 *   - a weak pull to the centre, so pages with no links rest near the graph
 *     instead of drifting off.
 * `alpha` cools every tick and the layout is settled once it is cold or the
 * nodes have stopped moving. Pages start around their domain's own point on
 * a sphere, so related pages begin close together and it settles fast.
 *
 * Nothing is allocated per tick: the octree keeps its arrays (growing only
 * when a tick needs more cells than any before it) and positions are copied
 * into a caller's Float32Array.
 *
 * Pure: no DOM, no worker API — tested directly.
 */

export const LINK_DISTANCE = 30;
const CHARGE = -45;
const THETA2 = 1.44; // θ = 1.2: coarse enough for 20k pages, still a faithful picture
const DISTANCE_MIN2 = 1;
const DISTANCE_MAX2 = 900 * 900;
const GRAVITY = 0.012;
const VELOCITY_KEEP = 0.6; // d3's velocityDecay 0.4
export const ALPHA_MIN = 0.001;
/** Cells deeper than this hold their points in a list instead of splitting again. */
const MAX_DEPTH = 24;

/** A small seeded generator (mulberry32): the same vault always starts the same way. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Starting positions (x, y, z per node): every group (domain) gets a point on
 * a Fibonacci sphere (a circle in 2D) and its pages a ball around it sized to
 * the group.
 */
export function seedPositions(n: number, groups: ArrayLike<number>, dims: 2 | 3, seed = 1): Float64Array {
  const pos = new Float64Array(n * 3);
  let groupCount = 0;
  for (let i = 0; i < n; i++) groupCount = Math.max(groupCount, groups[i] + 1);
  const sizes = new Uint32Array(groupCount);
  for (let i = 0; i < n; i++) sizes[groups[i]]++;
  const centres = new Float64Array(groupCount * 3);
  const spread = LINK_DISTANCE * (dims === 3 ? Math.cbrt(n) : Math.sqrt(n)) * 0.9;
  if (groupCount > 1) {
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let g = 0; g < groupCount; g++) {
      if (dims === 3) {
        const y = 1 - (2 * (g + 0.5)) / groupCount;
        const r = Math.sqrt(1 - y * y);
        centres[g * 3] = Math.cos(golden * g) * r * spread;
        centres[g * 3 + 1] = y * spread;
        centres[g * 3 + 2] = Math.sin(golden * g) * r * spread;
      } else {
        const angle = (2 * Math.PI * g) / groupCount;
        centres[g * 3] = Math.cos(angle) * spread;
        centres[g * 3 + 1] = Math.sin(angle) * spread;
      }
    }
  }
  const rand = prng(seed);
  for (let i = 0; i < n; i++) {
    const g = groups[i];
    const radius = LINK_DISTANCE * (dims === 3 ? Math.cbrt(sizes[g]) : Math.sqrt(sizes[g])) * 0.8 + 1;
    // A uniform point in the unit ball (disc), by rejection.
    let x: number, y: number, z: number;
    do {
      x = rand() * 2 - 1;
      y = rand() * 2 - 1;
      z = dims === 3 ? rand() * 2 - 1 : 0;
    } while (x * x + y * y + z * z > 1);
    pos[i * 3] = centres[g * 3] + x * radius;
    pos[i * 3 + 1] = centres[g * 3 + 1] + y * radius;
    pos[i * 3 + 2] = centres[g * 3 + 2] + z * radius;
  }
  return pos;
}

/**
 * A Barnes-Hut octree over flat arrays. A child slot holds -1 (empty), a cell
 * index (>= 0), or a point as `-2 - p`; points that share a slot at the
 * deepest level (or share a position) are chained through `next`.
 */
export class Octree {
  count = 0;
  private cap = 0;
  child = new Int32Array(0);
  /** Geometric centre and half-size of each cell. */
  private cx = new Float64Array(0);
  private cy = new Float64Array(0);
  private cz = new Float64Array(0);
  half = new Float64Array(0);
  /** Centre of mass and mass (point count) of each cell. */
  mx = new Float64Array(0);
  my = new Float64Array(0);
  mz = new Float64Array(0);
  mass = new Float64Array(0);
  next: Int32Array;
  private readonly stack = new Int32Array(8 * (MAX_DEPTH + 4));

  constructor(n: number) {
    this.next = new Int32Array(n);
    this.grow(Math.max(16, n * 2));
  }

  private grow(cap: number): void {
    const keep = this.count;
    const child = new Int32Array(cap * 8);
    child.set(this.child.subarray(0, keep * 8));
    this.child = child;
    const f64 = (old: Float64Array) => {
      const a = new Float64Array(cap);
      a.set(old.subarray(0, keep));
      return a;
    };
    this.cx = f64(this.cx);
    this.cy = f64(this.cy);
    this.cz = f64(this.cz);
    this.half = f64(this.half);
    this.mx = f64(this.mx);
    this.my = f64(this.my);
    this.mz = f64(this.mz);
    this.mass = f64(this.mass);
    this.cap = cap;
  }

  private cell(x: number, y: number, z: number, half: number): number {
    if (this.count === this.cap) this.grow(this.cap * 2);
    const c = this.count++;
    this.child.fill(-1, c * 8, c * 8 + 8);
    this.cx[c] = x;
    this.cy[c] = y;
    this.cz[c] = z;
    this.half[c] = half;
    return c;
  }

  private octant(c: number, x: number, y: number, z: number): number {
    return (x >= this.cx[c] ? 1 : 0) | (y >= this.cy[c] ? 2 : 0) | (z >= this.cz[c] ? 4 : 0);
  }

  /** Rebuild over `n` points (x, y, z interleaved), then sum every cell's mass. */
  build(pos: ArrayLike<number>, n: number): void {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    this.count = 0;
    if (n === 0) return;
    const half = Math.max(x1 - x0, y1 - y0, z1 - z0) / 2 + 1e-6;
    this.cell((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, half);
    for (let p = 0; p < n; p++) this.insert(pos, p);
    this.sum(pos);
  }

  private insert(pos: ArrayLike<number>, p: number): void {
    const px = pos[p * 3], py = pos[p * 3 + 1], pz = pos[p * 3 + 2];
    let c = 0;
    for (let depth = 0; ; depth++) {
      const o = this.octant(c, px, py, pz);
      const slot = c * 8 + o;
      const v = this.child[slot];
      if (v === -1) {
        this.child[slot] = -2 - p;
        this.next[p] = -1;
        return;
      }
      if (v >= 0) {
        c = v;
        continue;
      }
      const q = -2 - v;
      const qx = pos[q * 3], qy = pos[q * 3 + 1], qz = pos[q * 3 + 2];
      if ((qx === px && qy === py && qz === pz) || depth >= MAX_DEPTH) {
        this.next[p] = q;
        this.child[slot] = -2 - p;
        return;
      }
      // Split: a new cell takes the slot and the point already in it.
      const h = this.half[c] / 2;
      const nc = this.cell(
        this.cx[c] + (o & 1 ? h : -h),
        this.cy[c] + (o & 2 ? h : -h),
        this.cz[c] + (o & 4 ? h : -h),
        h,
      );
      this.child[slot] = nc;
      this.child[nc * 8 + this.octant(nc, qx, qy, qz)] = -2 - q;
      c = nc;
    }
  }

  /** Children are always made after their parent, so one backwards pass sums them. */
  private sum(pos: ArrayLike<number>): void {
    for (let c = this.count - 1; c >= 0; c--) {
      let m = 0, sx = 0, sy = 0, sz = 0;
      for (let o = 0; o < 8; o++) {
        const v = this.child[c * 8 + o];
        if (v >= 0) {
          const w = this.mass[v];
          m += w;
          sx += this.mx[v] * w;
          sy += this.my[v] * w;
          sz += this.mz[v] * w;
        } else if (v <= -2) {
          for (let p = -2 - v; p !== -1; p = this.next[p]) {
            m += 1;
            sx += pos[p * 3];
            sy += pos[p * 3 + 1];
            sz += pos[p * 3 + 2];
          }
        }
      }
      this.mass[c] = m;
      this.mx[c] = m > 0 ? sx / m : this.cx[c];
      this.my[c] = m > 0 ? sy / m : this.cy[c];
      this.mz[c] = m > 0 ? sz / m : this.cz[c];
    }
  }

  /**
   * Add the many-body force on points `from..to-1` to `vel`: `k / d²` along
   * the vector to every other point (k < 0 repels), a cell taken whole once
   * it is far enough for its size (θ).
   */
  applyCharge(pos: ArrayLike<number>, vel: Float64Array, from: number, to: number, k: number): void {
    if (this.count === 0) return;
    // Locals: the hot loop must not look the arrays up on `this` each time.
    const { child, next, mx, my, mz, half, mass, stack } = this;
    for (let i = from; i < to; i++) {
      const xi = pos[i * 3], yi = pos[i * 3 + 1], zi = pos[i * 3 + 2];
      let fx = 0, fy = 0, fz = 0;
      let sp = 0;
      stack[sp++] = 0;
      while (sp > 0) {
        const c = stack[--sp];
        const dx = mx[c] - xi, dy = my[c] - yi, dz = mz[c] - zi;
        let l = dx * dx + dy * dy + dz * dz;
        const w = half[c] * 2;
        if (w * w < THETA2 * l) {
          if (l < DISTANCE_MAX2) {
            if (l < DISTANCE_MIN2) l = Math.sqrt(DISTANCE_MIN2 * l);
            const f = (k * mass[c]) / l;
            fx += dx * f;
            fy += dy * f;
            fz += dz * f;
          }
          continue;
        }
        const base = c * 8;
        for (let o = 0; o < 8; o++) {
          const v = child[base + o];
          if (v >= 0) {
            stack[sp++] = v;
          } else if (v <= -2) {
            for (let p = -2 - v; p !== -1; p = next[p]) {
              if (p === i) continue;
              const ex = pos[p * 3] - xi, ey = pos[p * 3 + 1] - yi, ez = pos[p * 3 + 2] - zi;
              let d = ex * ex + ey * ey + ez * ez;
              if (d === 0 || d >= DISTANCE_MAX2) continue;
              if (d < DISTANCE_MIN2) d = Math.sqrt(DISTANCE_MIN2 * d);
              const f = k / d;
              fx += ex * f;
              fy += ey * f;
              fz += ez * f;
            }
          }
        }
      }
      vel[i * 3] += fx;
      vel[i * 3 + 1] += fy;
      vel[i * 3 + 2] += fz;
    }
  }
}

export interface LayoutGraph {
  n: number;
  /** Two node indexes per edge. */
  ends: ArrayLike<number>;
  /** One weight per edge (graph-weights.ts: 1 a link, 0.5 a shared source, 0.25 a related hint). */
  weights: ArrayLike<number>;
}

export interface Layout {
  n: number;
  dims: 2 | 3;
  pos: Float64Array;
  vel: Float64Array;
  alpha: number;
  ticks: number;
  /** Mean distance a node moved in the last tick. */
  motion: number;
  readonly alphaDecay: number;
  readonly ends: Uint32Array;
  readonly strength: Float64Array;
  readonly bias: Float64Array;
  readonly distance: Float64Array;
  readonly tree: Octree;
}

/**
 * A layout ready to tick. `start` is a seed from {@link seedPositions} (or a
 * previous layout to warm-start from, with a lower `alpha`).
 */
export function createLayout(graph: LayoutGraph, start: Float64Array, dims: 2 | 3, alpha = 1): Layout {
  const { n } = graph;
  const m = Math.floor(graph.ends.length / 2);
  const count = new Float64Array(n);
  const ends = new Uint32Array(m * 2);
  for (let e = 0; e < m; e++) {
    const a = graph.ends[e * 2], b = graph.ends[e * 2 + 1];
    ends[e * 2] = a;
    ends[e * 2 + 1] = b;
    count[a] += 1;
    count[b] += 1;
  }
  const strength = new Float64Array(m);
  const bias = new Float64Array(m);
  const distance = new Float64Array(m);
  for (let e = 0; e < m; e++) {
    const a = ends[e * 2], b = ends[e * 2 + 1];
    const w = graph.weights[e] ?? 1;
    strength[e] = w / Math.max(1, Math.min(count[a], count[b]));
    bias[e] = count[a] / Math.max(1, count[a] + count[b]);
    distance[e] = w >= 1 ? LINK_DISTANCE : LINK_DISTANCE * 1.6;
  }
  const pos = new Float64Array(start);
  if (dims === 2) for (let i = 0; i < n; i++) pos[i * 3 + 2] = 0;
  // Big graphs cool faster: the seed is already clustered and a tick costs more.
  const ticks = n > 10_000 ? 200 : 300;
  return {
    n,
    dims,
    pos,
    vel: new Float64Array(n * 3),
    alpha,
    ticks: 0,
    motion: Infinity,
    alphaDecay: 1 - Math.pow(ALPHA_MIN, 1 / ticks),
    ends,
    strength,
    bias,
    distance,
    tree: new Octree(n),
  };
}

/** One step of the simulation. Returns the new alpha. */
export function tick(layout: Layout): number {
  const { n, pos, vel, ends, strength, bias, distance } = layout;
  layout.alpha += -layout.alpha * layout.alphaDecay;
  const alpha = layout.alpha;
  const m = strength.length;

  for (let e = 0; e < m; e++) {
    const a = ends[e * 2] * 3, b = ends[e * 2 + 1] * 3;
    let x = pos[b] + vel[b] - pos[a] - vel[a];
    let y = pos[b + 1] + vel[b + 1] - pos[a + 1] - vel[a + 1];
    let z = pos[b + 2] + vel[b + 2] - pos[a + 2] - vel[a + 2];
    let l = Math.sqrt(x * x + y * y + z * z);
    if (l === 0) {
      x = 1e-3;
      l = 1e-3;
    }
    l = ((l - distance[e]) / l) * alpha * strength[e];
    x *= l;
    y *= l;
    z *= l;
    const bb = bias[e];
    vel[b] -= x * bb;
    vel[b + 1] -= y * bb;
    vel[b + 2] -= z * bb;
    vel[a] += x * (1 - bb);
    vel[a + 1] += y * (1 - bb);
    vel[a + 2] += z * (1 - bb);
  }

  layout.tree.build(pos, n);
  layout.tree.applyCharge(pos, vel, 0, n, CHARGE * alpha);
  const g = GRAVITY * alpha;
  for (let i = 0; i < n; i++) {
    vel[i * 3] -= pos[i * 3] * g;
    vel[i * 3 + 1] -= pos[i * 3 + 1] * g;
    vel[i * 3 + 2] -= pos[i * 3 + 2] * g;
  }

  let moved = 0;
  const flat = layout.dims === 2;
  for (let i = 0; i < n * 3; i += 3) {
    vel[i] *= VELOCITY_KEEP;
    vel[i + 1] *= VELOCITY_KEEP;
    vel[i + 2] = flat ? 0 : vel[i + 2] * VELOCITY_KEEP;
    pos[i] += vel[i];
    pos[i + 1] += vel[i + 1];
    pos[i + 2] += vel[i + 2];
    moved += Math.abs(vel[i]) + Math.abs(vel[i + 1]) + Math.abs(vel[i + 2]);
  }
  layout.motion = n > 0 ? moved / n : 0;
  layout.ticks++;
  return alpha;
}

/** Cold, or still: nothing visible will change any more. */
export function isSettled(layout: Layout): boolean {
  return layout.alpha < ALPHA_MIN || (layout.ticks > 30 && layout.motion < 0.01);
}

/** Copy the positions into `out` (x, y, z per node) for the renderer. */
export function writePositions(layout: Layout, out: Float32Array): Float32Array {
  const len = Math.min(out.length, layout.pos.length);
  for (let i = 0; i < len; i++) out[i] = layout.pos[i];
  return out;
}
