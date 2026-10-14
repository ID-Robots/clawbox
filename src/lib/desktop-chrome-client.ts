"use client";

import { useEffect, useState } from "react";

/**
 * The desktop's side of /setup-api/desktop/chrome (src/lib/desktop-chrome.ts):
 * the Google Chrome icon, which opens the owner's own Chrome as a native window
 * on the ClawBox Desktop session's screen.
 *
 * Drawn only on that screen. The server says whether the session is up; the
 * page says whether it IS that screen — the session's desktop is loaded from
 * the box itself (`http://localhost/`), while a phone or a laptop on the LAN
 * reaches the box by its address, and an icon there would start a browser on a
 * screen across the room.
 *
 * On that screen the icon is drawn whether or not the box has a Chrome to
 * start. Without one a click is not a dead icon and not the kiosk's own
 * browser: it raises a toast that says Chrome is not installed and how to get
 * it (`onMissing`).
 */

export const DESKTOP_CHROME_APP_ID = "chrome";
export const DESKTOP_CHROME_URL = "/setup-api/desktop/chrome";
const FALLBACK_URL = "https://www.google.com/";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * What the desktop draws for Google Chrome: no icon (`hidden`), an icon that
 * opens it (`ready`), or an icon whose click says it is not installed
 * (`missing`).
 */
export type DesktopChromeState = "hidden" | "ready" | "missing";

/** Is this page loaded from the box itself (the session's own screen)? */
export function onBoxScreen(hostname: string = typeof window === "undefined" ? "" : window.location.hostname): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * The GET's answer as the icon's state. An answer without `installed` comes
 * from a server that only ever said `available` with a Chrome to start.
 */
export function desktopChromeState(body: unknown): DesktopChromeState {
  if (!body || typeof body !== "object") return "hidden";
  const { available, installed } = body as { available?: unknown; installed?: unknown };
  if (available !== true) return "hidden";
  return installed === false ? "missing" : "ready";
}

/** Whether, and how, the Google Chrome icon belongs on this desktop. Asked once, when `enabled`. */
export function useDesktopChrome(enabled: boolean): DesktopChromeState {
  const [state, setState] = useState<DesktopChromeState>("hidden");
  useEffect(() => {
    if (!enabled || !onBoxScreen()) return;
    let cancelled = false;
    fetch(DESKTOP_CHROME_URL, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: unknown) => {
        if (!cancelled) setState(desktopChromeState(d));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return state;
}

export interface OpenDesktopChromeOptions {
  /** The page to open; Google when absent. */
  url?: string;
  /** What the icon was drawn as. `missing` never falls back to the kiosk's browser. */
  state?: DesktopChromeState;
  /** Told instead of opening anything when the box has no Chrome to start. */
  onMissing?: () => void;
}

/**
 * Open Google Chrome on the screen.
 *
 * The server is asked on every click, also for an icon drawn as `missing`: a
 * Chrome installed since the page loaded opens on the next click, and one
 * removed since is reported. When the box has none, `onMissing` is called and
 * nothing is opened. When the server cannot open it for any other reason (the
 * session went away under the page), the page opens one the ordinary way, so
 * a click is never a dead icon.
 */
export async function openDesktopChrome({ url, state = "ready", onMissing }: OpenDesktopChromeOptions = {}): Promise<void> {
  try {
    const r = await fetch(DESKTOP_CHROME_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(url ? { url } : {}),
    });
    if (r.ok) return;
    const body: unknown = await r.json().catch(() => null);
    if (desktopChromeState(body) === "missing") {
      onMissing?.();
      return;
    }
  } catch {
    // fall through
  }
  if (state === "missing") {
    onMissing?.();
    return;
  }
  window.open(url || FALLBACK_URL, "_blank", "noopener");
}
