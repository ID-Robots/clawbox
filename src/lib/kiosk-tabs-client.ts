"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The desktop's side of the kiosk tab API (/setup-api/kiosk/tabs; see
 * src/lib/kiosk-tabs.ts for what a kiosk is and why the desktop lists its
 * tabs).
 *
 * Two things live here on purpose, in ONE module: the poll that knows whether
 * this box has a kiosk at all, and `openInKiosk`, which every "open an
 * external page" click goes through. The second reads the first's answer
 * SYNCHRONOUSLY — a click handler that awaited a probe before calling
 * `window.open` would be the popup blocker's business on a browser that is
 * not the kiosk, and on every Jetson, every phone and every laptop reaching
 * the box over the LAN the answer is "no kiosk" and the behaviour has to stay
 * exactly the old `window.open`.
 */

export interface KioskTabView {
  id: string;
  title: string;
  url: string;
  favicon: string;
  isDesktop: boolean;
}

export const KIOSK_TABS_URL = "/setup-api/kiosk/tabs";
/** How often the taskbar re-reads the tab list while a kiosk is answering. */
export const KIOSK_POLL_MS = 2_000;
/**
 * How often a box that answered "no kiosk" is asked again. Not never: the
 * kiosk Chrome is restarted by its launcher loop after a crash, and the port
 * is dark for those seconds. Slow, because on a box that has no kiosk this is
 * the only cost the feature has.
 */
export const KIOSK_RECHECK_MS = 30_000;

// Module state, so a click handler anywhere on the desktop can read the last
// answer without a provider: null until the first poll answers.
let lastAvailable: boolean | null = null;

/** What the last poll said. `null` before anything has answered. */
export function kioskAvailable(): boolean | null {
  return lastAvailable;
}

/** Tests only: forget what the last poll said. */
export function resetKioskAvailability(): void {
  lastAvailable = null;
}

function parseTabs(data: unknown): { available: boolean; tabs: KioskTabView[] } {
  if (typeof data !== "object" || data === null) return { available: false, tabs: [] };
  const d = data as { available?: unknown; tabs?: unknown };
  if (d.available !== true || !Array.isArray(d.tabs)) return { available: false, tabs: [] };
  const tabs: KioskTabView[] = [];
  for (const t of d.tabs as Record<string, unknown>[]) {
    if (typeof t?.id !== "string" || typeof t.url !== "string") continue;
    tabs.push({
      id: t.id,
      title: typeof t.title === "string" ? t.title : "",
      url: t.url,
      favicon: typeof t.favicon === "string" ? t.favicon : "",
      isDesktop: t.isDesktop === true,
    });
  }
  return { available: true, tabs };
}

/** One read of the tab list. Never throws; a failure is "no kiosk". */
export async function fetchKioskTabs(): Promise<{ available: boolean; tabs: KioskTabView[] }> {
  try {
    const res = await fetch(KIOSK_TABS_URL, { cache: "no-store" });
    const parsed = res.ok ? parseTabs(await res.json()) : { available: false, tabs: [] };
    lastAvailable = parsed.available;
    return parsed;
  } catch {
    lastAvailable = false;
    return { available: false, tabs: [] };
  }
}

type KioskCommand =
  | { action: "open"; url: string }
  | { action: "activate"; id: string }
  | { action: "close"; id: string }
  | { action: "home" };

/** One command to the kiosk. True when Chrome did it. */
export async function kioskCommand(body: KioskCommand): Promise<boolean> {
  try {
    const res = await fetch(KIOSK_TABS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 503) lastAvailable = false;
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Open `url` the way this browser opens an external page.
 *
 * On the kiosk (the last poll said so) the page is opened THROUGH the kiosk
 * API, so it is a tab the taskbar knows the moment it exists rather than two
 * seconds later, and the `--kiosk` Chrome shows it at once. If that fails —
 * the port went dark between the poll and the click — the old `window.open`
 * runs, which in the kiosk is still a new tab.
 *
 * Everywhere else this IS `window.open(url, "_blank", features)`, called in the
 * same tick as the click: no await stands between the user's gesture and the
 * popup, so nothing a browser allowed before is blocked now.
 *
 * A relative `url` (`/app/vnc`) is resolved against this page's origin for the
 * kiosk API, which opens absolute URLs only; `window.open` resolves it itself.
 */
export function openInKiosk(url: string, features = "noopener,noreferrer"): void {
  if (lastAvailable !== true) {
    window.open(url, "_blank", features);
    return;
  }
  let absolute: string;
  try {
    absolute = new URL(url, window.location.origin).href;
  } catch {
    window.open(url, "_blank", features);
    return;
  }
  void kioskCommand({ action: "open", url: absolute }).then((done) => {
    if (!done) window.open(url, "_blank", features);
  });
}

/**
 * The kiosk's tabs, polled while the kiosk answers. `available: false` (and an
 * empty list) on every other box, re-asked at the slow rate.
 *
 * `enabled: false` polls nothing at all — page.tsx passes the owner gate, since
 * another ClawBox user's browser must not send a request the server would 403.
 */
export function useKioskTabs(enabled: boolean): {
  available: boolean;
  tabs: KioskTabView[];
  activate: (id: string) => void;
  close: (id: string) => void;
  home: () => void;
} {
  const [state, setState] = useState<{ available: boolean; tabs: KioskTabView[] }>({ available: false, tabs: [] });
  // "Re-read soon", as the running poll loop defines it; a no-op while the
  // loop is not running.
  const refreshSoon = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void tick(), ms);
    };
    async function tick() {
      const next = await fetchKioskTabs();
      if (!live) return;
      setState((prev) => (sameTabs(prev, next) ? prev : next));
      schedule(next.available ? KIOSK_POLL_MS : KIOSK_RECHECK_MS);
    }
    // After a command the list is re-read at once rather than on the next
    // tick, so a closed tab leaves the taskbar with the click and not up to
    // two seconds later.
    refreshSoon.current = () => { if (live) schedule(150); };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      refreshSoon.current = () => {};
    };
  }, [enabled]);

  const activate = useCallback((id: string) => { void kioskCommand({ action: "activate", id }).then(() => refreshSoon.current()); }, []);
  const close = useCallback((id: string) => { void kioskCommand({ action: "close", id }).then(() => refreshSoon.current()); }, []);
  const home = useCallback(() => { void kioskCommand({ action: "home" }).then(() => refreshSoon.current()); }, []);

  return { available: state.available, tabs: state.tabs, activate, close, home };
}

function sameTabs(a: { available: boolean; tabs: KioskTabView[] }, b: { available: boolean; tabs: KioskTabView[] }): boolean {
  if (a.available !== b.available || a.tabs.length !== b.tabs.length) return false;
  return a.tabs.every((t, i) => {
    const o = b.tabs[i];
    return t.id === o.id && t.title === o.title && t.url === o.url && t.favicon === o.favicon && t.isDesktop === o.isDesktop;
  });
}
