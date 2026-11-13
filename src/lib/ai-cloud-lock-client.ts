"use client";

/**
 * The local-only AI lock in the browser (TASK-2501): `useCloudAiLock()`.
 *
 * For the surfaces that offer a cloud AI path — the ClawBox AI row, the cloud
 * provider list in Settings and in the setup wizard — to hide it while the
 * lock is on. One request per page load, shared by every caller;
 * `refreshCloudAiLock()` after the switch moves.
 *
 * `GET /setup-api/local-ai/lock` is the owner's: another user, who cannot
 * change providers anyway, reads `locked: false` with `known: false`. The
 * route and the Settings switch come with the lock's own page; until then the
 * GET answers 404, which this reads as unknown (`locked: false`). Nothing here
 * is a guard: every cloud path is refused on the server whatever a page shows.
 */

import { useSyncExternalStore } from "react";
import type { CloudAiLockReport } from "@/lib/ai-cloud-lock-shared";

export const CLOUD_AI_LOCK_ROUTE = "/setup-api/local-ai/lock";

export interface CloudAiLockView {
  /** The lock is on. False while unknown. */
  locked: boolean;
  pinned: boolean;
  /** The server answered; false while loading or for a non-owner. */
  known: boolean;
  report: CloudAiLockReport | null;
}

const UNKNOWN: CloudAiLockView = { locked: false, pinned: false, known: false, report: null };

let cached: CloudAiLockView | null = null;
let inflight: Promise<CloudAiLockView> | null = null;
const listeners = new Set<() => void>();
/**
 * Bumped by every refresh and every published answer. A load that comes back
 * after a newer one started, or after a POST published the switch's new state,
 * is older news and is dropped rather than written over it.
 */
let generation = 0;

/** The view a `GET` answer gives. Exported for tests. */
export function cloudAiLockViewFrom(status: number, body: unknown): CloudAiLockView {
  if (status !== 200 || !body || typeof body !== "object") return UNKNOWN;
  const report = body as CloudAiLockReport;
  return {
    locked: report.cloud_ai_locked === true,
    pinned: report.pinned === true,
    known: true,
    report,
  };
}

async function load(): Promise<CloudAiLockView> {
  try {
    const res = await fetch(CLOUD_AI_LOCK_ROUTE, { cache: "no-store" });
    const body = await res.json().catch(() => null);
    return cloudAiLockViewFrom(res.status, body);
  } catch {
    return UNKNOWN;
  }
}

function publish(view: CloudAiLockView): void {
  cached = view;
  for (const listener of listeners) listener();
}

/** Ask the server again and tell every mounted hook. */
export function refreshCloudAiLock(): Promise<CloudAiLockView> {
  const mine = ++generation;
  const pending: Promise<CloudAiLockView> = load().then((view) => {
    if (inflight === pending) inflight = null;
    if (mine !== generation) return cached ?? view;
    publish(view);
    return view;
  });
  inflight = pending;
  return pending;
}

/** Hand a fresh answer (a POST's response) to every mounted hook without asking again. */
export function publishCloudAiLock(status: number, body: unknown): void {
  const view = cloudAiLockViewFrom(status, body);
  if (!view.known) return;
  generation += 1;
  publish(view);
}

/** Test seam. */
export function resetCloudAiLockCache(): void {
  cached = null;
  inflight = null;
  generation = 0;
  listeners.clear();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // The first hook on the page asks; every later one shares that answer.
  if (!cached && !inflight) void refreshCloudAiLock();
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): CloudAiLockView {
  return cached ?? UNKNOWN;
}

function serverSnapshot(): CloudAiLockView {
  return UNKNOWN;
}

export function useCloudAiLock(): CloudAiLockView {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
