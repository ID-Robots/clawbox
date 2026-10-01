"use client";

import { useEffect } from "react";

/**
 * One browser, one ClawBox session (TASK-1247).
 *
 * The `clawbox_session` cookie belongs to the BROWSER, not to a tab. When one
 * tab signs in — a 12-hour session picked on /login, another user on a
 * multi-user box — or signs out, every other open tab's next request already
 * carries the new cookie (or none). What those tabs had drawn did not follow:
 * the previous desktop and its owner-or-not role, a Terminal whose socket was
 * authorised once, at upgrade, and stays on the previous session's shell, a
 * /login tab still asking for a password — all of it until someone pressed
 * reload.
 *
 * So the tab that changes the session says so (`announceSessionSwitch`), and
 * every signed-in page listens (`useFollowSessionSwitch`) and leaves for its
 * own address again — which the server now answers for the session that holds:
 * the new user's desktop, a Terminal on their shell, or /login when the switch
 * was a sign-out. Leaving with `location.replace` keeps the page that belonged
 * to the previous session out of history, so Back cannot bring it back.
 *
 * Two carriers, because neither reaches every browser the box is opened from:
 * a BroadcastChannel, and a localStorage record whose `storage` event every
 * other tab of the origin gets (older Safari has no BroadcastChannel; a window
 * with storage switched off still has the channel). The record doubles as the
 * session's epoch: a page restored from the back-forward cache, or a tab that
 * sat frozen in the background while the message went by, compares it with
 * the one it mounted on when it is shown again.
 */

export const SESSION_SWITCH_CHANNEL = "clawbox:session";
export const SESSION_SWITCH_STORAGE_KEY = "clawbox:session-switch";
/**
 * Dispatched on `window` as a page leaves its session — the one that changed
 * it, or one following another tab — so whatever holds a connection authorised
 * by the previous cookie (the Terminal's socket) drops it first.
 */
export const SESSION_SWITCH_EVENT = "clawbox:session-switch";

export type SessionSwitchKind = "login" | "logout";

export interface SessionSwitch {
  /** Unique per switch; how two carriers delivering the same one are told apart. */
  id: string;
  kind: SessionSwitchKind;
  /** The announcing browser's clock, for diagnostics only — never compared. */
  at: number;
}

/**
 * Where a page goes when `change` arrives from another tab: an address on this
 * origin, or null to stay where it is. Pass a module-level function — the
 * listener is re-attached whenever it changes identity.
 */
export type SessionSwitchDestination = (change: SessionSwitch) => string | null;

/** The switches this document announced itself — an echo of one is not news here. */
const announcedHere = new Set<string>();

/**
 * Plain-HTTP LAN access is not a secure context, so `crypto.randomUUID` is
 * missing exactly where the box is used most; `getRandomValues` is not gated.
 */
function newSwitchId(): string {
  try {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

/** A switch record from either carrier, or null for anything else. */
export function parseSessionSwitch(raw: unknown): SessionSwitch | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const { id, kind, at } = value as Record<string, unknown>;
  if (typeof id !== "string" || !id) return null;
  if (kind !== "login" && kind !== "logout") return null;
  return { id, kind, at: typeof at === "number" && Number.isFinite(at) ? at : 0 };
}

/** The most recent switch any tab of this origin announced, if storage has one. */
export function readSessionSwitch(): SessionSwitch | null {
  try {
    return parseSessionSwitch(window.localStorage.getItem(SESSION_SWITCH_STORAGE_KEY));
  } catch {
    return null;
  }
}

function openChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === "function" ? new BroadcastChannel(SESSION_SWITCH_CHANNEL) : null;
  } catch {
    return null;
  }
}

function leaveSession(change: SessionSwitch): void {
  try {
    window.dispatchEvent(new CustomEvent<SessionSwitch>(SESSION_SWITCH_EVENT, { detail: change }));
  } catch {
    // A listener that throws must not keep the page on the previous session.
  }
}

/**
 * Tell every other tab of this origin that the session just changed. Call it
 * once the server has answered — the new cookie is set, or the old one cleared
 * — and right before this page navigates itself.
 */
export function announceSessionSwitch(kind: SessionSwitchKind): SessionSwitch {
  const change: SessionSwitch = { id: newSwitchId(), kind, at: Date.now() };
  announcedHere.add(change.id);
  try {
    window.localStorage.setItem(SESSION_SWITCH_STORAGE_KEY, JSON.stringify(change));
  } catch {
    // Storage off or full: the channel below still carries it.
  }
  const channel = openChannel();
  if (channel) {
    // postMessage hands the message to every other channel before it returns,
    // so closing straight after (and the navigation that follows) loses nothing.
    try {
      channel.postMessage(change);
    } catch {
      // Nothing to do — the storage record above is the other carrier.
    }
    channel.close();
  }
  leaveSession(change);
  return change;
}

/**
 * Hear switches announced by OTHER tabs, each once, whichever carrier brings it
 * first. Returns the unsubscribe.
 */
export function subscribeSessionSwitch(listener: (change: SessionSwitch) => void): () => void {
  const delivered = new Set<string>();
  const deliver = (raw: unknown) => {
    const change = parseSessionSwitch(raw);
    if (!change || announcedHere.has(change.id) || delivered.has(change.id)) return;
    delivered.add(change.id);
    listener(change);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === SESSION_SWITCH_STORAGE_KEY && event.newValue) deliver(event.newValue);
  };
  window.addEventListener("storage", onStorage);
  const channel = openChannel();
  if (channel) channel.onmessage = (event: MessageEvent) => deliver(event.data);
  return () => {
    window.removeEventListener("storage", onStorage);
    if (channel) {
      channel.onmessage = null;
      channel.close();
    }
  };
}

/**
 * Query parameters that describe how the previous session ARRIVED at a page,
 * not the page: the desktop's `?notice=owner-only` is a one-time message about
 * a page that session was refused (src/lib/non-owner-scope.ts).
 */
const ONE_TIME_PARAMS = ["notice"];

/**
 * The address a page reopens at for the new session: its own path and query,
 * without one-time parameters and without the fragment — replacing the current
 * URL with one that differs only by `#…` would scroll instead of reloading.
 */
export function sessionSurfaceUrl(location: Pick<Location, "pathname" | "search">): string {
  const path = location.pathname.startsWith("/") && !location.pathname.startsWith("//") ? location.pathname : "/";
  const params = new URLSearchParams(location.search);
  for (const name of ONE_TIME_PARAMS) params.delete(name);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * Where /login sends a browser once it holds a session: the page the
 * middleware sent it from (`?redirect=`), or the desktop. Parsed against the
 * page's own origin and kept same-origin with a single leading "/", which
 * rejects "//evil.example" and "javascript:" alike.
 */
export function loginRedirectTarget(search: string, origin: string): string {
  const raw = new URLSearchParams(search).get("redirect") || "/";
  try {
    const parsed = new URL(raw, origin);
    if (parsed.origin === origin && parsed.pathname.startsWith("/") && !parsed.pathname.startsWith("//")) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
  } catch {
    // Unparseable: the desktop.
  }
  return "/";
}

/** Every signed-in page's default: reopen at its own address. */
export const reopenThisPage: SessionSwitchDestination = () => sessionSurfaceUrl(window.location);

/**
 * Keep this page on the browser's CURRENT session: when another tab signs in
 * or out, leave for `destination(change)` (by default this page's own
 * address) with `location.replace`. Also covers a switch this page could not
 * hear live — restored from the back-forward cache, or shown again after
 * sitting frozen in a background tab — by comparing the stored epoch with the
 * one it mounted on.
 */
export function useFollowSessionSwitch(destination: SessionSwitchDestination = reopenThisPage): void {
  useEffect(() => {
    let baseline = readSessionSwitch()?.id ?? null;
    let leaving = false;

    const follow = (change: SessionSwitch) => {
      if (leaving || change.id === baseline) return;
      baseline = change.id;
      const target = destination(change);
      if (target === null) return;
      leaving = true;
      leaveSession(change);
      window.location.replace(target);
    };

    const unsubscribe = subscribeSessionSwitch(follow);

    // `restored`: the page left and came back from the back-forward cache, so
    // a switch it announced ITSELF before leaving makes it stale too. While it
    // is live, its own switch is its own navigation already under way.
    const recheck = (restored: boolean) => {
      const last = readSessionSwitch();
      if (!last || last.id === baseline) return;
      if (!restored && announcedHere.has(last.id)) return;
      follow(last);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      leaving = false;
      recheck(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") recheck(false);
    };
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      unsubscribe();
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [destination]);
}
