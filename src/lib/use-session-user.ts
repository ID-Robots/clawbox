"use client";

import { useEffect, useState } from "react";

/**
 * Who is signed in on this browser (TASK-1256, multi-user ClawBox OS), from
 * GET /setup-api/users/me — the one users route every signed-in user reaches.
 *
 * `isOwner: false` is a ClawBox user other than the owner: the desktop shows
 * them only the apps scoped per user (src/lib/non-owner-scope.ts), and the
 * server refuses everything else whatever the UI draws.
 */
export interface SessionUser {
  username: string;
  isOwner: boolean;
  /** The box has users besides the owner — the desktop then names who is signed in. */
  multiUser: boolean;
}

let pending: Promise<SessionUser | null> | null = null;

function parse(data: unknown): SessionUser | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.username !== "string" || !d.username) return null;
  return { username: d.username, isOwner: d.isOwner === true, multiUser: d.multiUser === true };
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
 * Whether the browser may call the owner's routes — the gate every desktop
 * fetch of an owner-only /setup-api route waits on, so a non-owner's desktop
 * never sends the ~15 requests the server would only refuse with 403
 * (src/lib/non-owner-scope.ts).
 *
 * `false` only once the box has SAID the session is another ClawBox user's.
 * When `users/me` cannot be had the answer is `true`: the owner's desktop
 * behaves exactly as it did before multi-user, and the server still refuses
 * whatever it must — this gate is about noise, never about access.
 */
export function mayUseOwnerApis(): Promise<boolean> {
  return fetchSessionUser().then((u) => u?.isOwner !== false);
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
