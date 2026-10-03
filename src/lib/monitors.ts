/**
 * Monitor mode, the server half: the monitors the desktop session's
 * compositor drives, the owner's layout for them, and keeping the ClawBox
 * desktop spread over all of them.
 *
 * The session is labwc (scripts/x64-migration/kiosk/clawbox-desktop-session),
 * a wlroots compositor, so `wlr-randr` reads and sets the outputs through the
 * output-management protocol — same user as this web server, through the
 * session's own Wayland socket. The desktop is a Chrome app window; after a
 * layout change it is resized over the new row of monitors through the kiosk
 * Chrome's loopback DevTools port (the session's watchdog does the same every
 * few seconds, so a desktop survives this process being down).
 *
 * Inert unless the box has a kiosk (`kioskConfigured`, /etc/clawbox/kiosk.env)
 * AND the session running now is that labwc session (`monitorModeSession`):
 * every other box answers `{ available: false }` and runs nothing. The cage
 * kiosk answers `wlr-randr` as well, which is why answering it is not enough.
 *
 * Every applied change is PROVISIONAL for `REVERT_AFTER_MS`: a resolution the
 * monitor cannot show leaves the owner looking at a black screen, so unless
 * Keep arrives the previous layout comes back by itself. Only a kept layout
 * is saved.
 */
import fs from "fs";
import { execFile } from "child_process";
import path from "./runtime-path";
import { DATA_DIR } from "./config-store";
import { kioskConfigured } from "./kiosk-env";
import { isDesktopUrl, kioskCdpPort, readKioskUrl } from "./kiosk-tabs";
import { processStore } from "./process-store";
import {
  distinctModes,
  layoutFromOutputs,
  logicalSize,
  mergeLayouts,
  parseSavedLayout,
  parseWlrRandr,
  isMirrored,
  planLayout,
  wlrRandrArgs,
  type MonitorLayout,
  type MonitorMode,
  type MonitorOutput,
  type MonitorPlan,
  type MonitorTransform,
} from "./monitors-layout";

export const MONITORS_FILE = path.join(DATA_DIR, "monitors.json");
/** How long an applied layout waits for Keep before it is undone. */
export const REVERT_AFTER_MS = 20_000;
/** How soon an undo the compositor did not take is tried again. */
export const REVERT_RETRY_MS = 3_000;
/**
 * Undo attempts before a trial is given up on: the reconciler then puts the
 * SAVED layout back, which it cannot do while a trial is pending — so retrying
 * for ever would also stop the box following a monitor plugged in or out.
 */
export const MAX_REVERT_ATTEMPTS = 5;
/** How often the reconciler looks for a monitor plugged in or out. */
export const RECONCILE_INTERVAL_MS = 3_000;
/**
 * How old a compositor read may be and still answer `getMonitorStatus()` (the
 * desktop's 5 s GET, and the Settings tab's) — see `readCompositorShared`.
 * Half the reconciler's interval, so a GET is never answered from further
 * back than the reconciler itself looks.
 */
export const STATUS_READ_REUSE_MS = 1_500;
const WLR_TIMEOUT_MS = 5_000;
/** Each DevTools call's ceiling — connecting, and every command after it. */
const CDP_TIMEOUT_MS = 4_000;
/**
 * The whole resize's ceiling. It runs inside the one-change-at-a-time chain,
 * where a call left waiting would hold every later Apply, Keep, Revert and
 * reconcile — the trial's own timed undo among them.
 */
const SPAN_BUDGET_MS = 8_000;
/**
 * `$XDG_RUNTIME_DIR/clawbox-monitor-mode`: the pid of the "ClawBox Desktop"
 * session's compositor. clawbox-desktop-session writes its own pid there and
 * then execs labwc, so the pid IS labwc's.
 */
export const MONITOR_MODE_MARKER = "clawbox-monitor-mode";
const MONITOR_MODE_COMPOSITOR = "labwc";
/** How many desktop windows (DevTools targets) are remembered as the app window. */
const KNOWN_DESKTOP_TARGETS = 16;

export interface MonitorView {
  id: string;
  name: string;
  /** "AOC Q27B3MA" — make and model, for the owner's eyes. */
  label: string;
  builtIn: boolean;
  enabled: boolean;
  modes: MonitorMode[];
  current: { width: number; height: number; refresh: number } | null;
  scale: number;
  transform: MonitorTransform;
  /** Where it sits in the row (logical px) while it is on. */
  rect: { x: number; y: number; width: number; height: number } | null;
  physicalSize: { width: number; height: number } | null;
  /** Variable refresh rate; null when the compositor does not report it. */
  adaptiveSync: boolean | null;
}

export interface MonitorStatus {
  available: boolean;
  monitors: MonitorView[];
  /** Ids, left to right: the ones on first, by position. */
  order: string[];
  main: string | null;
  /** The whole row (logical px), from its top-left corner at (0, 0). */
  box: { width: number; height: number } | null;
  /** A layout on trial: it is undone at `deadline` unless kept. */
  pending: { deadline: number } | null;
  /** Every monitor that is on shows the same picture. */
  mirror: boolean;
  /**
   * Monitors whose variable refresh rate the last Apply asked for and the
   * compositor refused (the rest of that layout landed without it).
   */
  refusedAdaptiveSync?: string[];
}

interface SavedFile {
  version: 1;
  layout: MonitorLayout | null;
  /**
   * What is on screen now — read by the session for the shelf's margin, which
   * goes on every output while the monitors are mirrored (`mirror`).
   */
  applied: { main: string | null; mainOutput: string | null; box: { width: number; height: number } | null; mirror?: boolean } | null;
}

/** A layout on screen ON TRIAL, and what undoing it puts back. */
interface Trial {
  previous: MonitorLayout;
  next: MonitorLayout;
  deadline: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Undo attempts the compositor refused (see MAX_REVERT_ATTEMPTS). */
  failedReverts: number;
}

interface MonitorState {
  pending: Trial | null;
  /** What the reconciler last put on screen (or found there): see `signatureOf`. */
  signature: string | null;
  reconciler: ReturnType<typeof setInterval> | null;
  busy: Promise<unknown> | null;
  /**
   * Monitors that refused variable refresh this session: their switch is not
   * offered again (the compositor does not say in advance which can).
   */
  noAdaptiveSync: Set<string>;
  /** DevTools targets seen as the desktop's app window, oldest first. */
  desktopTargets?: string[];
  /**
   * Bumped by every change put on screen, before wlr-randr is asked and again
   * once it has answered: a read begun under an older number may show the
   * screen as it was, and is never handed to a GET (`readCompositorShared`).
   */
  readGeneration?: number;
  /** The newest read of this generation, and when it was begun (`performance.now()`). */
  lastRead?: { at: number; generation: number; result: Compositor | null } | null;
  /** The read on its way, which a GET waits for rather than run wlr-randr again. */
  reading?: { at: number; generation: number; promise: Promise<Compositor | null> } | null;
}

const state = () =>
  processStore<MonitorState>("monitors", () => ({ pending: null, signature: null, reconciler: null, busy: null, noAdaptiveSync: new Set() }));

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ── The compositor ──────────────────────────────────────────────────────────

export interface WaylandDisplay {
  runtimeDir: string;
  display: string;
}

/** The session's Wayland sockets, newest first (a restarted session makes a new one). */
export function findWaylandDisplays(uid = process.getuid?.() ?? 0): WaylandDisplay[] {
  const runtimeDir = process.env.CLAWBOX_MONITORS_RUNTIME_DIR || `/run/user/${uid}`;
  let names: string[];
  try {
    names = fs.readdirSync(/* turbopackIgnore: true */ runtimeDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^wayland-\d+$/.test(n))
    .map((n) => {
      let mtime = 0;
      try {
        const st = fs.statSync(/* turbopackIgnore: true */ `${runtimeDir}/${n}`);
        if (!st.isSocket()) return null;
        mtime = st.mtimeMs;
      } catch {
        return null;
      }
      return { runtimeDir, display: n, mtime };
    })
    .filter((d): d is WaylandDisplay & { mtime: number } => d !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ runtimeDir: r, display }) => ({ runtimeDir: r, display }));
}

/**
 * The pid of the "ClawBox Desktop" session's compositor when that is the
 * session the displays in `runtimeDir` belong to, else null. The session
 * leaves its pid in `MONITOR_MODE_MARKER`; a marker an earlier session left
 * behind names a pid that is gone, or is not labwc any more, and counts for
 * nothing. `CLAWBOX_MONITORS_COMPOSITOR` names another process for the suites.
 */
export function monitorModeSession(runtimeDir: string): number | null {
  let pid: number;
  try {
    const raw = fs.readFileSync(/* turbopackIgnore: true */ `${runtimeDir}/${MONITOR_MODE_MARKER}`, "utf8").trim();
    if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
    pid = Number(raw);
  } catch {
    return null;
  }
  try {
    const comm = fs.readFileSync(/* turbopackIgnore: true */ `/proc/${pid}/comm`, "utf8").trim();
    return comm === (process.env.CLAWBOX_MONITORS_COMPOSITOR || MONITOR_MODE_COMPOSITOR) ? pid : null;
  } catch {
    return null;
  }
}

/** wlr-randr failed; `timedOut` when it was killed mid-call, so the compositor may have taken the change. */
class WlrRandrError extends Error {
  constructor(message: string, readonly timedOut: boolean) {
    super(message);
  }
}

function wlrRandr(display: WaylandDisplay, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      /* turbopackIgnore: true */ process.env.CLAWBOX_WLR_RANDR || "wlr-randr",
      args,
      {
        encoding: "utf8",
        timeout: WLR_TIMEOUT_MS,
        env: {
          NODE_ENV: process.env.NODE_ENV,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          XDG_RUNTIME_DIR: display.runtimeDir,
          WAYLAND_DISPLAY: display.display,
        },
      },
      (err: (Error & { killed?: boolean; signal?: string | null }) | null, stdout: string, stderr: string) => {
        if (err) reject(new WlrRandrError((stderr || err.message).trim().slice(0, 300), err.killed === true || !!err.signal));
        else resolve(stdout);
      },
    );
  });
}

interface Compositor {
  display: WaylandDisplay;
  outputs: MonitorOutput[];
  /** The session compositor's pid (`monitorModeSession`). */
  session: number;
}

/** The first display of the monitor-mode session whose compositor answers `wlr-randr`, and its outputs. */
async function askCompositor(): Promise<Compositor | null> {
  if (!kioskConfigured()) return null;
  for (const display of findWaylandDisplays()) {
    // Only the ClawBox Desktop session is monitor mode's: the cage kiosk
    // answers wlr-randr too, and its full-screen browser must be left alone.
    const session = monitorModeSession(display.runtimeDir);
    if (session === null) continue;
    try {
      const outputs = parseWlrRandr(await wlrRandr(display, []));
      if (outputs.length > 0) return { display, outputs, session };
    } catch {
      // A socket left behind by a compositor that is gone: not ours.
    }
  }
  return null;
}

/**
 * A FRESH read of the compositor — what the reconciler, Apply, Keep and Revert
 * judge by, always — recorded for `readCompositorShared` to hand to a GET.
 * The look taken right after a change put on screen is `askCompositor()`
 * instead, recorded nowhere (see `readCompositorShared`).
 */
async function readCompositor(): Promise<Compositor | null> {
  const s = state();
  const generation = s.readGeneration ?? 0;
  // On the monotonic clock, like the GET that judges it: see `readCompositorShared`.
  const at = performance.now();
  const promise = askCompositor();
  s.reading = { at, generation, promise };
  try {
    const result = await promise;
    // Only a read begun since the last change put on screen: one that was on
    // its way across a change may show the screen from before it.
    if ((s.readGeneration ?? 0) === generation) s.lastRead = { at, generation, result };
    return result;
  } finally {
    if (s.reading?.promise === promise) s.reading = null;
  }
}

/**
 * The compositor as the desktop's GET answers it: a read begun within the
 * last `STATUS_READ_REUSE_MS` (the reconciler's, which looks every 3 s, or
 * another GET's), the one on its way, or a fresh one.
 *
 * Every GET used to run wlr-randr of its own — a process spawned from the web
 * server and a round trip that wakes the compositor to list every output and
 * mode — every 5 s from the desktop and again from the Settings tab, on top
 * of the reconciler's own look every 3 s: one spawn every two seconds from an
 * idle desktop, mostly for an answer the reconciler had just had.
 *
 * What a GET answers is never from before a change ClawBox put on screen:
 * Apply, Revert and the reconciler's own re-apply all go through
 * `putOnScreen`, which forgets every read (`forgetReads`) before wlr-randr is
 * asked and again once it has answered, so the first GET after a change reads
 * the compositor afresh, exactly as every GET used to (their own
 * after-the-change reads are deliberately not offered: what a GET is handed
 * is a look at a screen nobody was changing). A change the box did NOT make —
 * a monitor plugged in — reaches the GET at most `STATUS_READ_REUSE_MS` later
 * than it did; the reconciler, which still reads fresh every time, puts the
 * layout on screen for it within its own 3 s and that write forgets the older
 * read.
 * The rest of the status (the main monitor, the trial, the refused variable
 * refresh) is built fresh from the saved file and this process's state on
 * every call — only the compositor's answer is shared.
 */
async function readCompositorShared(): Promise<Compositor | null> {
  const s = state();
  const generation = s.readGeneration ?? 0;
  // Monotonic, never the wall clock, which NTP steps. Stepped back, `now - at`
  // stayed under the window for as long as the step: no GET read for itself
  // in that time, each was handed whatever look was newest, and only the
  // reconciler's own look every 3 s kept that from going stale.
  const now = performance.now();
  const last = s.lastRead;
  if (last && last.generation === generation && now - last.at < STATUS_READ_REUSE_MS) return last.result;
  const reading = s.reading;
  if (reading && reading.generation === generation && now - reading.at < STATUS_READ_REUSE_MS) return reading.promise;
  return readCompositor();
}

/** A change is going on screen (or has just landed): no read from before it answers a GET. */
function forgetReads(): void {
  const s = state();
  s.readGeneration = (s.readGeneration ?? 0) + 1;
  s.lastRead = null;
  s.reading = null;
}

// ── The saved layout ────────────────────────────────────────────────────────

function readSaved(): SavedFile {
  try {
    const raw = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ MONITORS_FILE, "utf8")) as Partial<SavedFile>;
    const applied = raw.applied && typeof raw.applied === "object" ? raw.applied : null;
    return { version: 1, layout: parseSavedLayout(raw.layout), applied };
  } catch {
    return { version: 1, layout: null, applied: null };
  }
}

function writeSaved(next: SavedFile): void {
  fs.mkdirSync(/* turbopackIgnore: true */ DATA_DIR, { recursive: true });
  const tmp = `${MONITORS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(/* turbopackIgnore: true */ tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(/* turbopackIgnore: true */ tmp, /* turbopackIgnore: true */ MONITORS_FILE);
}

// ── The desktop window ──────────────────────────────────────────────────────

interface CdpTarget { id?: unknown; type?: unknown; url?: unknown; webSocketDebuggerUrl?: unknown }

interface CdpSession {
  send: (method: string, params?: object) => Promise<Record<string, unknown>>;
  close: () => void;
}

/** What is left of a DevTools call's ceiling, within the whole resize's. */
const cdpWait = (deadline: number) => Math.max(0, Math.min(CDP_TIMEOUT_MS, deadline - Date.now()));

/**
 * A DevTools session in which nothing waits for ever. A page behind a JS
 * dialog (the desktop's own `window.confirm`) answers no command until the
 * dialog closes, so a call that goes unanswered past its ceiling ENDS the
 * session — and so do the socket closing or failing — and every call still
 * waiting fails with it.
 */
function cdpSession(wsUrl: string, deadline: number): Promise<CdpSession> {
  return new Promise<CdpSession>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map<number, { ok: (v: Record<string, unknown>) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let next = 1;
    let over = false;
    const end = (why: Error) => {
      if (over) return;
      over = true;
      clearTimeout(opening);
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.fail(why);
      }
      pending.clear();
      reject(why);
      try {
        ws.close();
      } catch {
        // Already closing.
      }
    };
    const opening = setTimeout(() => end(new Error("timeout")), cdpWait(deadline));
    ws.onerror = () => end(new Error("socket error"));
    ws.onclose = () => end(new Error("socket closed"));
    ws.onmessage = (m) => {
      let msg: { id?: unknown; result?: Record<string, unknown>; error?: { message: string } };
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return;
      }
      const p = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
      if (!p) return;
      pending.delete(msg.id as number);
      clearTimeout(p.timer);
      if (msg.error) p.fail(new Error(msg.error.message));
      else p.ok(msg.result ?? {});
    };
    ws.onopen = () => {
      if (over) return;
      clearTimeout(opening);
      resolve({
        send: (method, params = {}) =>
          new Promise((ok, fail) => {
            if (over) {
              fail(new Error("socket closed"));
              return;
            }
            const id = next++;
            const timer = setTimeout(() => end(new Error(`${method}: no answer`)), cdpWait(deadline));
            pending.set(id, { ok, fail, timer });
            try {
              ws.send(JSON.stringify({ id, method, params }));
            } catch (err) {
              end(err instanceof Error ? err : new Error(String(err)));
            }
          }),
        close: () => end(new Error("closed")),
      });
    };
  });
}

/** The page's display mode, as the first of these it matches ('' for none). */
const DISPLAY_MODE_EXPRESSION =
  "['fullscreen', 'standalone', 'minimal-ui', 'browser'].find((m) => matchMedia('(display-mode: ' + m + ')').matches) || ''";

/**
 * Is the page with this display mode the desktop's app window? An `--app`
 * window is `standalone`, and is remembered by its DevTools target. In full
 * screen (F11, an element made full screen) it reports `fullscreen` — and so
 * does an ORDINARY window in full screen, which is the owner's and must not be
 * pulled out of it — so a full-screen page counts only when its target was seen
 * as the app window before. `browser` (a normal window or tab) never does.
 */
function isDesktopWindow(mode: unknown, target: string): boolean {
  const known = (state().desktopTargets ??= []);
  if (mode === "standalone") {
    if (!known.includes(target)) {
      known.push(target);
      if (known.length > KNOWN_DESKTOP_TARGETS) known.shift();
    }
    return true;
  }
  return mode === "fullscreen" && known.includes(target);
}

/**
 * Lay the desktop's app window over the whole row of monitors. The window sits
 * at the layout's origin (the session's window rule puts it there and holds
 * it); only its size follows the layout. Answers whether a desktop window was
 * found; never throws, and never takes longer than `SPAN_BUDGET_MS`.
 */
export async function spanDesktopWindow(box: { width: number; height: number }): Promise<boolean> {
  if (box.width <= 0 || box.height <= 0) return false;
  const deadline = Date.now() + SPAN_BUDGET_MS;
  let kioskUrl: string;
  try {
    kioskUrl = readKioskUrl();
  } catch {
    return false;
  }
  let targets: unknown;
  try {
    const res = await fetch(`http://127.0.0.1:${kioskCdpPort()}/json/list`, { signal: AbortSignal.timeout(CDP_TIMEOUT_MS) });
    targets = await res.json();
  } catch {
    return false;
  }
  if (!Array.isArray(targets)) return false;
  for (const t of targets as CdpTarget[]) {
    if (Date.now() >= deadline) break;
    if (!t || t.type !== "page" || typeof t.webSocketDebuggerUrl !== "string" || typeof t.url !== "string") continue;
    // The desktop shell's own pages only (the app window may be on /login): a
    // page the desktop opened lives in a window of its own.
    if (!isDesktopUrl(t.url, kioskUrl)) continue;
    const target = typeof t.id === "string" && t.id ? t.id : t.webSocketDebuggerUrl;
    let s: CdpSession | null = null;
    try {
      s = await cdpSession(t.webSocketDebuggerUrl, deadline);
      const mode = (await s.send("Runtime.evaluate", { expression: DISPLAY_MODE_EXPRESSION, returnByValue: true })) as {
        result?: { value?: unknown };
      };
      if (!isDesktopWindow(mode.result?.value, target)) continue;
      const { windowId, bounds } = (await s.send("Browser.getWindowForTarget")) as {
        windowId: number;
        bounds: { width?: number; height?: number; windowState?: string };
      };
      if (bounds.windowState !== "normal") {
        await s.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      }
      if (bounds.windowState !== "normal" || bounds.width !== box.width || bounds.height !== box.height) {
        await s.send("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0, width: box.width, height: box.height } });
      }
      return true;
    } catch {
      // A target that went away under us, or a page that does not answer
      // (a dialog open on it): try the next; the session's watcher tries again.
    } finally {
      s?.close();
    }
  }
  return false;
}

// ── Reading and applying ────────────────────────────────────────────────────

function toView(o: MonitorOutput): MonitorView {
  const size = o.enabled && o.current ? logicalSize(o.current.width, o.current.height, o.scale, o.transform) : null;
  return {
    id: o.id,
    name: o.name,
    label: [o.make, o.model].filter((s) => s && s !== "Unknown").join(" ") || o.description || o.name,
    builtIn: o.builtIn,
    enabled: o.enabled,
    modes: distinctModes(o.modes),
    current: o.current,
    scale: o.scale,
    transform: o.transform,
    rect: size && o.position ? { x: o.position.x, y: o.position.y, ...size } : null,
    physicalSize: o.physicalSize,
    adaptiveSync: state().noAdaptiveSync?.has(o.id) ? null : o.adaptiveSync ?? null,
  };
}

const UNAVAILABLE: MonitorStatus = { available: false, monitors: [], order: [], main: null, box: null, pending: null, mirror: false };

function statusFrom(outputs: MonitorOutput[]): MonitorStatus {
  const monitors = outputs.map(toView);
  const saved = readSaved();
  const on = monitors.filter((m) => m.enabled && m.rect);
  const order = [
    ...on.sort((a, b) => a.rect!.x - b.rect!.x).map((m) => m.id),
    ...monitors.filter((m) => !m.enabled).map((m) => m.id),
  ];
  const savedMain = saved.applied?.main ?? saved.layout?.main ?? null;
  const main = on.find((m) => m.id === savedMain)?.id ?? on.find((m) => !m.builtIn)?.id ?? on[0]?.id ?? null;
  const box = on.length
    ? {
        width: Math.max(...on.map((m) => m.rect!.x + m.rect!.width)) - Math.min(...on.map((m) => m.rect!.x)),
        height: Math.max(...on.map((m) => m.rect!.y + m.rect!.height)) - Math.min(...on.map((m) => m.rect!.y)),
      }
    : null;
  const p = state().pending;
  return { available: true, monitors, order, main, box, pending: p ? { deadline: p.deadline } : null, mirror: isMirrored(outputs) };
}

/**
 * What another ClawBox user's desktop gets (TASK-1256): only what it lays its
 * shelf and windows out with — which monitor is where and which is the main
 * one. No modes, no physical sizes, no trial.
 */
export function desktopViewOf(status: MonitorStatus): MonitorStatus {
  return {
    available: status.available,
    monitors: status.monitors.map((m) => ({
      id: m.id,
      name: m.name,
      label: m.label,
      builtIn: m.builtIn,
      enabled: m.enabled,
      modes: [],
      current: null,
      scale: m.scale,
      transform: m.transform,
      rect: m.rect,
      physicalSize: null,
      adaptiveSync: null,
    })),
    order: status.order,
    main: status.main,
    box: status.box,
    pending: null,
    mirror: status.mirror,
  };
}

/** The monitors connected now, as the compositor reports them; null without a monitor session. */
export async function readMonitorOutputs(): Promise<MonitorOutput[] | null> {
  return (await readCompositor())?.outputs ?? null;
}

export async function getMonitorStatus(): Promise<MonitorStatus> {
  const c = await readCompositorShared();
  return c ? statusFrom(c.outputs) : UNAVAILABLE;
}

/**
 * Put `plan` on screen. Answers the monitors whose variable refresh had to be
 * left out; throws only when wlr-randr did — a `WlrRandrError` saying whether
 * the compositor may have taken the layout all the same.
 */
async function putOnScreen(display: WaylandDisplay, plan: MonitorPlan): Promise<string[]> {
  let refused: string[] = [];
  const full = wlrRandrArgs(plan);
  // Forgotten on both sides of the write: a GET that read while wlr-randr was
  // still changing the screen must not hand that read to the next one.
  forgetReads();
  try {
    try {
      await wlrRandr(display, full);
    } catch (err) {
      const first = err instanceof WlrRandrError ? err : new WlrRandrError(errText(err), false);
      // A monitor (or compositor) that refuses variable refresh refuses the
      // whole configuration: once more without it, so the layout itself lands.
      const plain = wlrRandrArgs(plan, false);
      if (plain.length === full.length) throw first;
      try {
        await wlrRandr(display, plain);
      } catch (again) {
        throw new WlrRandrError(errText(again), first.timedOut || (again instanceof WlrRandrError && again.timedOut));
      }
      refused = plan.outputs.filter((o) => o.enabled && o.adaptiveSync === true).map((o) => o.id);
      const s = state();
      s.noAdaptiveSync ??= new Set();
      for (const id of refused) s.noAdaptiveSync.add(id);
    }
  } finally {
    forgetReads();
  }
  // What is on screen now, for the session's shelf margin. The layout is up
  // whether or not this lands: a full disk costs the margin, not the layout.
  try {
    const saved = readSaved();
    const mainOutput = plan.outputs.find((o) => o.id === plan.main)?.name ?? null;
    writeSaved({ ...saved, applied: { main: plan.main, mainOutput, box: plan.box, ...(plan.mirror ? { mirror: true } : {}) } });
  } catch (err) {
    console.warn("[monitors] Could not record the layout on screen:", errText(err));
  }
  await spanDesktopWindow(plan.box);
  return refused;
}

/** Does the screen already show `plan` (each output on or off, in its mode, place, scale and rotation)? */
function showsPlan(outputs: MonitorOutput[], plan: MonitorPlan): boolean {
  return plan.outputs.every((p) => {
    const o = outputs.find((x) => x.name === p.name);
    if (!o || o.enabled !== p.enabled) return false;
    if (!p.enabled) return true;
    return (
      !!o.current && !!o.position &&
      o.current.width === p.width && o.current.height === p.height && Math.abs(o.current.refresh - p.refresh) < 0.01 &&
      o.position.x === p.x && o.position.y === p.y &&
      Math.abs(o.scale - p.scale) < 0.001 && o.transform === p.transform
    );
  });
}

/**
 * The state of the session as the reconciler judges it: the compositor (its
 * pid and socket), the lid, and every output with what it shows now. A monitor
 * unplugged and plugged back between two looks comes back at the compositor's
 * own idea of it (preferred mode, scale 1, the right end of the row); the set
 * of ids alone would not have changed, the state does. Variable refresh is
 * left out: a compositor may switch it by itself (labwc does, for a full-screen
 * window, when set to), and that is no reason to put the layout back.
 */
function signatureOf(c: Compositor, lid: boolean): string {
  const outputs = [...c.outputs]
    .sort((a, b) => a.id.localeCompare(b.id) || a.name.localeCompare(b.name))
    .map((o) =>
      [
        o.id, o.name, o.enabled ? "on" : "off",
        o.current ? `${o.current.width}x${o.current.height}@${o.current.refresh}` : "-",
        o.position ? `${o.position.x},${o.position.y}` : "-",
        o.scale, o.transform,
      ].join(":"),
    );
  return [c.session, c.display.display, lid ? "lid-closed" : "lid-open", ...outputs].join("|");
}

const LID_DIR = "/proc/acpi/button/lid";

/**
 * Is the device's lid shut? Read from ACPI (`state:      closed`); a box with
 * no lid — every ClawBox — answers false, and so does one whose lid cannot be
 * read.
 */
export function lidClosed(dir: string = process.env.CLAWBOX_MONITORS_LID_DIR || LID_DIR): boolean {
  try {
    for (const entry of fs.readdirSync(/* turbopackIgnore: true */ dir)) {
      const text = fs.readFileSync(/* turbopackIgnore: true */ path.join(dir, entry, "state"), "utf8");
      if (/\bclosed\b/.test(text)) return true;
    }
  } catch {
    // No lid.
  }
  return false;
}

/** One layout change at a time: an apply racing the reconciler would interleave two wlr-randr runs. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const s = state();
  const run = (s.busy ?? Promise.resolve()).catch(() => undefined).then(fn);
  s.busy = run;
  return run;
}

export class MonitorError extends Error {
  constructor(
    public readonly code: "unavailable" | "apply_failed" | "apply_uncertain" | "nothing_pending" | "save_failed" | "revert_failed",
    message: string,
  ) {
    super(message);
  }
}

/**
 * (Re)start a trial's clock. When it runs out THIS trial is undone — a trial
 * that was replaced, kept or undone meanwhile is not the one pending any more,
 * and its timer then does nothing.
 */
function armTrial(trial: Trial, after: number): void {
  clearTimeout(trial.timer);
  trial.deadline = Date.now() + after;
  trial.timer = setTimeout(() => {
    void undoTrial(trial).catch((err) => console.warn("[monitors] Could not undo the layout on trial:", errText(err)));
  }, after);
  trial.timer.unref?.();
}

/**
 * A shut lid turns the built-in panel off for as long as it stays shut (the
 * reconciler's doing, not the owner's), and the Settings tab sends every
 * monitor as it is now — so "off" for that panel is the lid speaking. It is
 * not taken as a choice: the panel keeps what the owner last saved for it (on,
 * when nothing was), and stays dark only while the lid is shut.
 */
function lidIsNotAChoice(next: MonitorLayout, saved: MonitorLayout | null, outputs: MonitorOutput[]): void {
  if (!outputs.some((o) => !o.builtIn)) return;
  for (const o of outputs) {
    const want = next.monitors[o.id];
    if (!o.builtIn || !want || want.enabled) continue;
    next.monitors[o.id] = { ...want, enabled: saved?.monitors[o.id]?.enabled ?? true };
  }
}

/**
 * Put `layout` on screen ON TRIAL: it is undone after `REVERT_AFTER_MS` unless
 * `keepMonitorLayout()` is called. Monitors the layout does not name keep their
 * saved (or current) settings.
 */
export function applyMonitorLayout(layout: MonitorLayout): Promise<MonitorStatus> {
  return serialized(async () => {
    const c = await readCompositor();
    if (!c) throw new MonitorError("unavailable", "No monitor session is running");
    const s = state();
    const saved = readSaved();
    const before = s.pending;
    // What is on screen now is what Revert goes back to — taken before a
    // trial that is replaced by another, so two Applies in a row still undo
    // to the layout the owner last KEPT.
    const previous = before?.previous ?? layoutFromOutputs(c.outputs, saved.applied?.main ?? saved.layout?.main ?? null);
    const next = mergeLayouts(saved.layout ?? previous, layout);
    const lid = lidClosed();
    if (lid) lidIsNotAChoice(next, saved.layout, c.outputs);
    const plan = planLayout(c.outputs, next, { lidClosed: lid });
    if (!plan) throw new MonitorError("apply_failed", "No monitor can be turned on");
    // On trial BEFORE anything reaches the screen, so nothing that goes wrong
    // after wlr-randr leaves a layout up with no way back.
    const trial: Trial = { previous, next, deadline: 0, timer: undefined, failedReverts: 0 };
    armTrial(trial, REVERT_AFTER_MS);
    s.pending = trial;
    let refused: string[];
    try {
      refused = await putOnScreen(c.display, plan);
    } catch (err) {
      if (err instanceof WlrRandrError && !err.timedOut) {
        // Refused: the screen is as it was. A trial already running runs on,
        // to its own deadline (its timer was never stopped).
        clearTimeout(trial.timer);
        s.pending = before;
      } else if (before) {
        // wlr-randr was killed mid-call and the compositor may have taken the
        // layout: it stays on trial, and comes undone on its own.
        clearTimeout(before.timer);
      }
      if (err instanceof WlrRandrError && err.timedOut) {
        // It may well be on screen: the panel is told so, and re-reads.
        throw new MonitorError("apply_uncertain", errText(err));
      }
      throw new MonitorError("apply_failed", errText(err));
    }
    if (before) clearTimeout(before.timer);
    // The clock started before wlr-randr as a safety net; the owner's 20 s
    // start now, when there is something on screen to look at.
    armTrial(trial, REVERT_AFTER_MS);
    // What did not take is not what Keep saves.
    for (const id of refused) {
      if (next.monitors[id]) next.monitors[id] = { ...next.monitors[id], adaptiveSync: false };
    }
    const after = await askCompositor();
    const status = after ? statusFrom(after.outputs) : UNAVAILABLE;
    return refused.length ? { ...status, refusedAdaptiveSync: refused } : status;
  });
}

/** Keep the layout on trial: it is saved and comes back at every session start and replug. */
export function keepMonitorLayout(): Promise<MonitorStatus> {
  return serialized(async () => {
    const s = state();
    const trial = s.pending;
    if (!trial) throw new MonitorError("nothing_pending", "There is no change waiting to be kept");
    try {
      writeSaved({ ...readSaved(), layout: trial.next });
    } catch (err) {
      // Still on trial: its timer puts the previous layout back unless a
      // later Keep lands. The disk's own words stay in the log.
      console.warn("[monitors] Could not save the monitor layout:", errText(err));
      throw new MonitorError("save_failed", "The monitor settings could not be saved");
    }
    clearTimeout(trial.timer);
    s.pending = null;
    // Nothing on screen changes, but a Keep is a layout change all the same:
    // the read below, not one from before it, is what the next GET is given.
    forgetReads();
    const c = await readCompositor();
    if (!c) return UNAVAILABLE;
    // The screen already shows the saved layout: nothing for the reconciler
    // to put back (a second modeset would only blank the monitors).
    const lid = lidClosed();
    const plan = planLayout(c.outputs, trial.next, { lidClosed: lid });
    if (plan && showsPlan(c.outputs, plan)) s.signature = signatureOf(c, lid);
    return statusFrom(c.outputs);
  });
}

/**
 * Undo a trial: `only` when its own timer ran out (and nothing if that trial
 * is no longer the one pending), else whichever is pending. The trial is
 * dropped only once the previous layout is back; until then it stays pending
 * and is tried again after `REVERT_RETRY_MS`.
 */
function undoTrial(only: Trial | null): Promise<MonitorStatus | null> {
  return serialized(async () => {
    const s = state();
    const trial = s.pending;
    if (only && trial !== only) return null;
    if (!trial) throw new MonitorError("nothing_pending", "There is no change waiting to be undone");
    clearTimeout(trial.timer);
    const c = await readCompositor();
    if (!c) {
      // The session is gone; the next one starts from the saved layout.
      s.pending = null;
      s.signature = null;
      return UNAVAILABLE;
    }
    const plan = planLayout(c.outputs, trial.previous, { lidClosed: lidClosed() });
    if (plan) {
      try {
        await putOnScreen(c.display, plan);
      } catch (err) {
        if (s.pending === trial) {
          trial.failedReverts += 1;
          if (trial.failedReverts >= MAX_REVERT_ATTEMPTS) {
            // Given up on: the reconciler puts the saved layout back.
            console.warn("[monitors] Gave up undoing the layout on trial; the saved layout comes back");
            s.pending = null;
            s.signature = null;
          } else {
            armTrial(trial, REVERT_RETRY_MS);
          }
        }
        throw new MonitorError("revert_failed", errText(err));
      }
    }
    s.pending = null;
    const after = await askCompositor();
    return after ? statusFrom(after.outputs) : UNAVAILABLE;
  });
}

/** Undo the layout on trial now (also what its timer does). */
export async function revertMonitorLayout(): Promise<MonitorStatus> {
  return (await undoTrial(null)) ?? UNAVAILABLE;
}

/**
 * The saved layout put back whenever the session changes — a monitor plugged
 * in or unplugged (even one that came back between two looks), the session
 * restarted, the lid shut or opened — and the desktop window spread over the
 * result. A monitor never seen before is turned on at its preferred mode at
 * the right end of the row; a built-in panel behind a shut lid stays off while
 * another monitor is there.
 */
export function reconcileMonitors(): Promise<boolean> {
  return serialized(async () => {
    const c = await readCompositor();
    const s = state();
    if (!c) {
      s.signature = null;
      return false;
    }
    const lid = lidClosed();
    if (signatureOf(c, lid) === s.signature || s.pending) return false;
    const plan = planLayout(c.outputs, readSaved().layout, { lidClosed: lid });
    if (!plan) return false;
    try {
      await putOnScreen(c.display, plan);
    } catch (err) {
      console.warn("[monitors] Could not apply the saved layout:", errText(err));
      return false;
    }
    // Judged by what the screen shows AFTER: the next look finds the same.
    const after = await askCompositor();
    s.signature = after ? signatureOf(after, lid) : null;
    return true;
  });
}

/**
 * Started at boot on a box with a kiosk; a box without one starts nothing. A
 * tick that finds the previous one still running (a compositor slow to answer)
 * is skipped rather than queued behind it.
 */
export function startMonitorReconciler(): void {
  if (!kioskConfigured()) return;
  const s = state();
  if (s.reconciler) return;
  let running = false;
  s.reconciler = setInterval(() => {
    if (running) return;
    running = true;
    void reconcileMonitors()
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  }, RECONCILE_INTERVAL_MS);
  s.reconciler.unref?.();
}

/** For the suites. */
export function _resetMonitorsForTests(): void {
  const s = state();
  if (s.pending) clearTimeout(s.pending.timer);
  if (s.reconciler) clearInterval(s.reconciler);
  s.pending = null;
  s.signature = null;
  s.reconciler = null;
  s.busy = null;
  s.desktopTargets = [];
  s.readGeneration = 0;
  s.lastRead = null;
  s.reading = null;
}
