/**
 * The Map outside React: the camera (an orbit in 3D; pan and zoom when flat),
 * pointer, wheel and pinch input, the render loop, picking, and the layout
 * port. PrimeRadiantMap.tsx hands it colours, node states and the visible
 * edges, and hears back hover, select and open.
 *
 * The loop runs only while something moves — the slow turn, a camera flight,
 * the framing easing in, a layout step — and never while the page is hidden
 * or the canvas has no size. The flat view draws once per change.
 *
 * Picking never walks every node on a pointer move: nodes are bucketed by
 * screen cell once per view change (camera, positions, size), and a move
 * looks at the cells under the pointer only.
 */
import type { GraphInsights } from "@/lib/prime-radiant/graph-communities";
import type { FromEngine, StartMessage } from "./layout-engine";
import { openLayoutPort, type LayoutPort } from "./layout-port";
import { GLRenderer, STATE_HIDDEN, STATE_HOVER, STATE_MATCH, STATE_SELECTED } from "./renderer-gl";
import { FlatRenderer } from "./renderer-2d";

export type MapKind = "webgl" | "2d";

export interface Renderer {
  readonly kind: MapKind;
  setNodes(n: number, sizes: Float32Array): void;
  setPositions(pos: Float32Array): void;
  setColors(rgba: Uint8Array): void;
  setStates(states: Uint8Array): void;
  setEdges(visible: Uint32Array, highlighted: Uint32Array, weak: Uint32Array): void;
  /** `scale` is device px per world unit at depth 1; `minPx` the smallest node radius, in device px. */
  draw(vp: Float32Array, width: number, height: number, scale: number, fog: [number, number], dpr: number, minPx: number): void;
  dispose(): void;
}

export interface MapViewEvents {
  onHover(i: number | null, x: number, y: number): void;
  onSelect(i: number | null): void;
  onOpen(i: number): void;
  /** After each drawn frame: the labels follow their nodes. */
  onFrame(): void;
  onCommunities(communities: Int32Array, insights: GraphInsights): void;
  onSettled(settled: boolean): void;
  onContextLost(): void;
  /** The layout cannot run at all (its code failed to load): no positions will come. */
  onLayoutFailed(): void;
}

export interface MapGraphInput {
  n: number;
  ends: Uint32Array;
  weights: Float32Array;
  groups: Uint16Array;
  degree: Float32Array;
  sizes: Float32Array;
}

/** Where the camera was, so a reopened Map comes back as it was left. */
export interface CameraState {
  yaw: number;
  pitch: number;
  distance: number;
  zoom: number;
  target: [number, number, number];
}

const FOV = (50 * Math.PI) / 180;
const TAN = Math.tan(FOV / 2);
const MAX_DPR = 2;
/** Radians per millisecond: one turn in about 80 seconds. */
const SPIN = 0.00008;
const CELL = 24;
const FLIGHT_MS = 650;
/**
 * The smallest node on screen, in CSS px: a page with no links is laid out
 * far from the rest and would otherwise be a speck of a device pixel or two.
 * A little smaller on a map of thousands, so it stays a picture, not a carpet.
 */
const MIN_RADIUS = 3.5;
const MIN_RADIUS_LARGE = 2;
const LARGE_MAP = 4000;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const nextFrame = (cb: FrameRequestCallback): number =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : window.setTimeout(() => cb(performance.now()), 16);
const cancelFrame = (id: number) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : window.clearTimeout(id));

export class MapView {
  readonly kind: MapKind;
  settled = false;
  private n = 0;
  private pos: Float32Array = new Float32Array(0);
  private sizes: Float32Array = new Float32Array(0);
  private base: Uint8Array = new Uint8Array(0);
  private states: Uint8Array = new Uint8Array(0);
  private hover = -1;
  private port: LayoutPort | null = null;
  /** The flat view has drawn this layout's seed (it next draws the settled result). */
  private drawnOnce = false;
  /** Positions have arrived for this graph: until then every node sits at the origin. */
  private placed = false;

  private yaw = 0.6;
  private pitch = 0.3;
  private distance = 800;
  private zoom = 1;
  private target = new Float64Array(3);
  private spin: boolean;
  private fitting = true;
  private fit = { x: 0, y: 0, z: 0, r: 100 };
  private flight: { t0: number; from: number[]; to: number[] } | null = null;
  private readonly vp = new Float32Array(16);

  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private raf = 0;
  private last = 0;
  private version = 0;
  private gridVersion = -1;
  private sx = new Float32Array(0);
  private sy = new Float32Array(0);
  private sr = new Float32Array(0);
  private sw = new Float32Array(0);
  private items = new Int32Array(0);
  private cellStart = new Int32Array(0);
  private cellFill = new Int32Array(0);
  private cols = 1;
  private rows = 1;
  private maxR = 0;

  private readonly pointers = new Map<number, { x: number; y: number }>();
  private down: { x: number; y: number; pan: boolean; moved: boolean } | null = null;
  private pinch = 0;
  private lastTap = { i: -1, t: 0 };
  private readonly resizer: ResizeObserver | null;
  private readonly cleanup: Array<() => void> = [];

  /** A view on `canvas`, or null when the canvas cannot give the context asked for. */
  static create(canvas: HTMLCanvasElement, kind: MapKind, events: MapViewEvents): MapView | null {
    try {
      if (kind === "webgl") {
        // preserveDrawingBuffer: the Screenshot app reads canvases with drawImage, between frames,
        // and without it a WebGL canvas reads back empty — the map came out as a blank square.
        const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
        return gl ? new MapView(canvas, new GLRenderer(gl), events) : null;
      }
      const ctx = canvas.getContext("2d");
      return ctx ? new MapView(canvas, new FlatRenderer(ctx), events) : null;
    } catch {
      return null;
    }
  }

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly renderer: Renderer,
    private readonly events: MapViewEvents,
  ) {
    this.kind = renderer.kind;
    this.spin = this.kind === "webgl";
    const on = (target: EventTarget, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    on(canvas, "pointerdown", this.onDown);
    on(canvas, "pointermove", this.onMove);
    on(canvas, "pointerup", this.onUp);
    on(canvas, "pointercancel", this.onUp);
    on(canvas, "pointerleave", this.onLeave);
    on(canvas, "wheel", this.onWheel, { passive: false });
    on(canvas, "contextmenu", (e: Event) => e.preventDefault());
    on(canvas, "webglcontextlost", (e: Event) => {
      e.preventDefault();
      this.events.onContextLost();
    });
    on(document, "visibilitychange", () => this.invalidate());
    this.resizer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.resize());
    this.resizer?.observe(canvas);
    this.resize();
  }

  // ── data ────────────────────────────────────────────────────────────────

  /**
   * Show a graph. `warm` is a previous layout of (some of) the same pages:
   * when it is settled and complete nothing is laid out again.
   */
  load(graph: MapGraphInput, warm?: { positions: Float32Array; known: Uint8Array; settled: boolean } | null): void {
    this.port?.close();
    this.port = null;
    const { n } = graph;
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.sizes = graph.sizes;
    this.base = new Uint8Array(n);
    this.states = new Uint8Array(n);
    this.sx = new Float32Array(n);
    this.sy = new Float32Array(n);
    this.sr = new Float32Array(n);
    this.sw = new Float32Array(n);
    this.items = new Int32Array(n);
    this.hover = -1;
    this.drawnOnce = false;
    this.placed = false;
    this.settled = false;
    this.renderer.setNodes(n, graph.sizes);
    const complete = warm && warm.positions.length === n * 3 && warm.known.every(Boolean);
    if (warm && complete && warm.settled) {
      this.positionsArrived(warm.positions, true);
      return;
    }
    this.events.onSettled(false);
    this.port = openLayoutPort(this.onLayout, () => this.events.onLayoutFailed());
    const start: StartMessage = {
      type: "start",
      n,
      ends: graph.ends,
      weights: graph.weights,
      groups: graph.groups,
      degree: graph.degree,
      dims: this.kind === "webgl" ? 3 : 2,
      warm: warm && warm.positions.length === n * 3 ? { positions: warm.positions, known: warm.known } : undefined,
    };
    this.port.post(start);
  }

  private onLayout = (msg: FromEngine) => {
    if (msg.type === "communities") {
      this.events.onCommunities(msg.communities, msg.insights);
      return;
    }
    if (msg.positions.length !== this.n * 3) return;
    this.positionsArrived(msg.positions, msg.settled);
    this.drawnOnce = true;
    // Hand the buffer back for the next step (the last one is ours to keep).
    if (!msg.settled) this.port?.post({ type: "buffer", positions: msg.positions }, [msg.positions.buffer]);
  };

  private positionsArrived(positions: Float32Array, settled: boolean): void {
    this.pos.set(positions.subarray(0, this.n * 3));
    this.placed = true;
    this.renderer.setPositions(this.pos);
    this.bounds();
    this.version++;
    if (settled !== this.settled) {
      this.settled = settled;
      this.events.onSettled(settled);
    }
    // The flat view is a still picture: the seed, then the settled layout.
    if (this.kind === "2d" && !settled && this.drawnOnce) return;
    this.invalidate();
  }

  /** The centre and reach of the graph, for framing it. */
  private bounds(): void {
    const { n, pos } = this;
    if (n === 0) return;
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < n; i++) {
      x += pos[i * 3];
      y += pos[i * 3 + 1];
      z += pos[i * 3 + 2];
    }
    x /= n;
    y /= n;
    z /= n;
    let sq = 0, max = 0;
    for (let i = 0; i < n; i++) {
      const d = (pos[i * 3] - x) ** 2 + (pos[i * 3 + 1] - y) ** 2 + (pos[i * 3 + 2] - z) ** 2;
      sq += d;
      if (d > max) max = d;
    }
    // A few far-flung orphans should not shrink the rest to a dot.
    const r = Math.min(Math.sqrt(max), Math.sqrt(sq / n) * 2) + 20;
    this.fit = { x, y, z, r };
  }

  positions(): Float32Array {
    return this.pos;
  }

  /** Whether the layout has placed the nodes yet (before that, {@link positions} are all zero). */
  get hasPositions(): boolean {
    return this.placed;
  }

  setColors(rgba: Uint8Array): void {
    this.renderer.setColors(rgba);
    this.invalidate();
  }

  /** Node states from React; the view adds the hover on top. */
  setStates(base: Uint8Array): void {
    this.base = base;
    this.compose();
    this.version++;
    this.invalidate();
  }

  private compose(): void {
    if (this.states.length !== this.base.length) this.states = new Uint8Array(this.base.length);
    this.states.set(this.base);
    if (this.hover >= 0 && this.hover < this.states.length) this.states[this.hover] |= STATE_HOVER;
    this.renderer.setStates(this.states);
  }

  /** Edges as pairs of node indexes: links and shared sources, a selected page's own, and the related hints. */
  setEdges(visible: Uint32Array, highlighted: Uint32Array, weak: Uint32Array = new Uint32Array(0)): void {
    this.renderer.setEdges(visible, highlighted, weak);
    this.invalidate();
  }

  // ── camera ──────────────────────────────────────────────────────────────

  camera(): CameraState {
    return { yaw: this.yaw, pitch: this.pitch, distance: this.distance, zoom: this.zoom, target: [this.target[0], this.target[1], this.target[2]] };
  }

  restoreCamera(c: CameraState): void {
    this.yaw = c.yaw;
    this.pitch = c.pitch;
    this.distance = c.distance;
    this.zoom = c.zoom;
    this.target.set(c.target);
    this.fitting = false;
    this.spin = false;
    this.changed();
  }

  /** The owner took the wheel: no more turning or reframing on our own. */
  interact(): void {
    this.spin = false;
    this.fitting = false;
  }

  /** Frame the whole graph again. */
  resetView(): void {
    this.dropHover();
    this.flight = null;
    this.fitting = true;
    if (this.kind === "2d") this.stepFit(true);
    this.changed();
  }

  /** Fly to the given nodes (all of them in view), or frame one up close. */
  flyTo(nodes: readonly number[]): void {
    if (nodes.length === 0 || this.n === 0) return;
    this.dropHover();
    let x = 0, y = 0, z = 0;
    for (const i of nodes) {
      x += this.pos[i * 3];
      y += this.pos[i * 3 + 1];
      z += this.pos[i * 3 + 2];
    }
    x /= nodes.length;
    y /= nodes.length;
    z /= nodes.length;
    let r = 0;
    for (const i of nodes) r = Math.max(r, Math.hypot(this.pos[i * 3] - x, this.pos[i * 3 + 1] - y, this.pos[i * 3 + 2] - z));
    r = Math.max(r + 20, 70);
    this.interact();
    if (this.kind === "2d") {
      this.target.set([x, y, 0]);
      this.zoom = this.fitZoom(r);
      this.changed();
      return;
    }
    const to = [x, y, z, this.fitDistance(r)];
    this.flight = { t0: performance.now(), from: [this.target[0], this.target[1], this.target[2], this.distance], to };
    this.invalidate();
  }

  orbit(dx: number, dy: number): void {
    if (this.kind === "2d") return this.pan(dx, dy);
    this.interact();
    this.yaw -= dx * 0.006;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dy * 0.006));
    this.changed();
  }

  pan(dx: number, dy: number): void {
    this.interact();
    if (this.kind === "2d") {
      this.target[0] -= dx / this.zoom;
      this.target[1] += dy / this.zoom;
    } else {
      const u = (this.distance * 2 * TAN) / Math.max(1, this.cssH);
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw), sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
      this.target[0] += (-cy * dx + -sp * sy * dy) * u;
      this.target[1] += cp * dy * u;
      this.target[2] += (sy * dx + -sp * cy * dy) * u;
    }
    this.changed();
  }

  /** Zoom by `factor` (> 1 is out), about a point on screen when flat. */
  zoomBy(factor: number, at?: { x: number; y: number }): void {
    this.interact();
    this.flight = null;
    if (this.kind === "2d") {
      const ax = (at?.x ?? this.cssW / 2) - this.cssW / 2, ay = (at?.y ?? this.cssH / 2) - this.cssH / 2;
      const wx = this.target[0] + ax / this.zoom, wy = this.target[1] - ay / this.zoom;
      this.zoom = Math.max(1e-4, Math.min(50, this.zoom / factor));
      this.target[0] = wx - ax / this.zoom;
      this.target[1] = wy + ay / this.zoom;
    } else {
      this.distance = Math.max(5, Math.min(this.fitDistance(this.fit.r) * 6, this.distance * factor));
    }
    this.changed();
  }

  private fitDistance(r: number): number {
    const aspect = this.cssH > 0 ? this.cssW / this.cssH : 1;
    const tan = Math.min(TAN, TAN * aspect);
    return r / Math.sin(Math.atan(tan));
  }

  private fitZoom(r: number): number {
    return (Math.max(1, Math.min(this.cssW, this.cssH)) / 2 / r) * 0.92;
  }

  /** Ease toward the whole graph in view; true while still moving. */
  private stepFit(jump = this.kind === "2d"): boolean {
    const f = this.fit;
    const k = jump ? 1 : 0.12;
    const t = this.target;
    t[0] += (f.x - t[0]) * k;
    t[1] += (f.y - t[1]) * k;
    t[2] += (f.z - t[2]) * k;
    if (this.kind === "2d") {
      this.zoom = this.fitZoom(f.r);
      return false;
    }
    const d = this.fitDistance(f.r);
    this.distance += (d - this.distance) * k;
    return Math.abs(d - this.distance) > 0.5 || Math.abs(f.x - t[0]) + Math.abs(f.y - t[1]) + Math.abs(f.z - t[2]) > 0.5;
  }

  private matrix(): void {
    const m = this.vp;
    const t = this.target;
    if (this.kind === "2d") {
      m.fill(0);
      const sx = (2 * this.zoom) / Math.max(1, this.cssW), sy = (2 * this.zoom) / Math.max(1, this.cssH);
      m[0] = sx;
      m[5] = sy;
      m[10] = 1;
      m[12] = -t[0] * sx;
      m[13] = -t[1] * sy;
      m[15] = 1;
      return;
    }
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw), sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    // Camera axes: x = (cy, 0, -sy), y = (-sp·sy, cp, -sp·cy), z (toward the eye) = (cp·sy, sp, cp·cy).
    const ax = [cy, 0, -sy], ay = [-sp * sy, cp, -sp * cy], az = [cp * sy, sp, cp * cy];
    const d = this.distance;
    const eye = [t[0] + az[0] * d, t[1] + az[1] * d, t[2] + az[2] * d];
    const dot = (a: number[]) => a[0] * eye[0] + a[1] * eye[1] + a[2] * eye[2];
    const view = [ax[0], ay[0], az[0], 0, ax[1], ay[1], az[1], 0, ax[2], ay[2], az[2], 0, -dot(ax), -dot(ay), -dot(az), 1];
    const near = Math.max(0.5, d * 0.01), far = d + this.fit.r * 4 + 1000;
    const f = 1 / TAN, aspect = this.cssH > 0 ? this.cssW / this.cssH : 1;
    const c = (far + near) / (near - far), e = (2 * far * near) / (near - far);
    for (let col = 0; col < 4; col++) {
      const v = col * 4;
      m[v] = (f / aspect) * view[v];
      m[v + 1] = f * view[v + 1];
      m[v + 2] = c * view[v + 2] + e * view[v + 3];
      m[v + 3] = -view[v + 2];
    }
  }

  /** Screen position (CSS px) of node `i` into `out`; returns its depth, or -1 when it is behind the camera. */
  project(i: number, out: Float32Array | number[]): number {
    const m = this.vp, p = this.pos;
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 1e-6) return -1;
    out[0] = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) * 0.5 * this.cssW;
    out[1] = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * 0.5 * this.cssH;
    return w;
  }

  /** CSS px per world unit at depth 1. */
  private scale(): number {
    return this.kind === "2d" ? this.zoom : this.cssH / 2 / TAN;
  }

  /** The smallest radius a node is drawn at, in CSS px. */
  minRadius(): number {
    return this.n > LARGE_MAP ? MIN_RADIUS_LARGE : MIN_RADIUS;
  }

  /** Node `i`'s radius on screen in CSS px, at the depth {@link project} gave, grown as its state grows it. */
  radius(i: number, depth: number): number {
    const s = this.states[i] ?? 0;
    const boost = s & STATE_SELECTED ? 1.7 : s & STATE_HOVER ? 1.45 : s & STATE_MATCH ? 1.25 : 1;
    return Math.max(this.minRadius(), (this.sizes[i] * this.scale()) / Math.max(depth, 0.001)) * boost;
  }

  // ── loop ────────────────────────────────────────────────────────────────

  private changed(): void {
    this.version++;
    this.invalidate();
  }

  invalidate(): void {
    if (this.raf || typeof document === "undefined" || document.hidden) return;
    this.raf = nextFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (document.hidden || this.cssW === 0 || this.cssH === 0) {
      this.last = 0;
      return;
    }
    const dt = this.last ? Math.min(64, now - this.last) : 16;
    this.last = now;
    let moving = false;
    if (this.spin) {
      this.yaw += dt * SPIN;
      moving = true;
    }
    if (this.flight) {
      const k = Math.min(1, (now - this.flight.t0) / FLIGHT_MS);
      const { from, to } = this.flight;
      const e = ease(k);
      for (let a = 0; a < 3; a++) this.target[a] = from[a] + (to[a] - from[a]) * e;
      this.distance = from[3] + (to[3] - from[3]) * e;
      if (k >= 1) this.flight = null;
      moving = true;
    } else if (this.fitting) {
      moving = this.stepFit() || moving;
    }
    if (moving) this.version++;
    this.matrix();
    const r = this.fit.r;
    this.renderer.draw(
      this.vp,
      this.canvas.width,
      this.canvas.height,
      this.scale() * this.dpr,
      [this.distance - r * 0.2, this.distance + r * 1.6],
      this.dpr,
      this.minRadius() * this.dpr,
    );
    this.events.onFrame();
    if (moving) this.raf = nextFrame(this.frame);
    else this.last = 0;
  };

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.dpr = Math.min(MAX_DPR, typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1);
    this.canvas.width = Math.max(1, Math.round(this.cssW * this.dpr));
    this.canvas.height = Math.max(1, Math.round(this.cssH * this.dpr));
    if (this.fitting && this.kind === "2d") this.stepFit(true);
    this.changed();
  }

  // ── picking ─────────────────────────────────────────────────────────────

  /** Bucket every visible node by the screen cell it sits in. O(n), once per view change. */
  private buildGrid(): void {
    this.matrix();
    const cols = (this.cols = Math.max(1, Math.ceil(this.cssW / CELL)));
    const rows = (this.rows = Math.max(1, Math.ceil(this.cssH / CELL)));
    if (this.cellStart.length < cols * rows + 1) {
      this.cellStart = new Int32Array(cols * rows + 1);
      this.cellFill = new Int32Array(cols * rows);
    } else this.cellStart.fill(0);
    const scale = this.scale();
    const min = this.minRadius();
    const out = [0, 0];
    let maxR = 0;
    for (let i = 0; i < this.n; i++) {
      const w = this.states[i] & STATE_HIDDEN ? -1 : this.project(i, out);
      if (w < 0 || out[0] < 0 || out[1] < 0 || out[0] >= this.cssW || out[1] >= this.cssH) {
        this.sw[i] = -1;
        continue;
      }
      this.sx[i] = out[0];
      this.sy[i] = out[1];
      this.sw[i] = w;
      const r = Math.max(min, (this.sizes[i] * scale) / w);
      this.sr[i] = r;
      if (r > maxR) maxR = r;
      this.cellStart[Math.floor(out[1] / CELL) * cols + Math.floor(out[0] / CELL) + 1]++;
    }
    for (let c = 0; c < cols * rows; c++) this.cellStart[c + 1] += this.cellStart[c];
    this.cellFill.set(this.cellStart.subarray(0, cols * rows));
    for (let i = 0; i < this.n; i++) {
      if (this.sw[i] < 0) continue;
      this.items[this.cellFill[Math.floor(this.sy[i] / CELL) * cols + Math.floor(this.sx[i] / CELL)]++] = i;
    }
    this.maxR = Math.min(maxR, 120);
    this.gridVersion = this.version;
  }

  /** The node under (x, y) in CSS px — the nearest in front — or -1. */
  pick(x: number, y: number): number {
    if (this.n === 0) return -1;
    if (this.gridVersion !== this.version) this.buildGrid();
    const reach = Math.ceil((this.maxR + 6) / CELL);
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    let best = -1, bestW = Infinity, bestD = Infinity;
    for (let row = Math.max(0, cy - reach); row <= Math.min(this.rows - 1, cy + reach); row++) {
      for (let col = Math.max(0, cx - reach); col <= Math.min(this.cols - 1, cx + reach); col++) {
        const c = row * this.cols + col;
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const i = this.items[k];
          const d = Math.hypot(this.sx[i] - x, this.sy[i] - y);
          const hit = this.sr[i] + 4;
          if (d > Math.max(hit, 6)) continue;
          // Inside a node: the front one wins. Only near one: the closest.
          const inside = d <= hit;
          if (inside ? this.sw[i] < bestW || bestD > hit : d < bestD) {
            best = i;
            bestW = inside ? this.sw[i] : bestW;
            bestD = d;
          }
        }
      }
    }
    return best;
  }

  // ── input ───────────────────────────────────────────────────────────────

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /**
   * The camera is about to jump: whatever page was under the pointer will not
   * be. Forget it (tooltip, highlight, hand cursor) until the pointer moves again.
   */
  private dropHover(): void {
    if (this.hover < 0) return;
    this.setHover(-1);
    this.events.onHover(null, 0, 0);
  }

  private setHover(i: number): void {
    if (i === this.hover) return;
    this.hover = i;
    this.compose();
    this.invalidate();
    this.setCursor();
  }

  /**
   * The pointer's shape: a hand over a page, a move cross while dragging, the
   * arrow anywhere else. Only shapes every cursor theme draws: DMZ-White,
   * Debian's default, has no grab hand, and Chromium then shows no pointer.
   */
  private setCursor(): void {
    const shape = this.down?.moved || this.pointers.size > 1 ? "move" : this.hover >= 0 ? "pointer" : "default";
    if (this.canvas.style.cursor !== shape) this.canvas.style.cursor = shape;
  }

  private onDown = (e: PointerEvent) => {
    const p = this.local(e);
    this.canvas.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, p);
    this.interact();
    this.flight = null;
    if (this.pointers.size === 1) {
      this.down = { x: p.x, y: p.y, pan: e.button === 2 || e.shiftKey || e.ctrlKey || e.metaKey, moved: false };
    } else {
      if (this.down) this.down.moved = true;
      this.pinch = this.spread();
    }
    this.setCursor();
  };

  private spread(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private onMove = (e: PointerEvent) => {
    const p = this.local(e);
    const prev = this.pointers.get(e.pointerId);
    if (!prev) {
      if (e.pointerType !== "touch") {
        this.setHover(this.pick(p.x, p.y));
        this.events.onHover(this.hover >= 0 ? this.hover : null, p.x, p.y);
      }
      return;
    }
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size >= 2) {
      // Two fingers: spread to zoom, move together to pan (half each, as each finger reports).
      const spread = this.spread();
      if (this.pinch > 0 && spread > 0) this.zoomBy(this.pinch / spread);
      this.pinch = spread;
      this.pan((p.x - prev.x) / 2, (p.y - prev.y) / 2);
      return;
    }
    const down = this.down;
    if (!down) return;
    if (!down.moved && Math.hypot(p.x - down.x, p.y - down.y) > 4) {
      down.moved = true;
      this.setHover(-1);
      this.setCursor();
      this.events.onHover(null, p.x, p.y);
    }
    if (!down.moved) return;
    if (down.pan) this.pan(p.x - prev.x, p.y - prev.y);
    else this.orbit(p.x - prev.x, p.y - prev.y);
  };

  private onUp = (e: PointerEvent) => {
    const p = this.local(e);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = 0;
    if (this.pointers.size > 0 || !this.down) return;
    const tapped = !this.down.moved && e.type === "pointerup";
    this.down = null;
    this.setCursor();
    if (!tapped) return;
    const i = this.pick(p.x, p.y);
    const now = performance.now();
    // A second tap on the same page soon after is a double-click: open it.
    if (i >= 0 && this.lastTap.i === i && now - this.lastTap.t < 400) {
      this.lastTap = { i: -1, t: 0 };
      this.events.onOpen(i);
      return;
    }
    this.lastTap = { i, t: now };
    this.events.onSelect(i >= 0 ? i : null);
  };

  private onLeave = () => {
    if (this.pointers.size > 0) return;
    this.setHover(-1);
    this.events.onHover(null, 0, 0);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    this.zoomBy(Math.exp(Math.max(-200, Math.min(200, e.deltaY * unit)) * 0.0015), this.local(e));
  };

  dispose(): void {
    if (this.raf) cancelFrame(this.raf);
    this.raf = 0;
    for (const fn of this.cleanup) fn();
    this.resizer?.disconnect();
    this.port?.close();
    this.port = null;
    this.renderer.dispose();
  }
}
