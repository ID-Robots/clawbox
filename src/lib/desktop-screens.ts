/**
 * The monitors the desktop is spread over, in the page's own CSS pixels.
 *
 * In monitor mode the ClawBox desktop is ONE app window laid over a row of
 * monitors (src/lib/monitors.ts). The page then has to know where each
 * monitor is: a window maximizes to the monitor it is on, a snap fills half
 * of THAT monitor, and the shelf, the chat, the icons and the notices stay on
 * the main monitor instead of straddling the gap between two.
 *
 * `null` — the state of every page that is not that window: one screen, the
 * viewport, exactly as the desktop has always been laid out. Everything here
 * answers the viewport then, so a caller needs no branch of its own.
 */
export interface DeskRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DeskScreen extends DeskRect {
  /** The monitor's id (src/lib/monitors-layout.ts `monitorId`). */
  id: string;
  label: string;
  /** Where the shelf, the chat and the desktop icons live. */
  main: boolean;
  /** The panel inside the device itself (named "Built-in screen", not its make). */
  builtIn?: boolean;
}

let screens: DeskScreen[] | null = null;
const listeners = new Set<() => void>();

export function getDeskScreens(): DeskScreen[] | null {
  return screens;
}

function same(a: DeskScreen[] | null, b: DeskScreen[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((s, i) => {
    const t = b[i];
    return s.id === t.id && s.main === t.main && s.x === t.x && s.y === t.y && s.width === t.width && s.height === t.height && s.label === t.label;
  });
}

export function setDeskScreens(next: DeskScreen[] | null): void {
  const value = next && next.length > 1 ? next : null;
  if (same(screens, value)) return;
  screens = value;
  for (const l of listeners) l();
}

export function subscribeDeskScreens(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Has a monitor session answered THIS page — `/setup-api/monitors` said
 * `available: true` to `useMonitorLayoutSync`, which asks only from an app
 * window? Then this page is the desktop in the "ClawBox Desktop" session, on
 * the box's own monitors, and a hidden page there is still the one on the
 * owner's display (`isBoxOwnScreen()` in visible-interval.ts).
 *
 * Kept apart from the screens because the screens are null for one monitor
 * on, a mirrored row or a viewport not yet the row's size — all of them still
 * that session's window. And asked of the box rather than read off
 * `display-mode`: the desktop installed as an app on a phone, or a tab put
 * in full screen, is an app display mode too, and on a box with no monitor
 * session (every Jetson) the answer there is `available: false`. Once true it
 * stays true for the page's life, the way the poll keeps the layout through a
 * read that failed: the session does not go away under its own window.
 */
let monitorSessionWindow = false;

export function isMonitorSessionWindow(): boolean {
  return monitorSessionWindow;
}

/** Only `useMonitorLayoutSync` sets it (and clears it when it unmounts). */
export function setMonitorSessionWindow(on: boolean): void {
  monitorSessionWindow = on;
}

function viewport(): DeskScreen {
  const w = typeof window === "undefined" ? 0 : window.innerWidth;
  const h = typeof window === "undefined" ? 0 : window.innerHeight;
  return { id: "viewport", label: "", x: 0, y: 0, width: w, height: h, main: true };
}

/** Every screen, the viewport alone when there is no monitor layout. */
export function deskScreens(): DeskScreen[] {
  return screens ?? [viewport()];
}

/** The main monitor (the viewport with one screen). */
export function mainScreen(): DeskScreen {
  return screens?.find((s) => s.main) ?? screens?.[0] ?? viewport();
}

const contains = (s: DeskRect, x: number, y: number) => x >= s.x && x < s.x + s.width && y >= s.y && y < s.y + s.height;

/** The screen a point is on; the nearest one when it is on none (a gap, or past an edge). */
export function screenAt(x: number, y: number): DeskScreen {
  const all = deskScreens();
  const hit = all.find((s) => contains(s, x, y));
  if (hit) return hit;
  let best = all[0];
  let bestD = Infinity;
  for (const s of all) {
    const dx = x < s.x ? s.x - x : x >= s.x + s.width ? x - (s.x + s.width - 1) : 0;
    const dy = y < s.y ? s.y - y : y >= s.y + s.height ? y - (s.y + s.height - 1) : 0;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

/** The screen a rect is mostly on, judged by its centre. */
export function screenForRect(r: DeskRect): DeskScreen {
  return screenAt(r.x + r.width / 2, r.y + Math.min(r.height / 2, 18));
}

/**
 * How far the main monitor's edges are from the viewport's: what a surface
 * pinned to an edge (`right: 12`, `bottom: 0`) adds to stay on the main
 * monitor. All zero with one screen.
 */
export function mainInsets(main: DeskRect = mainScreen()): { left: number; top: number; right: number; bottom: number } {
  if (!screens) return { left: 0, top: 0, right: 0, bottom: 0 };
  const vw = typeof window === "undefined" ? main.width : window.innerWidth;
  const vh = typeof window === "undefined" ? main.height : window.innerHeight;
  return {
    left: main.x,
    top: main.y,
    right: Math.max(0, vw - (main.x + main.width)),
    bottom: Math.max(0, vh - (main.y + main.height)),
  };
}

/**
 * Is there another screen directly against this one's edge (so the cursor
 * cannot rest on it)? With `at`, only a neighbour beside THAT point counts: on
 * a mixed-height row the tall monitor's edge is shared along the short one's
 * height and is an edge again below it, where nothing borders it.
 */
export function hasNeighbour(s: DeskRect, side: "left" | "right" | "top" | "bottom", at?: { x: number; y: number }): boolean {
  if (!screens) return false;
  return screens.some((o) => {
    if (o.x === s.x && o.y === s.y && o.width === s.width && o.height === s.height) return false;
    const overlapY = at ? at.y >= o.y && at.y < o.y + o.height : o.y < s.y + s.height && o.y + o.height > s.y;
    const overlapX = at ? at.x >= o.x && at.x < o.x + o.width : o.x < s.x + s.width && o.x + o.width > s.x;
    switch (side) {
      case "left": return overlapY && Math.abs(o.x + o.width - s.x) <= 1;
      case "right": return overlapY && Math.abs(o.x - (s.x + s.width)) <= 1;
      case "top": return overlapX && Math.abs(o.y + o.height - s.y) <= 1;
      case "bottom": return overlapX && Math.abs(o.y - (s.y + s.height)) <= 1;
    }
  });
}

function screenIn(list: DeskScreen[], x: number, y: number): DeskScreen {
  const hit = list.find((s) => contains(s, x, y));
  if (hit) return hit;
  let best = list[0];
  let bestD = Infinity;
  for (const s of list) {
    const dx = x < s.x ? s.x - x : x >= s.x + s.width ? x - (s.x + s.width - 1) : 0;
    const dy = y < s.y ? s.y - y : y >= s.y + s.height ? y - (s.y + s.height - 1) : 0;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

/**
 * Where a window belongs after the monitors changed: the same place on the
 * SAME monitor (matched by id), wherever that monitor now sits in the row —
 * swapping two monitors must not throw every window onto the other one. A
 * window whose monitor was turned off goes to the main monitor, at the same
 * offset; back to one screen, it keeps its offset on that screen. Null when
 * it does not move, or when there was no layout before (nothing to follow).
 * The caller still fits and clamps the result to the new monitor's size.
 */
export function followLayout(
  rect: DeskRect,
  prev: DeskScreen[] | null,
  next: DeskScreen[] | null,
): { x: number; y: number } | null {
  if (!prev || prev.length === 0) return null;
  const from = screenIn(prev, rect.x + rect.width / 2, rect.y + Math.min(rect.height / 2, 18));
  const to = next
    ? next.find((s) => s.id === from.id) ?? next.find((s) => s.main) ?? next[0]
    : { x: 0, y: 0 };
  if (!to) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return null;
  return { x: rect.x + dx, y: rect.y + dy };
}

/** The id of the monitor a window is on in `list` (judged like `screenForRect`). */
export function screenIdOf(rect: DeskRect, list: DeskScreen[]): string | null {
  return list.length ? screenIn(list, rect.x + rect.width / 2, rect.y + Math.min(rect.height / 2, 18)).id : null;
}

/**
 * Back from one screen (mirrored, or every other monitor off) to a row: a
 * window goes back to the monitor it was on before — `wasOn`, remembered when
 * the row went away — at the offset it has now; the main monitor when that one
 * is gone. Null when there is nothing to go back to.
 */
export function rejoinLayout(rect: DeskRect, wasOn: string | null, next: DeskScreen[] | null): { x: number; y: number } | null {
  if (!wasOn || !next || next.length === 0) return null;
  const to = next.find((s) => s.id === wasOn) ?? next.find((s) => s.main) ?? next[0];
  if (to.x === 0 && to.y === 0) return null;
  return { x: rect.x + to.x, y: rect.y + to.y };
}

/** What `/setup-api/monitors` answers, as far as the desktop reads it. */
export interface MonitorStatusLike {
  available?: boolean;
  main?: string | null;
  box?: { width: number; height: number } | null;
  monitors?: Array<{ id: string; label: string; enabled: boolean; rect: DeskRect | null; builtIn?: boolean }>;
  /** Every monitor shows the same picture: one screen as far as the page goes. */
  mirror?: boolean;
}

/**
 * The monitors in this page's CSS pixels — or null when this page is not the
 * window spread over them. The window sits at the row's origin and is exactly
 * as big as the row, so a page whose viewport has the row's proportions IS
 * that window; its zoom is the ratio between the two. Anything else (a tab on
 * a phone, a browser on the LAN, a window still being resized) gets null and
 * the plain one-screen desktop.
 */
export function screensFromStatus(status: MonitorStatusLike | null, vw: number, vh: number): DeskScreen[] | null {
  if (!status?.available || !status.box || !status.monitors || status.mirror) return null;
  const on = status.monitors.filter((m) => m.enabled && m.rect);
  if (on.length < 2 || status.box.width <= 0 || status.box.height <= 0 || vw <= 0 || vh <= 0) return null;
  // Monitors stacked on one origin show one picture: the page is one screen.
  if (on.every((m) => m.rect!.x === on[0].rect!.x && m.rect!.y === on[0].rect!.y)) return null;
  const ratioX = vw / status.box.width;
  const ratioY = vh / status.box.height;
  if (Math.abs(ratioX - ratioY) > 0.02) return null;
  const ox = Math.min(...on.map((m) => m.rect!.x));
  const oy = Math.min(...on.map((m) => m.rect!.y));
  const main = on.some((m) => m.id === status.main) ? status.main : on[0].id;
  return on
    .map((m) => ({
      id: m.id,
      label: m.label,
      x: Math.round((m.rect!.x - ox) * ratioX),
      y: Math.round((m.rect!.y - oy) * ratioY),
      width: Math.round(m.rect!.width * ratioX),
      height: Math.round(m.rect!.height * ratioY),
      main: m.id === main,
      ...(m.builtIn ? { builtIn: true } : {}),
    }))
    .sort((a, b) => a.x - b.x || a.y - b.y);
}

/** Dispatched after the Settings tab changed the layout, so the desktop reads it at once. */
export const MONITORS_CHANGED_EVENT = "clawbox:monitors-changed";
/** Dispatched by the Settings tab's Identify: every monitor shows its number for a moment. */
export const MONITORS_IDENTIFY_EVENT = "clawbox:monitors-identify";

/**
 * What Identify's event may carry: the monitor ids in the order the Monitors
 * tab NUMBERS them (its blocks, which follow an unapplied draft), so each
 * monitor shows the number the owner is looking at. Without it the desktop
 * numbers the monitors left to right as they stand.
 */
export interface MonitorsIdentifyDetail {
  order?: string[];
}

/**
 * Identify, from the Settings tab: false — and nothing dispatched — when this
 * page is not the window spread over the monitors, where no number could be
 * shown (a browser on the LAN, one monitor on, mirrored). A caller can read
 * the same answer up front from `getDeskScreens() !== null`.
 */
export function identifyMonitors(order?: string[]): boolean {
  if (!screens || typeof window === "undefined") return false;
  const detail: MonitorsIdentifyDetail = order ? { order: [...order] } : {};
  window.dispatchEvent(new CustomEvent(MONITORS_IDENTIFY_EVENT, { detail }));
  return true;
}
