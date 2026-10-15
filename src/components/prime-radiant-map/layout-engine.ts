/**
 * The Map's layout engine, behind a message protocol so it runs the same in a
 * Web Worker (layout.worker.ts) and — where a worker cannot start — on the
 * page itself, in slices (layout-port.ts).
 *
 * On `start` it answers, in order: the seed positions (so the map draws at
 * once), the Louvain communities with the Insights, then positions as the
 * layout cools — at most one message a slice, and only into a buffer the page
 * has handed back, so a busy page is never flooded and nothing is allocated
 * per tick. The last message has `settled: true`.
 */
import { createLayout, isSettled, seedPositions, tick, writePositions, type Layout } from "@/lib/prime-radiant/graph-layout";
import { graphInsights, louvain, type GraphInsights } from "@/lib/prime-radiant/graph-communities";

export interface StartMessage {
  type: "start";
  n: number;
  ends: Uint32Array;
  weights: Float32Array;
  /** Domain index per node: the seed clusters. */
  groups: Uint16Array;
  degree: Float32Array;
  dims: 2 | 3;
  /** Positions to start from (a previous layout of the same pages), with how many of them are known. */
  warm?: { positions: Float32Array; known: Uint8Array };
}

export type ToEngine = StartMessage | { type: "buffer"; positions: Float32Array };

export type FromEngine =
  | { type: "positions"; positions: Float32Array; alpha: number; settled: boolean }
  | { type: "communities"; communities: Int32Array; insights: GraphInsights };

export interface LayoutEngine {
  handle(msg: ToEngine): void;
  stop(): void;
}

/** More pages than any vault the Map is drawn for; a bigger `n` is refused. */
export const MAX_NODES = 1 << 21;

/**
 * A message as it arrives in the worker, checked against the protocol. The
 * index arrays (edge ends, groups) are copied as plain integers and every one
 * must name a node, so the layout never indexes outside its own arrays. Null
 * for anything else.
 */
export function readToEngine(data: unknown): ToEngine | null {
  if (typeof data !== "object" || data === null) return null;
  const msg = data as Record<string, unknown>;
  if (msg.type === "buffer") return msg.positions instanceof Float32Array ? { type: "buffer", positions: msg.positions } : null;
  if (msg.type !== "start") return null;
  const { n, dims, warm } = msg;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_NODES) return null;
  if (dims !== 2 && dims !== 3) return null;
  if (!(msg.ends instanceof Uint32Array) || msg.ends.length % 2 !== 0) return null;
  if (!(msg.weights instanceof Float32Array) || msg.weights.length !== msg.ends.length / 2) return null;
  if (!(msg.groups instanceof Uint16Array) || msg.groups.length !== n) return null;
  if (!(msg.degree instanceof Float32Array) || msg.degree.length !== n) return null;
  const ends = new Uint32Array(msg.ends.length);
  for (let i = 0; i < ends.length; i++) {
    const v = msg.ends[i] >>> 0;
    if (v >= n) return null;
    ends[i] = v;
  }
  const groups = new Uint16Array(n);
  for (let i = 0; i < n; i++) groups[i] = msg.groups[i] & 0xffff;
  let checkedWarm: StartMessage["warm"];
  if (warm !== undefined) {
    const w = warm as { positions?: unknown; known?: unknown } | null;
    if (!w || !(w.positions instanceof Float32Array) || !(w.known instanceof Uint8Array) || w.known.length !== n) return null;
    checkedWarm = { positions: w.positions, known: w.known };
  }
  return { type: "start", n, ends, weights: msg.weights, groups, degree: msg.degree, dims, warm: checkedWarm };
}

/** How long one slice of ticks may run before the engine posts and yields. */
const SLICE_MS = 14;

export function createLayoutEngine(post: (msg: FromEngine, transfer: Transferable[]) => void): LayoutEngine {
  let layout: Layout | null = null;
  let spare: Float32Array[] = [];
  /** A post that found no buffer free: sent when the next one comes back. */
  let owed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const send = () => {
    if (!layout) return;
    const buf = spare.pop();
    if (!buf) {
      owed = true;
      return;
    }
    owed = false;
    writePositions(layout, buf);
    post({ type: "positions", positions: buf, alpha: layout.alpha, settled: isSettled(layout) }, [buf.buffer]);
  };

  const run = () => {
    timer = null;
    if (!layout) return;
    const until = performance.now() + SLICE_MS;
    do tick(layout);
    while (!isSettled(layout) && performance.now() < until);
    send();
    if (!isSettled(layout)) timer = setTimeout(run, 0);
  };

  const stop = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    layout = null;
  };

  return {
    stop,
    handle(msg) {
      if (msg.type === "buffer") {
        if (layout && msg.positions.length === layout.n * 3) spare.push(msg.positions);
        if (owed) send();
        return;
      }
      stop();
      const { n, ends, weights, groups, dims, warm } = msg;
      const seed = seedPositions(n, groups, dims);
      let alpha = 1;
      if (warm && warm.positions.length === n * 3) {
        let known = 0;
        for (let i = 0; i < n; i++) {
          if (!warm.known[i]) continue;
          known++;
          seed[i * 3] = warm.positions[i * 3];
          seed[i * 3 + 1] = warm.positions[i * 3 + 1];
          seed[i * 3 + 2] = warm.positions[i * 3 + 2];
        }
        // Mostly the same pages: settle the newcomers without reshuffling the rest.
        if (known >= n / 2) alpha = 0.3;
      }
      layout = createLayout({ n, ends, weights }, seed, dims, alpha);
      spare = [new Float32Array(n * 3), new Float32Array(n * 3)];
      send();
      const communities = louvain(n, ends, weights);
      const insights = graphInsights(n, ends, weights, msg.degree, communities);
      post({ type: "communities", communities, insights }, [communities.buffer]);
      timer = setTimeout(run, 0);
    },
  };
}
