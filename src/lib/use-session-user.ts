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

/** Test-only: forget the shared request. */
export function _resetSessionUserForTest(): void {
  pending = null;
}
