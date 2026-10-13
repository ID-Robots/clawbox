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
 */

export const DESKTOP_CHROME_APP_ID = "chrome";
export const DESKTOP_CHROME_URL = "/setup-api/desktop/chrome";
const FALLBACK_URL = "https://www.google.com/";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Is this page loaded from the box itself (the session's own screen)? */
export function onBoxScreen(hostname: string = typeof window === "undefined" ? "" : window.location.hostname): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** Whether the Google Chrome icon belongs on this desktop. Asked once, when `enabled`. */
export function useDesktopChrome(enabled: boolean): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!enabled || !onBoxScreen()) return;
    let cancelled = false;
    fetch(DESKTOP_CHROME_URL, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: unknown) => {
        if (!cancelled) setAvailable(!!d && typeof d === "object" && (d as { available?: unknown }).available === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return available;
}

/**
 * Open Google Chrome on the screen. When the server cannot (the session went
 * away under the page), the page opens one the ordinary way, so a click is
 * never a dead icon.
 */
export async function openDesktopChrome(url?: string): Promise<void> {
  try {
    const r = await fetch(DESKTOP_CHROME_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(url ? { url } : {}),
    });
    if (r.ok) return;
  } catch {
    // fall through
  }
  window.open(url || FALLBACK_URL, "_blank", "noopener");
}
