"use client";

import { useEffect, useState } from "react";

/**
 * Who is signed in on this browser (multi-user ClawBox OS), from
 * GET /setup-api/users/me.
 *
 * `isOwner: false` is a ClawBox user other than the owner. They get the
 * owner's desktop — every app but the harnesses' own consoles, and Settings —
 * with a chat of their own (src/lib/chat-scope.ts); src/lib/non-owner-scope.ts
 * is what the server holds them to whatever the UI draws.
 */
export interface SessionUser {
  username: string;
  isOwner: boolean;
  /** The box has users besides the owner — the desktop then names who is signed in. */
  multiUser: boolean;
  /** The owner shares OpenClaw with every user, so its icon is theirs too (src/lib/non-owner-scope.ts). */
  openclawShared: boolean;
}

let pending: Promise<SessionUser | null> | null = null;

function parse(data: unknown): SessionUser | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.username !== "string" || !d.username) return null;
  return {
    username: d.username,
    isOwner: d.isOwner === true,
    multiUser: d.multiUser === true,
    openclawShared: d.openclawShared === true,
  };
}

/** One request per page load, shared by every component that asks. A failure is retried on the next ask. */
export function fetchSessionUser(): Promise<SessionUser | null> {
  if (!pending) {
    pending = fetch("/setup-api/users/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(parse)
      .catch(() => null)
      .then((user) => {
        if (!user) pending = null;
        return user;
      });
  }
  return pending;
}

/**
 * `undefined` until /users/me has answered or failed, then the user — or
 * `null` when it could not be had, which the desktop treats as the owner's,
 * exactly as before multi-user. For what must not be drawn twice for two
 * different people: the chat, whose cached tabs and main conversation are
 * the signed-in person's own.
 */
export function useSettledSessionUser(): SessionUser | null | undefined {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void fetchSessionUser().then((u) => {
      if (live) setUser(u);
    });
    return () => {
      live = false;
    };
  }, []);
  return user;
}

/** `null` until the answer arrives (and when it cannot be had). */
export function useSessionUser(): SessionUser | null {
  const [user, setUser] = useState<SessionUser | null>(null);
  useEffect(() => {
    let live = true;
    void fetchSessionUser().then((u) => {
      if (live) setUser(u);
    });
    return () => {
      live = false;
    };
  }, []);
  return user;
}

/**
 * Whether the browser may call the desktop's routes — every signed-in ClawBox
 * user may, since each gets the owner's desktop (src/lib/non-owner-scope.ts
 * names the few exceptions, which the server answers itself). Still a
 * promise, and still the gate the desktop's first reads wait on, so they go
 * out once /users/me has said who is signed in rather than before.
 *
 * Never `false` for a signed-in person; kept as a gate rather than removed so
 * a desktop component that must wait for the answer has one place to ask.
 */
export function mayUseOwnerApis(): Promise<boolean> {
  return fetchSessionUser().then(() => true);
}

/** `mayUseOwnerApis()` as a hook: `null` until settled, so an effect can wait on it. */
export function useMayUseOwnerApis(): boolean | null {
  const [may, setMay] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void mayUseOwnerApis().then((m) => {
      if (live) setMay(m);
    });
    return () => {
      live = false;
    };
  }, []);
  return may;
}

/** Test-only: forget the shared request. */
export function _resetSessionUserForTest(): void {
  pending = null;
}
