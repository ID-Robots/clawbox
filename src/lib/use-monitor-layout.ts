"use client";

import { useEffect, useState } from "react";
import { VIEWER_SCREENS_ATTR } from "./box-switcher";
import { MONITORS_CHANGED_EVENT, screensFromStatus, setDeskScreens, setMonitorSessionWindow, type MonitorStatusLike } from "./desktop-screens";

/** How often the desktop re-reads the monitors while a monitor session answers. */
export const MONITOR_POLL_MS = 5_000;
/** How soon after a resize or a layout change it reads them again. */
export const MONITOR_SOON_MS = 200;

/**
 * The last monitor-session answer this window got, kept for /updating
 * (sessionStorage: this window's own, and it survives the page changing under
 * it — the hand-over, the middleware's redirect, /updating's reload onto the
 * new build). /updating has to know the layout while the box serves nothing
 * for minutes in the middle of the rebuild, to draw the run on the main
 * monitor only.
 */
export const MONITOR_STATUS_KEY = "clawbox:monitor-status";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Keep `status` when it is a monitor session's answer; forget what was kept otherwise. */
export function rememberMonitorStatus(status: MonitorStatusLike | null): void {
  const store = storage();
  if (!store) return;
  try {
    if (status?.available) {
      const { available, main, box, monitors, mirror } = status;
      store.setItem(MONITOR_STATUS_KEY, JSON.stringify({ available, main, box, monitors, mirror }));
    } else {
      store.removeItem(MONITOR_STATUS_KEY);
    }
  } catch {
    // Storage full or switched off: /updating then waits for the box to answer.
  }
}

/** Is `kept` a monitor session's answer the desktop can lay itself out from? */
function isMonitorStatus(kept: MonitorStatusLike | null): kept is MonitorStatusLike {
  if (!kept || kept.available !== true || !Array.isArray(kept.monitors)) return false;
  if (typeof kept.box?.width !== "number" || typeof kept.box?.height !== "number") return false;
  return kept.monitors.every((m) => m && typeof m.id === "string" && (m.rect === null
    || (typeof m.rect?.x === "number" && typeof m.rect.y === "number" && typeof m.rect.width === "number" && typeof m.rect.height === "number")));
}

/** The answer `rememberMonitorStatus` kept, or null when there is none worth reading. */
export function recallMonitorStatus(): MonitorStatusLike | null {
  try {
    const raw = storage()?.getItem(MONITOR_STATUS_KEY);
    if (!raw) return null;
    const kept = JSON.parse(raw) as MonitorStatusLike | null;
    return isMonitorStatus(kept) ? kept : null;
  } catch {
    return null;
  }
}

const VIEWER_MAX_CHARS = 8_192;
const VIEWER_MAX_MONITORS = 16;
const VIEWER_MAX_PX = 100_000;
const VIEWER_ID = /^[\x21-\x7e]{1,64}$/;
const sized = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= VIEWER_MAX_PX;
const placed = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= VIEWER_MAX_PX;

/**
 * What the kiosk extension left in `VIEWER_SCREENS_ATTR` (the monitors of the
 * kiosk this page is shown on), read as strictly as `recallMonitorStatus` reads
 * what it kept — and more: the page cannot tell the extension from a script,
 * so every number is finite and bounded, every id a short printable string, and
 * the status is REBUILT from those values, nothing passed through.
 *
 * `undefined`: no mark, or one that is not valid — the page is laid out as it
 * always was. `null`: the kiosk says it has no monitor session — one screen,
 * and not this box's own monitors either. Otherwise the kiosk's monitors, ready
 * for `screensFromStatus`.
 */
export function parseViewerScreens(raw: string | null): MonitorStatusLike | null | undefined {
  if (raw === null || raw.length > VIEWER_MAX_CHARS) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const status = body as MonitorStatusLike;
  if (status.available === false) return null;
  if (!isMonitorStatus(status)) return undefined;
  const { box, main } = status;
  const monitors = status.monitors ?? [];
  if (!box || !sized(box.width) || !sized(box.height) || monitors.length < 1 || monitors.length > VIEWER_MAX_MONITORS) return undefined;
  if (main !== null && main !== undefined && !(typeof main === "string" && VIEWER_ID.test(main))) return undefined;
  const clean: NonNullable<MonitorStatusLike["monitors"]> = [];
  for (const m of monitors) {
    if (!VIEWER_ID.test(m.id)) return undefined;
    const r = m.rect;
    if (r !== null && !(placed(r.x) && placed(r.y) && sized(r.width) && sized(r.height))) return undefined;
    clean.push({
      id: m.id,
      label: m.id,
      enabled: m.enabled === true,
      rect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
      ...(m.builtIn === true ? { builtIn: true } : {}),
    });
  }
  return { available: true, main: main ?? null, box: { width: box.width, height: box.height }, monitors: clean, mirror: status.mirror === true };
}

/**
 * The monitors of the kiosk this page is SHOWN on, when the page is a linked
 * box's desktop in another box's kiosk and that kiosk's switch is on: the
 * extension keeps `VIEWER_SCREENS_ATTR` on <html>, and this follows it (a
 * layout change, a monitor plugged in, the switch turned off). `undefined` —
 * also while `enabled` is false — is every other page, laid out from its own
 * box's monitors as ever. The mark is the extension's, and a page script can
 * write it too — which moves only that page's own layout. Another frame cannot
 * reach this document's attributes.
 */
export function useViewerMonitors(enabled = true): MonitorStatusLike | null | undefined {
  // Read before the first effect: a page that already carries the mark never
  // starts a read of its own box's monitors only to drop it.
  const [seen, setSeen] = useState<{ raw: string | null; viewer: MonitorStatusLike | null | undefined }>(() => {
    const raw = enabled && typeof document !== "undefined" ? document.documentElement.getAttribute(VIEWER_SCREENS_ATTR) : null;
    return { raw, viewer: parseViewerScreens(raw) };
  });
  useEffect(() => {
    if (!enabled || typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const root = document.documentElement;
    const read = () => {
      const raw = root.getAttribute(VIEWER_SCREENS_ATTR);
      setSeen((prev) => (prev.raw === raw ? prev : { raw, viewer: parseViewerScreens(raw) }));
    };
    read();
    const watch = new MutationObserver(read);
    watch.observe(root, { attributes: true, attributeFilter: [VIEWER_SCREENS_ATTR] });
    return () => {
      watch.disconnect();
      setSeen({ raw: null, viewer: undefined });
    };
  }, [enabled]);
  return enabled ? seen.viewer : undefined;
}

/**
 * Keeps `desktop-screens` in step with the monitors the desktop window is
 * spread over (monitor mode, src/lib/monitors.ts).
 *
 * Only in the desktop's APP window — the one the monitor session lays over
 * every monitor, whose `display-mode` is never `browser`. A desktop opened in
 * a browser tab (a phone, a laptop on the LAN, every Jetson) asks nothing at
 * all. In the app window it asks once; a box with no monitor session answers
 * `available: false` and nothing more is asked until the window is resized.
 * With one, it re-reads every few seconds (a monitor plugged in reaches the
 * page within one tick), on every resize, and at once when the Settings tab
 * changed the layout.
 *
 * ONE read at a time: an event that arrives while a read is in flight asks
 * for another read once it is done, rather than starting a second timer — the
 * second timer used to be dropped by the next tick without being cleared, and
 * every such event left one more chain polling for the life of the page.
 *
 * And once a monitor session HAS answered, this page is its window: an
 * `available: false` (or a 5xx) after that is a read that failed — wlr-randr
 * timing out, a dock unplugged for a moment — not a box without monitors. The
 * layout the page has stands and it keeps asking; stopping there left the
 * page laid out as one screen across every monitor until something happened
 * to resize the window.
 *
 * The every-few-seconds read waits while the page is HIDDEN (a minimised app
 * window), the rule the chat's own polls keep (`installPendingRefresh`): a
 * tick that falls due then is read the moment the page is visible again, so
 * what the owner finds is at least as fresh as before, and a window nobody
 * can see stops spawning wlr-randr on the box. A resize or a layout change
 * from Settings is still read at once, hidden or not — those are events, not
 * the clock.
 *
 * The first `available: true` is also how the rest of the page learns it is
 * that session's window (`setMonitorSessionWindow`, read by
 * `isBoxOwnScreen()`): the box answering is the proof, where an app
 * `display-mode` alone would also take in the desktop installed as an app on
 * a phone and a tab in full screen.
 *
 * Every monitor-session answer is kept for the window (`rememberMonitorStatus`).
 * `recall` is /updating's: it starts from the answer the desktop kept, before
 * asking, because the box it would ask is down for minutes during the rebuild —
 * and that answer counts as the session having answered, so a read that fails
 * keeps the layout. A window that never kept one (a phone, a browser on the
 * LAN, a Jetson) starts exactly as before.
 *
 * A page that is another box's desktop SHOWN in a kiosk whose Linked ClawBoxes
 * monitors switch is on (TASK-2771) is laid out by the KIOSK's monitors, which
 * the extension keeps on <html> (`useViewerMonitors`): this box's own are the
 * wrong ones, so it does not read them at all. The kiosk having no layout is a
 * layout of one screen. Never on /updating (`recall`).
 */
export function useMonitorLayoutSync(enabled: boolean, { recall = false }: { recall?: boolean } = {}): void {
  const viewer = useViewerMonitors(enabled && !recall);
  const viewed = viewer !== undefined;
  useEffect(() => {
    // The kiosk's layout, from the first answer to the page's last: the same
    // `screensFromStatus` rule, so a window not laid over the kiosk's whole row
    // is one screen; it is read again on every resize.
    if (!viewed) return;
    return () => setDeskScreens(null);
  }, [viewed]);
  useEffect(() => {
    if (viewer === undefined) return;
    const apply = () => setDeskScreens(viewer ? screensFromStatus(viewer, window.innerWidth, window.innerHeight) : null);
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [viewer]);
  const own = enabled && !viewed;
  useEffect(() => {
    if (!own || typeof window === "undefined") return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: browser)")?.matches) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reading = false;
    let readAgain = false;
    let seen = false;
    const kept = recall ? recallMonitorStatus() : null;
    if (kept) {
      seen = true;
      setMonitorSessionWindow(true);
      setDeskScreens(screensFromStatus(kept, window.innerWidth, window.innerHeight));
    }
    /** A periodic read fell due while the page was hidden; it is read on the visible edge. */
    let missed = false;
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

    const read = async (): Promise<"on" | "off" | "error"> => {
      try {
        const res = await fetch("/setup-api/monitors", { cache: "no-store" });
        if (!res.ok) return seen && res.status >= 500 ? "error" : "off";
        const status = (await res.json()) as MonitorStatusLike;
        if (!live) return "off";
        if (!status.available) {
          if (seen) return "error";
          rememberMonitorStatus(null);
          setDeskScreens(null);
          return "off";
        }
        seen = true;
        rememberMonitorStatus(status);
        setMonitorSessionWindow(true);
        setDeskScreens(screensFromStatus(status, window.innerWidth, window.innerHeight));
        return "on";
      } catch {
        return "error";
      }
    };

    const schedule = (ms: number, periodic = false) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (periodic && hidden()) {
          missed = true;
          return;
        }
        void tick();
      }, ms);
    };

    const tick = async () => {
      if (reading) {
        readAgain = true;
        return;
      }
      reading = true;
      missed = false;
      const result = await read();
      reading = false;
      if (!live) return;
      // Something changed while that read was out: its answer may predate it.
      if (readAgain) {
        readAgain = false;
        schedule(MONITOR_SOON_MS);
        return;
      }
      if (result !== "off") schedule(MONITOR_POLL_MS, true);
    };

    const soon = () => {
      if (reading) readAgain = true;
      else schedule(MONITOR_SOON_MS);
    };

    // Only the visible EDGE, and only for a tick that fell due while away.
    const onVisibility = () => {
      if (!hidden() && missed) void tick();
    };

    void tick();
    window.addEventListener("resize", soon);
    window.addEventListener(MONITORS_CHANGED_EVENT, soon);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener("resize", soon);
      window.removeEventListener(MONITORS_CHANGED_EVENT, soon);
      document.removeEventListener("visibilitychange", onVisibility);
      setDeskScreens(null);
      setMonitorSessionWindow(false);
    };
  }, [own, recall]);
}
