/**
 * Monitor mode's arithmetic — pure, so the server, the Settings tab and the
 * desktop all reach the same answer from the same numbers.
 *
 * What the compositor says (`wlr-randr`'s text) becomes `MonitorOutput`s; the
 * owner's choices for each physical monitor (`MonitorSetting`, keyed by a
 * stable identity so a monitor keeps its resolution whichever socket it is
 * plugged into) and the left-to-right order become a `MonitorPlan`: which
 * outputs are on, in which mode, where. The layout is always a single row,
 * top-aligned, starting at (0, 0) — "left and right" is the whole model — so
 * the desktop window that spans the monitors can sit at the layout's origin.
 * The one other shape is MIRROR: every monitor that is on shows the same
 * picture, all of them at (0, 0).
 */

export const MONITOR_TRANSFORMS = [
  "normal", "90", "180", "270",
  "flipped", "flipped-90", "flipped-180", "flipped-270",
] as const;
export type MonitorTransform = (typeof MONITOR_TRANSFORMS)[number];

/** Scale factors the Settings tab offers; any value in [MIN_SCALE, MAX_SCALE] is accepted. */
export const MONITOR_SCALES = [1, 1.25, 1.5, 1.75, 2] as const;
export const MIN_SCALE = 0.5;
export const MAX_SCALE = 3;

export interface MonitorMode {
  width: number;
  height: number;
  /** Hz, as the compositor printed it (e.g. 59.951). */
  refresh: number;
  preferred: boolean;
}

export interface MonitorOutput {
  /** The connector, e.g. "HDMI-A-1". Changes when the cable moves. */
  name: string;
  description: string;
  make: string;
  model: string;
  serial: string | null;
  /** The physical monitor, independent of the connector it is on. */
  id: string;
  /** The panel inside the device itself (eDP, LVDS, DSI). */
  builtIn: boolean;
  physicalSize: { width: number; height: number } | null;
  enabled: boolean;
  modes: MonitorMode[];
  current: { width: number; height: number; refresh: number } | null;
  position: { x: number; y: number } | null;
  transform: MonitorTransform;
  scale: number;
  /**
   * Variable refresh rate, as the compositor reports it ("Adaptive Sync:");
   * absent when it does not say.
   */
  adaptiveSync?: boolean;
}

/** The owner's choice for one physical monitor. */
export interface MonitorSetting {
  enabled: boolean;
  width: number;
  height: number;
  refresh: number;
  scale: number;
  transform: MonitorTransform;
  /** Variable refresh rate; absent leaves the monitor as it is. */
  adaptiveSync?: boolean;
}

export interface MonitorLayout {
  /** Monitor ids, left to right. Monitors not listed go to the right end. */
  order: string[];
  /** The monitor the shelf, the chat and the desktop icons live on. */
  main: string | null;
  monitors: Record<string, MonitorSetting>;
  /** Every monitor that is on shows the same picture. Absent means a row. */
  mirror?: boolean;
}

export interface PlannedOutput {
  name: string;
  id: string;
  enabled: boolean;
  width: number;
  height: number;
  refresh: number;
  scale: number;
  transform: MonitorTransform;
  adaptiveSync?: boolean;
  /** Layout position (logical pixels), meaningful when enabled. */
  x: number;
  y: number;
}

export interface MonitorPlan {
  outputs: PlannedOutput[];
  /** The main monitor's id: always an enabled one. */
  main: string;
  /** Logical size of the whole row. */
  box: { width: number; height: number };
  /** Every monitor that is on is at (0, 0), showing the same picture. */
  mirror?: boolean;
}

const BUILT_IN = /^(eDP|LVDS|DSI)-/;

/** A stable name for the physical monitor behind a connector. */
export function monitorId(make: string, model: string, serial: string | null, name: string): string {
  const s = serial && serial !== "(null)" && serial.trim() ? serial.trim() : null;
  // Without a serial two identical monitors would share an id; the connector
  // tells them apart (they then follow their socket rather than themselves).
  return [make.trim() || "?", model.trim() || "?", s ?? `@${name}`].join("|");
}

function parseTransform(raw: string): MonitorTransform {
  const v = raw.trim() as MonitorTransform;
  return (MONITOR_TRANSFORMS as readonly string[]).includes(v) ? v : "normal";
}

/**
 * `wlr-randr`'s plain output (0.3 has no JSON):
 *
 *     HDMI-A-1 "AOC Q27B3MA 17ZP6HA000848 (HDMI-A-1)"
 *       Make: AOC
 *       Model: Q27B3MA
 *       Serial: 17ZP6HA000848
 *       Physical size: 600x340 mm
 *       Enabled: yes
 *       Modes:
 *         2560x1440 px, 59.951000 Hz (preferred, current)
 *       Position: 0,0
 *       Transform: normal
 *       Scale: 1.000000
 *       Adaptive Sync: disabled
 *
 * A disabled output prints no Position, Transform, Scale or Adaptive Sync.
 */
export function parseWlrRandr(text: string): MonitorOutput[] {
  const outputs: MonitorOutput[] = [];
  let cur: (Omit<MonitorOutput, "id" | "builtIn"> & { inModes: boolean }) | null = null;
  const finish = () => {
    if (!cur) return;
    const { inModes: _inModes, ...o } = cur;
    void _inModes;
    outputs.push({ ...o, id: monitorId(o.make, o.model, o.serial, o.name), builtIn: BUILT_IN.test(o.name) });
    cur = null;
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const head = /^(\S+)\s+"(.*)"\s*$/.exec(line);
    if (head && !line.startsWith(" ")) {
      finish();
      cur = {
        name: head[1], description: head[2], make: "", model: "", serial: null, physicalSize: null,
        enabled: false, modes: [], current: null, position: null, transform: "normal", scale: 1, inModes: false,
      };
      continue;
    }
    if (!cur) continue;
    const c: Omit<MonitorOutput, "id" | "builtIn"> & { inModes: boolean } = cur;
    const mode = /^\s+(\d+)x(\d+) px, ([\d.]+) Hz(?: \(([^)]*)\))?\s*$/.exec(line);
    if (mode && c.inModes) {
      const flags = (mode[4] ?? "").split(",").map((f) => f.trim());
      const m: MonitorMode = {
        width: Number(mode[1]), height: Number(mode[2]), refresh: Number(mode[3]), preferred: flags.includes("preferred"),
      };
      c.modes.push(m);
      if (flags.includes("current")) c.current = { width: m.width, height: m.height, refresh: m.refresh };
      continue;
    }
    const kv = /^\s+([A-Za-z ]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim();
    const val = kv[2].trim();
    c.inModes = key === "Modes";
    switch (key) {
      case "Make": c.make = val; break;
      case "Model": c.model = val; break;
      case "Serial": c.serial = val && val !== "(null)" ? val : null; break;
      case "Physical size": {
        const p = /^(\d+)x(\d+) mm$/.exec(val);
        c.physicalSize = p ? { width: Number(p[1]), height: Number(p[2]) } : null;
        break;
      }
      case "Enabled": c.enabled = val === "yes"; break;
      case "Position": {
        const p = /^(-?\d+),(-?\d+)$/.exec(val);
        c.position = p ? { x: Number(p[1]), y: Number(p[2]) } : null;
        break;
      }
      case "Transform": c.transform = parseTransform(val); break;
      case "Scale": {
        const s = Number(val);
        c.scale = Number.isFinite(s) && s > 0 ? s : 1;
        break;
      }
      case "Adaptive Sync":
        if (val === "enabled" || val === "disabled") c.adaptiveSync = val === "enabled";
        break;
    }
  }
  finish();
  // Two units of one model whose EDID carries the same serial (many panels
  // report a fixed 0x01010101) would share an id, and nothing could tell them
  // apart: both follow their connector instead, as a monitor with no serial does.
  const seen = new Map<string, number>();
  for (const o of outputs) seen.set(o.id, (seen.get(o.id) ?? 0) + 1);
  for (const o of outputs) if (seen.get(o.id)! > 1) o.id = `${o.id}@${o.name}`;
  return outputs;
}

/** Modes with duplicates (same size and refresh to the millihertz) folded, biggest first. */
export function distinctModes(modes: MonitorMode[]): MonitorMode[] {
  const seen = new Map<string, MonitorMode>();
  for (const m of modes) {
    const key = `${m.width}x${m.height}@${Math.round(m.refresh * 1000)}`;
    const had = seen.get(key);
    if (!had) seen.set(key, { ...m });
    else if (m.preferred) had.preferred = true;
  }
  return [...seen.values()].sort((a, b) => b.width * b.height - a.width * a.height || b.refresh - a.refresh);
}

export function preferredMode(o: MonitorOutput): MonitorMode | null {
  return o.modes.find((m) => m.preferred) ?? distinctModes(o.modes)[0] ?? null;
}

const rotated = (t: MonitorTransform) => t === "90" || t === "270" || t === "flipped-90" || t === "flipped-270";

/**
 * The size a mode takes in the layout, after rotation and scale — wlroots' own
 * arithmetic (`wlr_output_effective_resolution`, which every output's layout
 * box comes from): the pixel count divided by the scale in single precision
 * and TRUNCATED. Rounded instead, 2560 px at 1.5x would be 1707 here and 1706
 * in the compositor, and the next monitor placed at 1707 would leave a column
 * that belongs to no monitor.
 */
export function logicalSize(width: number, height: number, scale: number, transform: MonitorTransform): { width: number; height: number } {
  const [w, h] = rotated(transform) ? [height, width] : [width, height];
  const s = Math.fround(scale > 0 ? scale : 1);
  return { width: Math.trunc(Math.fround(w / s)), height: Math.trunc(Math.fround(h / s)) };
}

/**
 * A scale as the compositor will hold it: the output-management protocol
 * carries it as a 24.8 fixed-point number, so 1.235 arrives as 1.234375. Every
 * scale the Settings tab offers is already one of these.
 */
export function protocolScale(scale: number): number {
  return Math.round(scale * 256) / 256;
}

/** The setting an output stands in right now (what Revert goes back to). */
export function settingFromOutput(o: MonitorOutput): MonitorSetting | null {
  const mode = o.current ?? preferredMode(o);
  if (!mode) return null;
  const setting: MonitorSetting = { enabled: o.enabled, width: mode.width, height: mode.height, refresh: mode.refresh, scale: o.scale, transform: o.transform };
  if (o.adaptiveSync !== undefined) setting.adaptiveSync = o.adaptiveSync;
  return setting;
}

/** Are the monitors that are on showing one picture (two or more, all at one position)? */
export function isMirrored(outputs: MonitorOutput[]): boolean {
  const on = outputs.filter((o) => o.enabled && o.position);
  return on.length > 1 && on.every((o) => o.position!.x === on[0].position!.x && o.position!.y === on[0].position!.y);
}

/** The layout the compositor is showing now, as a `MonitorLayout`. */
export function layoutFromOutputs(outputs: MonitorOutput[], main: string | null): MonitorLayout {
  const monitors: Record<string, MonitorSetting> = {};
  for (const o of outputs) {
    const s = settingFromOutput(o);
    if (s) monitors[o.id] = s;
  }
  const order = [...outputs]
    .sort((a, b) => (a.enabled === b.enabled ? (a.position?.x ?? 0) - (b.position?.x ?? 0) : a.enabled ? -1 : 1))
    .map((o) => o.id);
  const layout: MonitorLayout = { order, main, monitors };
  if (isMirrored(outputs)) layout.mirror = true;
  return layout;
}

function findMode(o: MonitorOutput, s: Pick<MonitorSetting, "width" | "height" | "refresh">): MonitorMode | null {
  const same = o.modes.filter((m) => m.width === s.width && m.height === s.height);
  if (same.length === 0) return null;
  return same.reduce((best, m) => (Math.abs(m.refresh - s.refresh) < Math.abs(best.refresh - s.refresh) ? m : best));
}

/**
 * The plan for the monitors connected NOW, from the owner's saved layout.
 *
 * - A monitor the layout knows keeps its setting (a mode it no longer offers
 *   falls back to its preferred one).
 * - A monitor it has never seen is turned on at its preferred mode and goes to
 *   the right end of the row.
 * - At least one monitor is always on: when every connected one is set off —
 *   the laptop's own panel set off with the lid closed, then the external
 *   unplugged — the built-in panel (else the first) comes back on rather than
 *   leaving a device with no screen.
 * - The main monitor is the saved one when it is on, else the first one on
 *   that is not the built-in panel, else the first one on.
 * - Mirrored, every monitor that is on is at (0, 0); the row is as big as the
 *   biggest of them.
 */
export interface PlanOptions {
  /**
   * The device's lid is shut: a built-in panel cannot be seen, so it is
   * planned OFF whenever another monitor can carry the desktop (it is never
   * turned ON by this). A box without a lid never sets it.
   */
  lidClosed?: boolean;
}

export function planLayout(outputs: MonitorOutput[], saved: MonitorLayout | null, opts: PlanOptions = {}): MonitorPlan | null {
  if (outputs.length === 0) return null;
  const rows: Array<{ o: MonitorOutput; s: MonitorSetting }> = [];
  for (const o of outputs) {
    const pref = preferredMode(o);
    if (!pref) continue;
    const want = saved?.monitors[o.id];
    let setting: MonitorSetting;
    if (want) {
      const mode = findMode(o, want) ?? pref;
      setting = { ...want, width: mode.width, height: mode.height, refresh: mode.refresh };
    } else {
      setting = { enabled: true, width: pref.width, height: pref.height, refresh: pref.refresh, scale: 1, transform: "normal" };
    }
    rows.push({ o, s: setting });
  }
  if (rows.length === 0) return null;
  const lidShut = opts.lidClosed === true && rows.some((r) => !r.o.builtIn);
  if (lidShut) {
    for (const r of rows) if (r.o.builtIn) r.s = { ...r.s, enabled: false };
  }
  if (!rows.some((r) => r.s.enabled)) {
    const fallback = (lidShut ? rows.find((r) => !r.o.builtIn) : rows.find((r) => r.o.builtIn)) ?? rows[0];
    fallback.s = { ...fallback.s, enabled: true };
  }
  const rank = (id: string) => {
    const i = saved?.order.indexOf(id) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  // Among monitors the saved layout does not rank, the ones the compositor
  // places now keep their left-to-right order and a monitor with no position
  // (one that is off) goes after them: read as x=0 it sorted LEFT of the row,
  // so turning it on pushed every monitor already on screen to the right.
  const unplaced = (r: { o: MonitorOutput }) => (r.o.position ? 0 : 1);
  rows.sort((a, b) =>
    rank(a.o.id) - rank(b.o.id) ||
    unplaced(a) - unplaced(b) ||
    (a.o.position?.x ?? 0) - (b.o.position?.x ?? 0) ||
    a.o.name.localeCompare(b.o.name));
  const mirror = saved?.mirror === true && rows.filter((r) => r.s.enabled).length > 1;
  let x = 0;
  let width = 0;
  let height = 0;
  const planned: PlannedOutput[] = rows.map(({ o, s }) => {
    const p: PlannedOutput = { name: o.name, id: o.id, ...s, x: 0, y: 0 };
    if (s.enabled) {
      const size = logicalSize(s.width, s.height, s.scale, s.transform);
      if (!mirror) {
        p.x = x;
        x += size.width;
      }
      width = Math.max(width, mirror ? size.width : x);
      height = Math.max(height, size.height);
    }
    return p;
  });
  const on = planned.filter((p) => p.enabled);
  const savedMain = saved?.main ? on.find((p) => p.id === saved.main) : undefined;
  const main = savedMain ?? on.find((p) => !BUILT_IN.test(p.name)) ?? on[0];
  return { outputs: planned, main: main.id, box: { width, height }, mirror };
}

/**
 * `wlr-randr` arguments that put a plan on screen, in one configuration.
 * `withAdaptiveSync: false` leaves variable refresh out — the retry for a
 * compositor or monitor that refuses it, which would otherwise cost the whole
 * layout.
 */
export function wlrRandrArgs(plan: MonitorPlan, withAdaptiveSync = true): string[] {
  const args: string[] = [];
  // Off first, then on: a compositor that refuses the whole configuration on
  // one bad output refuses it before anything moved.
  for (const p of plan.outputs.filter((o) => !o.enabled)) args.push("--output", p.name, "--off");
  for (const p of plan.outputs.filter((o) => o.enabled)) {
    args.push(
      "--output", p.name, "--on",
      "--mode", `${p.width}x${p.height}@${p.refresh.toFixed(6)}Hz`,
      "--pos", `${p.x},${p.y}`,
      "--transform", p.transform,
      "--scale", String(p.scale),
    );
    if (withAdaptiveSync && p.adaptiveSync !== undefined) args.push("--adaptive-sync", p.adaptiveSync ? "enabled" : "disabled");
  }
  return args;
}

export type LayoutRefusal =
  | "invalid"
  | "unknown_monitor"
  | "unknown_mode"
  | "invalid_scale"
  | "invalid_transform"
  | "none_enabled"
  | "main_disabled";

/**
 * A layout the Settings tab sent, held to the monitors connected now. Every
 * value that reaches `wlr-randr` is rebuilt from the compositor's own lists —
 * the id from a connected output, the mode from that output's modes — never
 * passed through from the request.
 */
export function readLayoutRequest(
  body: unknown,
  outputs: MonitorOutput[],
): { ok: true; layout: MonitorLayout } | { ok: false; code: LayoutRefusal } {
  if (!body || typeof body !== "object") return { ok: false, code: "invalid" };
  const b = body as { order?: unknown; main?: unknown; monitors?: unknown; mirror?: unknown };
  if (!Array.isArray(b.order) || !b.monitors || typeof b.monitors !== "object") return { ok: false, code: "invalid" };
  if (b.mirror !== undefined && typeof b.mirror !== "boolean") return { ok: false, code: "invalid" };
  const byId = new Map(outputs.map((o) => [o.id, o]));
  const order: string[] = [];
  for (const id of b.order) {
    if (typeof id !== "string") return { ok: false, code: "invalid" };
    const o = byId.get(id);
    if (!o) return { ok: false, code: "unknown_monitor" };
    if (!order.includes(o.id)) order.push(o.id);
  }
  const monitors: Record<string, MonitorSetting> = {};
  for (const [id, raw] of Object.entries(b.monitors as Record<string, unknown>)) {
    const o = byId.get(id);
    if (!o) return { ok: false, code: "unknown_monitor" };
    if (!raw || typeof raw !== "object") return { ok: false, code: "invalid" };
    const r = raw as Record<string, unknown>;
    if (typeof r.enabled !== "boolean") return { ok: false, code: "invalid" };
    const width = Number(r.width), height = Number(r.height), refresh = Number(r.refresh), scale = Number(r.scale);
    if (![width, height, refresh].every(Number.isFinite)) return { ok: false, code: "invalid" };
    const mode = o.modes.find((m) => m.width === width && m.height === height && Math.abs(m.refresh - refresh) < 0.01);
    if (!mode) return { ok: false, code: "unknown_mode" };
    if (!Number.isFinite(scale) || scale < MIN_SCALE || scale > MAX_SCALE) return { ok: false, code: "invalid_scale" };
    const transform = (MONITOR_TRANSFORMS as readonly string[]).find((t) => t === r.transform) as MonitorTransform | undefined;
    if (!transform) return { ok: false, code: "invalid_transform" };
    if (r.adaptiveSync !== undefined && typeof r.adaptiveSync !== "boolean") return { ok: false, code: "invalid" };
    monitors[o.id] = {
      enabled: r.enabled, width: mode.width, height: mode.height, refresh: mode.refresh,
      scale: protocolScale(scale), transform,
    };
    if (typeof r.adaptiveSync === "boolean") monitors[o.id].adaptiveSync = r.adaptiveSync;
  }
  for (const o of outputs) if (!order.includes(o.id)) order.push(o.id);
  const on = outputs.filter((o) => (monitors[o.id] ?? settingFromOutput(o))?.enabled);
  if (on.length === 0) return { ok: false, code: "none_enabled" };
  let main: string | null = null;
  if (b.main !== undefined && b.main !== null) {
    if (typeof b.main !== "string" || !byId.has(b.main)) return { ok: false, code: "unknown_monitor" };
    if (!on.some((o) => o.id === b.main)) return { ok: false, code: "main_disabled" };
    main = b.main;
  }
  const layout: MonitorLayout = { order, main, monitors };
  if (b.mirror !== undefined) layout.mirror = b.mirror as boolean;
  return { ok: true, layout };
}

/** Saved layout merged with a new one: monitors not connected now keep their saved settings. */
export function mergeLayouts(saved: MonitorLayout | null, next: MonitorLayout): MonitorLayout {
  const order = [...next.order];
  for (const id of saved?.order ?? []) if (!order.includes(id)) order.push(id);
  const merged: MonitorLayout = { order, main: next.main ?? saved?.main ?? null, monitors: { ...(saved?.monitors ?? {}), ...next.monitors } };
  const mirror = next.mirror ?? saved?.mirror;
  if (mirror !== undefined) merged.mirror = mirror;
  return merged;
}

/** A hand-edited or old file read back strictly: anything unrecognised is dropped, never repaired. */
export function parseSavedLayout(raw: unknown): MonitorLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { order?: unknown; main?: unknown; monitors?: unknown; mirror?: unknown };
  if (!Array.isArray(r.order) || !r.monitors || typeof r.monitors !== "object") return null;
  const monitors: Record<string, MonitorSetting> = {};
  for (const [id, v] of Object.entries(r.monitors as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const s = v as Record<string, unknown>;
    const transform = (MONITOR_TRANSFORMS as readonly string[]).find((t) => t === s.transform) as MonitorTransform | undefined;
    const nums = [s.width, s.height, s.refresh, s.scale].map(Number);
    if (typeof s.enabled !== "boolean" || !transform || !nums.every(Number.isFinite)) continue;
    const [width, height, refresh, scale] = nums;
    if (scale < MIN_SCALE || scale > MAX_SCALE || width <= 0 || height <= 0) continue;
    monitors[id] = { enabled: s.enabled, width, height, refresh, scale, transform };
    if (typeof s.adaptiveSync === "boolean") monitors[id].adaptiveSync = s.adaptiveSync;
  }
  const layout: MonitorLayout = {
    order: r.order.filter((x): x is string => typeof x === "string"),
    main: typeof r.main === "string" ? r.main : null,
    monitors,
  };
  if (typeof r.mirror === "boolean") layout.mirror = r.mirror;
  return layout;
}
