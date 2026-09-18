"use client";

import { useSyncExternalStore } from "react";

const PORTRAIT_QUERY = "(orientation: portrait)";

/**
 * Read the viewport's orientation the way CSS does: `(orientation: portrait)`
 * is true when the viewport is at least as tall as it is wide. A browser (or a
 * test double) that answers no MediaQueryList falls back to comparing the
 * window's own size, which is the same rule.
 */
function readPortrait(): boolean {
  if (typeof window === "undefined") return false;
  const mql = typeof window.matchMedia === "function" ? window.matchMedia(PORTRAIT_QUERY) : undefined;
  if (mql && typeof mql.matches === "boolean") return mql.matches;
  return window.innerHeight >= window.innerWidth;
}

function subscribe(onChange: () => void): () => void {
  const mql = typeof window.matchMedia === "function" ? window.matchMedia(PORTRAIT_QUERY) : undefined;
  mql?.addEventListener?.("change", onChange);
  window.addEventListener("resize", onChange);
  window.addEventListener("orientationchange", onChange);
  return () => {
    mql?.removeEventListener?.("change", onChange);
    window.removeEventListener("resize", onChange);
    window.removeEventListener("orientationchange", onChange);
  };
}

const noSubscribe = () => () => {};
const never = () => false;

/**
 * Whether the viewport is in portrait, kept current across rotation. Only
 * listens while `enabled` — the phone chat asks, the desktop never does — and
 * answers false while disabled so a desktop layout never branches on it. The
 * server snapshot is landscape, the layout the component rendered before.
 */
export function usePortrait(enabled: boolean): boolean {
  return useSyncExternalStore(
    enabled ? subscribe : noSubscribe,
    enabled ? readPortrait : never,
    never,
  );
}
