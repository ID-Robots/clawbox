"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { kioskBarInset } from "./kiosk-bar-inset";
// Type-only: erased from the bundle, so the server module's fs never reaches
// the browser.
import type { KioskTab, KioskTabs } from "./kiosk-tabs";

/**
 * The desktop's side of the kiosk tab API (/setup-api/kiosk/tabs; see
 * src/lib/kiosk-tabs.ts for what a kiosk is and why the desktop lists its
 * tabs).
 *
 * Whether THIS page is the kiosk is answered by the page itself, never by the
 * server: the kiosk extension draws its bar on the desktop and says so on
 * `<html>` (`kioskBarInset() > 0`, src/lib/kiosk-bar-inset.ts). Every Jetson,
 * every phone and every browser reaching the laptop over the LAN has no bar,
 * so none of them polls the tab list or sends a command, and `openInKiosk` is
 * exactly the old `window.open` there — decided synchronously, in the click's
 * own tick, so no await stands between the gesture and the popup.
 */

export type KioskTabView = KioskTab;

const NO_KIOSK: KioskTabs = { available: false, tabs: [] };

/** Is this page the laptop's kiosk desktop (its extension's bar is on it)? */
export function inKiosk(): boolean {
  return kioskBarInset() > 0;
}

/**
 * Fired on `window` after `openInKiosk` opened a tab, so the taskbar re-reads
 * the list at once rather than on its next tick.
 */
export const KIOSK_TABS_CHANGED_EVENT = "clawbox:kiosk-tabs-changed";

export const KIOSK_TABS_URL = "/setup-api/kiosk/tabs";
/** How often the taskbar re-reads the tab list while a kiosk is answering. */
export const KIOSK_POLL_MS = 2_000;
/**
 * How often the kiosk's tab list is asked again while its Chrome does not
 * answer — restarted by its launcher loop after a crash, the port dark for
 * those seconds. Only ever on the kiosk itself (see `useKioskTabs`).
 */
export const KIOSK_RECHECK_MS = 30_000;

function parseTabs(data: unknown): KioskTabs {
  if (typeof data !== "object" || data === null) return NO_KIOSK;
  const d = data as { available?: unknown; tabs?: unknown };
  if (d.available !== true || !Array.isArray(d.tabs)) return NO_KIOSK;
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

/**
 * The desktop app that stands for the kiosk's pages on the shelf: `web`, the
 * same app as the desktop's Web icon (src/lib/desktop-apps.ts). One shelf
 * icon for every page the desktop opened, like any other app's; the pages
 * themselves are listed and switched in the kiosk bar across the top.
 */
export const KIOSK_PAGES_APP_ID = "web";

/**
 * The kiosk's own pages — every tab but the desktop's — in the order the
 * server hands them over, which is Chrome's `/json/list` order: most recently
 * used first. So `[0]` is the page the owner was last on.
 */
export function kioskPageTabs(tabs: KioskTabView[]): KioskTabView[] {
  return tabs.filter((t) => !t.isDesktop);
}

/** One read of the tab list. Never throws; a failure is "no kiosk". */
export async function fetchKioskTabs(): Promise<KioskTabs> {
  try {
    const res = await fetch(KIOSK_TABS_URL, { cache: "no-store" });
    return res.ok ? parseTabs(await res.json()) : NO_KIOSK;
  } catch {
    return NO_KIOSK;
  }
}

type KioskCommand =
  | { action: "open"; url: string }
  | { action: "activate"; id: string }
  | { action: "close"; id: string };

/** One command to the kiosk. True when Chrome did it. */
async function kioskCommand(body: KioskCommand): Promise<boolean> {
  try {
    const res = await fetch(KIOSK_TABS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Open `url` the way this browser opens an external page.
 *
 * On the kiosk the page is opened THROUGH the kiosk API, and the taskbar is
 * told at once (`KIOSK_TABS_CHANGED_EVENT`) rather than at its next tick. If
 * that fails — the kiosk Chrome's port went dark — the old `window.open`
 * runs, which in the kiosk is still a new tab (a localhost round trip is well
 * inside the click's activation window, so the popup is still allowed).
 *
 * Everywhere else this IS `window.open(url, "_blank", features)`, called in the
 * same tick as the click: nothing a browser allowed before is blocked now.
 *
 * A relative `url` (`/app/vnc`) is resolved against this page's origin for the
 * kiosk API, which opens absolute URLs only; `window.open` resolves it itself.
 */
export function openInKiosk(url: string, features = "noopener,noreferrer"): void {
  if (!inKiosk()) {
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
    if (done) window.dispatchEvent(new Event(KIOSK_TABS_CHANGED_EVENT));
    else window.open(url, "_blank", features);
  });
}

/**
 * The kiosk's tabs, polled while its Chrome answers (and re-asked at the slow
 * rate while it does not).
 *
 * `enabled: false` polls nothing at all. page.tsx passes the owner gate (another
 * ClawBox user's browser must not send a request the server would 403) AND
 * `inKiosk()`: on any page without the kiosk bar — every Jetson — this hook
 * sends nothing.
 */
export function useKioskTabs(enabled: boolean): {
  available: boolean;
  tabs: KioskTabView[];
  activate: (id: string) => void;
  close: (id: string) => void;
} {
  const [state, setState] = useState<KioskTabs>(NO_KIOSK);
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
    const onChanged = () => refreshSoon.current();
    refreshSoon.current = () => { if (live) schedule(150); };
    window.addEventListener(KIOSK_TABS_CHANGED_EVENT, onChanged);
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener(KIOSK_TABS_CHANGED_EVENT, onChanged);
      refreshSoon.current = () => {};
    };
  }, [enabled]);

  const activate = useCallback((id: string) => { void kioskCommand({ action: "activate", id }).then(() => refreshSoon.current()); }, []);
  const close = useCallback((id: string) => { void kioskCommand({ action: "close", id }).then(() => refreshSoon.current()); }, []);

  return { available: state.available, tabs: state.tabs, activate, close };
}

/**
 * Same as far as the desktop can tell: it draws the pages by id, in order, and
 * whether each is the desktop — never a title, URL or favicon (the kiosk bar
 * names them). So a page that changes its title ("(3) Inbox") or finishes
 * loading its favicon does not re-render the desktop.
 */
function sameTabs(a: KioskTabs, b: KioskTabs): boolean {
  if (a.available !== b.available || a.tabs.length !== b.tabs.length) return false;
  return a.tabs.every((t, i) => t.id === b.tabs[i].id && t.isDesktop === b.tabs[i].isDesktop);
}
