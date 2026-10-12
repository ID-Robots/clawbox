"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as kv from "@/lib/client-kv";

/**
 * The chat run cards the OWNER put away with their ×, kept for good.
 *
 * The owner's report: a card hidden with × came back — after closing and
 * reopening the chat, after a reload. The set lived in ChatPopup's React state,
 * emptied every time the chat closed and gone with the page, and the 🤖 chip
 * that brings back the cards that left on their own brought these back with
 * them. A card the owner said to hide stays hidden now: the run ids are in the
 * box's kv store (data/kv.json, through `/setup-api/kv`), the same place the
 * desktop keeps its other small client state, so they outlive a closed chat, a
 * switched chat tab, a reload, a restart of the box and the browser itself.
 * The route is owner-only (src/lib/non-owner-scope.ts) and the chat mounts for
 * the owner only, so the list is the owner's and nobody else's.
 *
 * ONE KEY, a JSON array of run ids, oldest first. A run that is still in
 * flight goes in the same way: the owner follows it from the Coding Agent app
 * and its project page, not from a card they said to put away. Nothing takes
 * an id back out, so the list only grows — bounded to the newest
 * `MAX_DISMISSED_CODING_RUNS` (a few kilobytes), well under the route's
 * per-value cap. The chat only ever holds a handful of recent runs, so an id
 * old enough to fall off the end belongs to a run no card is drawn for.
 *
 * ANOTHER WINDOW. client-kv reads the store once, at page load, and writes the
 * whole value back, so two open windows would each keep their own list and
 * the last write would win. Because the list only grows, a union is always
 * right: the device's copy is read again whenever the chat opens and whenever
 * its window comes back to the front, merged with this window's, and written
 * back if either side had something the other lacked. A dismissal does the
 * same read straight after its own write, so one made in another window
 * meanwhile is folded in rather than overwritten.
 *
 * A READ THAT FAILS HIDES NOTHING. A store that cannot be read, a value that
 * is not a list of ids, or a fetch that throws all read as "nothing put away",
 * never as "everything": the cards show, and nothing here throws into the
 * chat's render.
 */
export const DISMISSED_CODING_RUNS_KEY = "clawbox-chat-dismissed-coding-runs";

/** How many put-away run ids are kept: the newest, the oldest dropped first. */
export const MAX_DISMISSED_CODING_RUNS = 500;

/** Longer than any run id the box mints; anything past it is not one. */
const MAX_ID_LENGTH = 200;

const NONE: readonly string[] = [];

function bounded(ids: readonly string[]): readonly string[] {
  return ids.length > MAX_DISMISSED_CODING_RUNS ? ids.slice(ids.length - MAX_DISMISSED_CODING_RUNS) : ids;
}

/**
 * The stored value as a list of run ids — a JSON string, or what one parses
 * to. Anything else, or anything in it that is not an id, is dropped; a value
 * that cannot be read at all is the empty list.
 */
export function parseDismissedCodingRuns(raw: unknown): readonly string[] {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return NONE;
    }
  }
  if (!Array.isArray(value)) return NONE;
  const ids = [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH))];
  return ids.length === 0 ? NONE : bounded(ids);
}

/** `ids` with `id` put away last, as the newest; the same list if it already is. */
export function withDismissedCodingRun(ids: readonly string[], id: string): readonly string[] {
  if (ids.includes(id)) return ids;
  return bounded([...ids, id]);
}

/**
 * Both lists in one: `base` in its order, then whatever only `extra` holds.
 * `base` when `extra` adds nothing.
 */
export function mergeDismissedCodingRuns(base: readonly string[], extra: readonly string[]): readonly string[] {
  const have = new Set(base);
  const added = extra.filter((id) => !have.has(id));
  return added.length === 0 ? base : bounded([...base, ...added]);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a === b || (a.length === b.length && a.every((id, i) => id === b[i]));
}

/** This page's copy (client-kv's cache, filled at page load). */
function readCached(): readonly string[] {
  try {
    return parseDismissedCodingRuns(kv.get(DISMISSED_CODING_RUNS_KEY));
  } catch {
    return NONE;
  }
}

/** The device's copy, or null when it could not be read. */
async function readDevice(): Promise<readonly string[] | null> {
  try {
    const res = await fetch(`/setup-api/kv?key=${encodeURIComponent(DISMISSED_CODING_RUNS_KEY)}`);
    if (!res.ok) return null;
    const data: unknown = await res.json();
    // The route's `{ key, value }`, value null when the key was never written.
    // Any other shape is not an answer, and is no reason to write over it.
    if (!data || typeof data !== "object" || Array.isArray(data) || !Object.hasOwn(data, "value")) return null;
    return parseDismissedCodingRuns((data as { value: unknown }).value);
  } catch {
    return null;
  }
}

function write(ids: readonly string[]): void {
  try {
    kv.set(DISMISSED_CODING_RUNS_KEY, JSON.stringify(ids));
  } catch {
    // The card is already gone from this window; the next sync writes again.
  }
}

/**
 * The run cards the owner put away, and the way to put one away.
 *
 * `isOpen` is the chat's own: the device's copy is read again each time it
 * opens, and while it is open whenever its window returns to the front.
 */
export function useDismissedCodingRuns(isOpen: boolean): {
  /** Run ids whose card the owner put away. */
  dismissed: ReadonlySet<string>;
  /** Put this run's card away, for good. */
  dismiss: (id: string) => void;
} {
  const [ids, setIds] = useState(readCached);
  // The list as it is NOW, for a merge that lands after a dismissal made while
  // the device was being read — state in a closure would be a render behind.
  const idsRef = useRef(ids);

  const adopt = useCallback((next: readonly string[]) => {
    if (sameList(next, idsRef.current)) return;
    idsRef.current = next;
    setIds(next);
  }, []);

  // One read of the device at a time. A sync asked for while one is out — the
  // chat reopened, or a × pressed, before the device answered — runs once
  // more when it is back: the answer in flight may predate what it was asked
  // for.
  const syncing = useRef({ running: false, again: false });
  const sync = useCallback(async () => {
    const state = syncing.current;
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    try {
      do {
        state.again = false;
        const device = await readDevice();
        if (device === null) continue;
        const local = idsRef.current;
        const merged = mergeDismissedCodingRuns(device, local);
        adopt(merged);
        // Write back what the device lacks, and refresh this page's cache when
        // the device had what it lacked.
        if (!sameList(merged, device) || !sameList(merged, local)) write(merged);
      } while (state.again);
    } finally {
      state.running = false;
    }
  }, [adopt]);

  useEffect(() => {
    if (!isOpen) return;
    void sync();
    const onFront = () => {
      if (document.visibilityState === "visible") void sync();
    };
    window.addEventListener("focus", onFront);
    document.addEventListener("visibilitychange", onFront);
    return () => {
      window.removeEventListener("focus", onFront);
      document.removeEventListener("visibilitychange", onFront);
    };
  }, [isOpen, sync]);

  const dismiss = useCallback((id: string) => {
    const next = withDismissedCodingRun(idsRef.current, id);
    if (next === idsRef.current) return;
    adopt(next);
    write(next);
    void sync();
  }, [adopt, sync]);

  const dismissed = useMemo<ReadonlySet<string>>(() => new Set(ids), [ids]);
  return { dismissed, dismiss };
}
