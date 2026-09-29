/**
 * The desktop's open windows as they are saved and restored (TASK-1306).
 *
 * A refresh of the desktop page brings back exactly what was on it: which apps
 * were open, each window's place and size, the stacking order, which were
 * minimized, maximized or snapped, which one had the focus, and — for a Terminal
 * — its tabs and the device session each tab's shell runs in (the shell keeps
 * running on the box; scripts/terminal-sessions.mjs).
 *
 * The state is saved per ClawBox user on the device (`/setup-api/desktop/state`,
 * src/lib/desktop-state-store.ts), so it follows the user to another browser and
 * one user never sees another's windows; this browser keeps a copy of its own for
 * when the device store cannot be reached (src/lib/desktop-state-client.ts).
 *
 * Pure: the route, the desktop and the tests share it. Nothing here trusts what
 * it is handed — `sanitizeDesktopState` rebuilds a state field by field and
 * drops what does not fit, which is how both a PUT body and a copy read back
 * from localStorage are read.
 */

import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, TITLE_BAR_HEIGHT, type SnapZone } from "@/lib/window-snap";

export const DESKTOP_STATE_VERSION = 1;

/** Windows one desktop may bring back. More than anyone keeps open; a bound on what the route stores. */
export const MAX_SAVED_WINDOWS = 40;

/**
 * How many shells one Terminal window may hold. Every tab is a PTY, a WebSocket
 * and an xterm instance kept alive on an 8 GB board; eight is more than a person
 * uses and far fewer than would hurt. (TerminalTabs enforces it; the saved state
 * is held to it.)
 */
export const MAX_TERMINAL_TABS = 8;

/** The longest name a tab may be given. */
export const MAX_TAB_TITLE = 40;

/** The longest command a tab may carry (the Coding Agent's `cd … && claude-ds --resume …`). */
export const MAX_TAB_COMMAND = 2000;

/** The ids the desktop gives windows: `<appId>-<time>[-<n>]`. */
const WINDOW_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
/** App ids: built-ins and `installed-<slug>`. */
const APP_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const META_KEY_RE = /^[A-Za-z0-9_]{1,32}$/;
const MAX_META_ENTRIES = 12;
const MAX_META_VALUE = 4096;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** Coordinates past this are not a screen anyone has. */
const MAX_COORD = 20_000;

const SNAP_ZONES: ReadonlySet<string> = new Set(["left", "right", "top", "top-left", "top-right", "bottom-left", "bottom-right"]);

export type SavedSnapZone = Exclude<SnapZone, null>;

export interface SavedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SavedTerminalTab {
  id: number;
  /** A name the owner gave it. */
  title?: string;
  /** What the tab was opened to run (the window's `initialCommand`, first tab only). */
  command?: string;
  /** The device session its shell runs in. */
  session?: string;
}

export interface SavedTerminalTabs {
  tabs: SavedTerminalTab[];
  activeId: number;
  nextId: number;
}

export interface SavedWindow {
  id: string;
  appId: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  minimized: boolean;
  maximized?: boolean;
  snapped?: SavedSnapZone;
  /** Where a maximized or snapped window goes back to. */
  restore?: SavedRect;
  meta?: Record<string, string>;
  terminal?: SavedTerminalTabs;
}

export interface DesktopState {
  v: typeof DESKTOP_STATE_VERSION;
  /** When the browser took this picture (its clock), for choosing between the device's copy and its own. */
  savedAt: number;
  /** The desktop it was taken on. */
  viewport?: { width: number; height: number };
  /** Bottom to top: the array order IS the stacking order. */
  windows: SavedWindow[];
  /** The window that had the keyboard — the top one that was not minimized — or null. */
  focusedId: string | null;
}

/** The part of the desktop's window record this module reads and writes. */
export interface DesktopWindowRecord {
  id: string;
  appId: string;
  zIndex: number;
  minimized: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  meta?: Record<string, string>;
  maximized?: boolean;
  snapped?: SnapZone;
  restore?: SavedRect;
  terminal?: SavedTerminalTabs;
}

/** What `restoreDesktopWindows` lays the desktop out against. */
export interface DesktopViewport {
  width: number;
  height: number;
  /** The shelf's height, which windows stay above. */
  shelf: number;
}

/** The z-index the first restored window gets; each one above it gets the next. */
export const FIRST_WINDOW_Z = 100;

// ── Sanitizing ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function cleanRect(value: unknown): SavedRect | undefined {
  if (!isRecord(value)) return undefined;
  const x = finite(value.x, -MAX_COORD, MAX_COORD);
  const y = finite(value.y, -MAX_COORD, MAX_COORD);
  const width = finite(value.width, 1, MAX_COORD);
  const height = finite(value.height, 1, MAX_COORD);
  return x === undefined || y === undefined || width === undefined || height === undefined ? undefined : { x, y, width, height };
}

function cleanMeta(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (n >= MAX_META_ENTRIES) break;
    // `maximize` is a one-shot request (openApp's), never a property to replay.
    if (key === "maximize" || !META_KEY_RE.test(key) || typeof raw !== "string" || raw.length > MAX_META_VALUE) continue;
    out[key] = raw;
    n++;
  }
  return n > 0 ? out : undefined;
}

function cleanTerminal(value: unknown): SavedTerminalTabs | undefined {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return undefined;
  const tabs: SavedTerminalTab[] = [];
  const seen = new Set<number>();
  for (const raw of value.tabs) {
    if (tabs.length >= MAX_TERMINAL_TABS) break;
    if (!isRecord(raw)) continue;
    const id = raw.id;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > 1_000_000 || seen.has(id)) continue;
    seen.add(id);
    const tab: SavedTerminalTab = { id };
    const title = cleanString(raw.title, MAX_TAB_TITLE);
    if (title) tab.title = title;
    if (typeof raw.command === "string" && raw.command.trim() && raw.command.length <= MAX_TAB_COMMAND) tab.command = raw.command.trim();
    if (typeof raw.session === "string" && SESSION_ID_RE.test(raw.session)) tab.session = raw.session;
    tabs.push(tab);
  }
  if (tabs.length === 0) return undefined;
  const highest = Math.max(...tabs.map((tab) => tab.id));
  const activeId = typeof value.activeId === "number" && seen.has(value.activeId) ? value.activeId : tabs[0].id;
  const nextId = typeof value.nextId === "number" && Number.isInteger(value.nextId) && value.nextId > highest && value.nextId <= 1_000_001
    ? value.nextId
    : highest + 1;
  return { tabs, activeId, nextId };
}

function cleanWindow(value: unknown): SavedWindow | null {
  if (!isRecord(value)) return null;
  const { id, appId } = value;
  if (typeof id !== "string" || !WINDOW_ID_RE.test(id)) return null;
  if (typeof appId !== "string" || !APP_ID_RE.test(appId) || appId === "setup") return null;
  const win: SavedWindow = { id, appId, minimized: value.minimized === true };
  const x = finite(value.x, -MAX_COORD, MAX_COORD);
  const y = finite(value.y, -MAX_COORD, MAX_COORD);
  if (x !== undefined && y !== undefined) {
    win.x = x;
    win.y = y;
  }
  const width = finite(value.width, 1, MAX_COORD);
  const height = finite(value.height, 1, MAX_COORD);
  if (width !== undefined && height !== undefined) {
    win.width = width;
    win.height = height;
  }
  if (value.maximized === true) win.maximized = true;
  if (typeof value.snapped === "string" && SNAP_ZONES.has(value.snapped)) win.snapped = value.snapped as SavedSnapZone;
  const restore = cleanRect(value.restore);
  if (restore && (win.maximized || win.snapped)) win.restore = restore;
  const meta = cleanMeta(value.meta);
  if (meta) win.meta = meta;
  if (appId === "terminal") {
    const terminal = cleanTerminal(value.terminal);
    if (terminal) win.terminal = terminal;
  }
  return win;
}

/**
 * A desktop state rebuilt from untrusted input, or null when it is not one at
 * all. Windows that do not fit are dropped one by one — a single bad entry must
 * not cost the owner the rest of their layout — and so are repeated ids.
 */
export function sanitizeDesktopState(input: unknown): DesktopState | null {
  if (!isRecord(input) || input.v !== DESKTOP_STATE_VERSION || !Array.isArray(input.windows)) return null;
  const windows: SavedWindow[] = [];
  const ids = new Set<string>();
  for (const raw of input.windows) {
    if (windows.length >= MAX_SAVED_WINDOWS) break;
    const win = cleanWindow(raw);
    if (!win || ids.has(win.id)) continue;
    ids.add(win.id);
    windows.push(win);
  }
  const savedAt = finite(input.savedAt, 0, Number.MAX_SAFE_INTEGER) ?? 0;
  const state: DesktopState = { v: DESKTOP_STATE_VERSION, savedAt, windows, focusedId: null };
  if (isRecord(input.viewport)) {
    const width = finite(input.viewport.width, 1, MAX_COORD);
    const height = finite(input.viewport.height, 1, MAX_COORD);
    if (width !== undefined && height !== undefined) state.viewport = { width, height };
  }
  if (typeof input.focusedId === "string" && windows.some((w) => w.id === input.focusedId && !w.minimized)) {
    state.focusedId = input.focusedId;
  }
  return state;
}

// ── Desktop ⇄ saved ────────────────────────────────────────────────────────

/**
 * The picture of the desktop that is saved: its windows bottom to top, the one
 * with the focus, and the screen it was taken on. The setup wizard's window is
 * never saved — it is a step, not a place.
 */
export function snapshotDesktop(
  windows: readonly DesktopWindowRecord[],
  opts: { savedAt: number; viewport?: { width: number; height: number } },
): DesktopState {
  const ordered = windows.filter((w) => w.appId !== "setup").slice().sort((a, b) => a.zIndex - b.zIndex);
  const saved: SavedWindow[] = ordered.map((w) => {
    const out: SavedWindow = { id: w.id, appId: w.appId, minimized: w.minimized };
    if (w.x !== undefined && w.y !== undefined) {
      out.x = w.x;
      out.y = w.y;
    }
    if (w.width !== undefined && w.height !== undefined) {
      out.width = w.width;
      out.height = w.height;
    }
    if (w.maximized) out.maximized = true;
    if (w.snapped) out.snapped = w.snapped;
    if (w.restore && (w.maximized || w.snapped)) out.restore = { ...w.restore };
    if (w.meta && Object.keys(w.meta).length > 0) out.meta = { ...w.meta };
    if (w.terminal) out.terminal = { ...w.terminal, tabs: w.terminal.tabs.map((tab) => ({ ...tab })) };
    return out;
  });
  const visible = ordered.filter((w) => !w.minimized);
  const state: DesktopState = {
    v: DESKTOP_STATE_VERSION,
    savedAt: opts.savedAt,
    windows: saved,
    focusedId: visible.length > 0 ? visible[visible.length - 1].id : null,
  };
  if (opts.viewport) state.viewport = { ...opts.viewport };
  return state;
}

/** What a state says about the desktop — its windows and focus — without when or on which screen it was taken. */
export function desktopLayoutKey(state: DesktopState): string {
  return JSON.stringify({ windows: state.windows, focusedId: state.focusedId });
}

/**
 * Keep a rect on a desktop smaller than the one it was saved on — a phone
 * turned landscape, a browser made narrower: no wider or taller than the
 * desktop, its title bar above the shelf and its right-hand controls on screen.
 * The same rules ChromeWindow applies to geometry that arrives from outside
 * (`fitWindowSize` + `clampWindowPosition` in src/lib/window-snap.ts), without
 * reading the live window, so the saved copy says what is on screen.
 */
export function clampRectToViewport(rect: SavedRect, viewport: DesktopViewport): SavedRect {
  const availW = Math.max(1, viewport.width);
  const availH = Math.max(1, viewport.height - viewport.shelf);
  const width = Math.max(Math.min(MIN_WINDOW_WIDTH, availW), Math.min(rect.width, availW));
  const height = Math.max(Math.min(MIN_WINDOW_HEIGHT, availH), Math.min(rect.height, availH));
  const x = Math.min(Math.max(rect.x, 0), Math.max(0, availW - width));
  const y = Math.min(Math.max(rect.y, 0), Math.max(0, availH - TITLE_BAR_HEIGHT));
  return { x, y, width, height };
}

/**
 * The desktop's window records for a saved state: in its stacking order from
 * FIRST_WINDOW_Z up, the focused window on top of the ones that are showing,
 * and — on a desktop (not a phone, whose windows are full screen and must not
 * rewrite the desktop's layout) — every rect kept inside `viewport`.
 */
export function restoreDesktopWindows(
  state: DesktopState,
  opts: { viewport?: DesktopViewport; clamp?: boolean } = {},
): DesktopWindowRecord[] {
  const order = state.windows.slice();
  if (state.focusedId) {
    // The focused window is the top one that is SHOWING: it goes just above
    // the last window that is not minimized (a minimized one's place in the
    // stack is seen by nobody), so a state that already says so is left as
    // it is and a restore changes nothing that would be saved again.
    const at = order.findIndex((w) => w.id === state.focusedId);
    let lastShowing = -1;
    order.forEach((w, i) => { if (!w.minimized) lastShowing = i; });
    if (at >= 0 && at < lastShowing) {
      const [focused] = order.splice(at, 1);
      order.splice(lastShowing, 0, focused);
    }
  }
  const clamp = opts.clamp !== false && opts.viewport ? opts.viewport : null;
  return order.map((w, i) => {
    const record: DesktopWindowRecord = { id: w.id, appId: w.appId, zIndex: FIRST_WINDOW_Z + i, minimized: w.minimized };
    if (w.x !== undefined && w.y !== undefined && w.width !== undefined && w.height !== undefined) {
      const rect = clamp ? clampRectToViewport({ x: w.x, y: w.y, width: w.width, height: w.height }, clamp) : { x: w.x, y: w.y, width: w.width, height: w.height };
      Object.assign(record, rect);
    } else if (w.x !== undefined && w.y !== undefined) {
      record.x = w.x;
      record.y = w.y;
    }
    if (w.maximized) record.maximized = true;
    if (w.snapped) record.snapped = w.snapped;
    if (w.restore) record.restore = clamp ? clampRectToViewport(w.restore, clamp) : { ...w.restore };
    if (w.meta) record.meta = { ...w.meta };
    if (w.terminal) record.terminal = { ...w.terminal, tabs: w.terminal.tabs.map((tab) => ({ ...tab })) };
    return record;
  });
}

// ── Device copy vs this browser's ──────────────────────────────────────────

/** This browser's own copy: the state, and whether the device has it too. */
export interface LocalDesktopCopy {
  state: DesktopState;
  /** False while the last save has not reached the device. */
  synced: boolean;
}

/**
 * Which state to restore.
 *
 * The device's copy is the one that follows the user between browsers, so it
 * wins — except over a newer copy this browser could not deliver (the device
 * store was unreachable when it was saved), which is then restored and sent
 * again. With the device unreachable, this browser's copy is all there is.
 */
export function pickDesktopState(
  device: { reachable: true; state: DesktopState | null } | { reachable: false },
  local: LocalDesktopCopy | null,
): { state: DesktopState | null; source: "device" | "local" | "none"; resend: boolean } {
  if (!device.reachable) {
    return local ? { state: local.state, source: "local", resend: true } : { state: null, source: "none", resend: false };
  }
  if (local && !local.synced && local.state.savedAt > (device.state?.savedAt ?? -1)) {
    return { state: local.state, source: "local", resend: true };
  }
  if (device.state) return { state: device.state, source: "device", resend: false };
  return { state: null, source: "none", resend: false };
}

/**
 * The workspace a box saved before per-user desktop state existed —
 * `desktop_open_windows`, the owner's preference — brought back the way it was
 * then: every window on the shelf, minimized, at its old place.
 */
export function stateFromLegacyWindows(value: unknown, savedAt = 0): DesktopState | null {
  if (!Array.isArray(value)) return null;
  const windows = value
    .filter((w): w is Record<string, unknown> => isRecord(w))
    .map((w, i) => ({ ...w, id: `${String(w.appId)}-legacy-${i}`, minimized: true }));
  const state = sanitizeDesktopState({ v: DESKTOP_STATE_VERSION, savedAt, windows, focusedId: null });
  return state && state.windows.length > 0 ? state : null;
}
