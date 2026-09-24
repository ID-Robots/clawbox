"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_CHAT_FULLSCREEN,
  DEFAULT_CHAT_TEXT_SCALE,
  readChatFullscreen,
  readChatTextScale,
  subscribeChatPhoneLayout,
  writeChatFullscreen,
  writeChatTextScale,
  type ChatTextScale,
} from "@/lib/chat-phone-layout";
import { PHONE_MAX_WIDTH, isPhoneViewport } from "@/lib/mobile-chat-first";

/**
 * The phone chat's view settings as React state — see lib/chat-phone-layout.ts.
 * Every component that calls these follows the same store, so a toggle in one
 * chat surface redraws the other, and the server render (no storage) draws the
 * defaults until hydration reads the real choice.
 */
export function useChatFullscreen(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribeChatPhoneLayout, readChatFullscreen, () => DEFAULT_CHAT_FULLSCREEN);
  const set = useCallback((next: boolean) => writeChatFullscreen(next), []);
  return [on, set];
}

export function useChatTextScale(): [ChatTextScale, (scale: ChatTextScale) => void] {
  const scale = useSyncExternalStore(subscribeChatPhoneLayout, readChatTextScale, () => DEFAULT_CHAT_TEXT_SCALE);
  const set = useCallback((next: ChatTextScale) => writeChatTextScale(next), []);
  return [scale, set];
}

// ── Is this a phone? ─────────────────────────────────────────────────────────
//
// For a surface that is not handed the desktop's own `mobile` answer (the
// full-page chat at /app/clawbox). The same line the desktop draws: below
// PHONE_MAX_WIDTH it lays out as a phone, at or above it nothing changes.
const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH - 0.02}px)`;

/** The query list, or null where there is none to ask (a stub, an old engine). */
function phoneQuery(): MediaQueryList | null {
  if (typeof window.matchMedia !== "function") return null;
  const query = window.matchMedia(PHONE_QUERY);
  return query && typeof query.matches === "boolean" ? query : null;
}

function subscribePhone(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const query = phoneQuery();
  // Safari before 14 only has the deprecated listener pair.
  if (typeof query?.addEventListener === "function") query.addEventListener("change", onChange);
  else query?.addListener?.(onChange);
  // The width itself too, for a browser (or a test double) with no query list.
  window.addEventListener("resize", onChange);
  return () => {
    if (typeof query?.removeEventListener === "function") query.removeEventListener("change", onChange);
    else query?.removeListener?.(onChange);
    window.removeEventListener("resize", onChange);
  };
}

function readPhone(): boolean {
  if (typeof window === "undefined") return false;
  const query = phoneQuery();
  return query ? query.matches : isPhoneViewport(window.innerWidth);
}

export function usePhoneViewport(): boolean {
  return useSyncExternalStore(subscribePhone, readPhone, () => false);
}
