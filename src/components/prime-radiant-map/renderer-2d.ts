/**
 * The flat Map, for a browser without WebGL2 or an owner who asked for less
 * motion: the same nodes, colours and states on a 2D canvas, drawn once per
 * change (never animated). Edges are one stroked path; nodes are batched by
 * colour, one fill per colour.
 */
import { STATE_DIM, STATE_HIDDEN, STATE_HOVER, STATE_MATCH, STATE_SELECTED } from "./renderer-gl";
import type { Renderer } from "./view";

export class FlatRenderer implements Renderer {
  readonly kind = "2d";
  private n = 0;
  private sizes: Float32Array = new Float32Array(0);
  private pos: Float32Array = new Float32Array(0);
  private colors: Uint8Array = new Uint8Array(0);
  private states: Uint8Array = new Uint8Array(0);
  private edges: Uint32Array = new Uint32Array(0);
  private hi: Uint32Array = new Uint32Array(0);

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  setNodes(n: number, sizes: Float32Array): void {
    this.n = n;
    this.sizes = sizes;
    this.pos = new Float32Array(n * 3);
  }

  setPositions(pos: Float32Array): void {
    this.pos.set(pos.subarray(0, this.n * 3));
  }

  setColors(rgba: Uint8Array): void {
    this.colors = rgba;
  }

  setStates(states: Uint8Array): void {
    this.states = states;
  }

  setEdges(visible: Uint32Array, highlighted: Uint32Array): void {
    this.edges = visible;
    this.hi = highlighted;
  }

  draw(vp: Float32Array, width: number, height: number, scale: number, _fog: [number, number], dpr: number): void {
    const { ctx, n, pos, states, colors, sizes } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    // Orthographic: screen = (vp · p + 1) / 2 · size, with y down.
    const sx = (i: number) => (vp[0] * pos[i * 3] + vp[4] * pos[i * 3 + 1] + vp[12] + 1) * 0.5 * width;
    const sy = (i: number) => (1 - (vp[1] * pos[i * 3] + vp[5] * pos[i * 3 + 1] + vp[13])) * 0.5 * height;

    const stroke = (list: Uint32Array, style: string) => {
      if (list.length === 0) return;
      ctx.beginPath();
      for (let e = 0; e < list.length; e += 2) {
        ctx.moveTo(sx(list[e]), sy(list[e]));
        ctx.lineTo(sx(list[e + 1]), sy(list[e + 1]));
      }
      ctx.strokeStyle = style;
      ctx.lineWidth = dpr;
      ctx.stroke();
    };
    stroke(this.edges, this.hi.length > 0 ? "rgba(168,173,184,0.06)" : "rgba(168,173,184,0.14)");
    stroke(this.hi, "rgba(190,195,205,0.7)");

    // Dimmed first, then the rest, then whatever is picked out — one path per colour each time.
    const picked = STATE_MATCH | STATE_SELECTED | STATE_HOVER;
    for (let layer = 0; layer < 3; layer++) {
      const paths = new Map<number, Path2D>();
      for (let i = 0; i < n; i++) {
        const s = states[i] ?? 0;
        if (s & STATE_HIDDEN) continue;
        const at = s & STATE_DIM ? 0 : s & picked ? 2 : 1;
        if (at !== layer) continue;
        const key = (colors[i * 4] << 16) | (colors[i * 4 + 1] << 8) | colors[i * 4 + 2];
        let path = paths.get(key);
        if (!path) paths.set(key, (path = new Path2D()));
        const r = Math.max(1.5 * dpr, sizes[i] * scale * (s & STATE_SELECTED ? 1.7 : s & STATE_HOVER ? 1.45 : s & STATE_MATCH ? 1.25 : 1));
        const x = sx(i), y = sy(i);
        path.moveTo(x + r, y);
        path.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.globalAlpha = layer === 0 ? 0.22 : 1;
      for (const [key, path] of paths) {
        ctx.fillStyle = `rgb(${key >> 16},${(key >> 8) & 255},${key & 255})`;
        ctx.fill(path);
        if (layer === 2) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 1.5 * dpr;
          ctx.stroke(path);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  dispose(): void {
    this.pos = new Float32Array(0);
  }
}
