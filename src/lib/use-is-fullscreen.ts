"use client";

import { useSyncExternalStore } from "react";

/**
 * Is this page filling the screen with no browser chrome around it?
 *
 * Two facts, because neither covers the other. `document.fullscreenElement` is
 * the page's own request — the shelf's button — and is the only one of the two
 * that answers in an app window: measured on the monitor session's Chrome
 * (`--app`), a page in fullscreen still matches `display-mode: standalone` and
 * never `fullscreen`. `display-mode: fullscreen` is the browser's doing — F11,
 * or the cage kiosk's `--kiosk` — where no element is fullscreen at all.
 *
 * The second fact needs a second look, because Chromium answers it from the
 * WINDOW's state and not from what is drawn: a Mac's green-button fullscreen
 * keeps the tab strip and the address bar by default and still matches. So the
 * query counts only while the page is the whole window (`pageFillsWindow`).
 */
const FULLSCREEN_QUERY = "(display-mode: fullscreen)";

/** The query's list, or null where there is no `matchMedia` to ask. */
function fullscreenMedia(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  try {
    return window.matchMedia(FULLSCREEN_QUERY) ?? null;
  } catch {
    return null;
  }
}

/** How far the two axes' outer/inner ratios may differ and still be "equal". */
const FILL_TOLERANCE = 0.02;

/**
 * Is the page the whole window — no toolbar, tab strip or docked panel beside
 * it? Page zoom scales `inner*` and not `outer*`, so neither axis can be
 * compared with the window on its own; but zoom scales both axes ALIKE, and
 * browser chrome takes from one of them. An answer that cannot be worked out
 * is "no": the caller then offers fullscreen, which is the harmless mistake.
 */
function pageFillsWindow(): boolean {
  const { innerWidth, innerHeight, outerWidth, outerHeight } = window;
  if (!(innerWidth > 0 && innerHeight > 0 && outerWidth > 0 && outerHeight > 0)) return false;
  return Math.abs(outerWidth / innerWidth - outerHeight / innerHeight) <= FILL_TOLERANCE;
}

/** Read now, never cached: both facts change without a render. Never throws. */
export function isFullscreen(): boolean {
  if (typeof document === "undefined") return false;
  if (document.fullscreenElement) return true;
  return fullscreenMedia()?.matches === true && pageFillsWindow();
}

function subscribe(onChange: () => void): () => void {
  document.addEventListener("fullscreenchange", onChange);
  // A toolbar shown or hidden inside a fullscreen window changes no query:
  // only the page's size says so.
  window.addEventListener("resize", onChange);
  const media = fullscreenMedia();
  media?.addEventListener?.("change", onChange);
  return () => {
    document.removeEventListener("fullscreenchange", onChange);
    window.removeEventListener("resize", onChange);
    media?.removeEventListener?.("change", onChange);
  };
}

const serverSnapshot = () => false;

/** `isFullscreen()`, re-rendering the caller when either fact changes. */
export function useIsFullscreen(): boolean {
  return useSyncExternalStore(subscribe, isFullscreen, serverSnapshot);
}

/**
 * Can this browser be ASKED for fullscreen at all? An iPhone's Safari has no
 * element fullscreen: a button that offers it there does nothing.
 */
export function canRequestFullscreen(): boolean {
  return typeof document !== "undefined" && typeof document.documentElement?.requestFullscreen === "function";
}

// A browser does not grow the API while a page is open.
const neverChanges = () => () => {};
const serverCan = () => true;

/** `canRequestFullscreen()`, read after hydration (the server cannot know, and says yes). */
export function useCanRequestFullscreen(): boolean {
  return useSyncExternalStore(neverChanges, canRequestFullscreen, serverCan);
}
