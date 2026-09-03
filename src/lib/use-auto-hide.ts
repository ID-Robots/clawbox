"use client";

import { useEffect, useRef } from "react";

/**
 * How long a desktop notice stays before it leaves on its own.
 *
 * The owner asked for the top-right cards — a finished coding run, an
 * available update, the ClawBox AI offer, a Telegram access request — to
 * "hide after some time" rather than wait for a click. Nothing is lost when
 * one goes: the run is in the Coding Agent app, the update in Settings →
 * System Update, the offer behind the shelf shield, and the request in
 * Settings → Telegram. One number for all of them, so the desktop has one
 * rhythm.
 */
export const NOTICE_AUTO_HIDE_MS = 30_000;

/**
 * Give every key in `keys` a clock, and call `onExpire(key)` when it runs out.
 *
 * A key gets its clock the first time it appears and keeps it across
 * re-renders (a card re-shown by a poll replay does not get a fresh 30 s);
 * a key that leaves `keys` — dismissed by hand — has its clock cleared, so a
 * later card with the same key starts over. Every clock is cleared on
 * unmount. `onExpire` is read through a ref, so the latest handler runs and
 * the clocks never restart because a callback identity changed.
 */
export function useAutoHide(
  keys: readonly string[],
  onExpire: (key: string) => void,
  ms: number = NOTICE_AUTO_HIDE_MS,
): void {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const expire = useRef(onExpire);
  useEffect(() => { expire.current = onExpire; }, [onExpire]);

  useEffect(() => {
    const live = timers.current;
    const wanted = new Set(keys);
    for (const key of wanted) {
      if (live.has(key)) continue;
      live.set(key, setTimeout(() => {
        live.delete(key);
        expire.current(key);
      }, ms));
    }
    for (const [key, timer] of live) {
      if (!wanted.has(key)) { clearTimeout(timer); live.delete(key); }
    }
  }, [keys, ms]);

  useEffect(() => {
    const live = timers.current;
    return () => { for (const timer of live.values()) clearTimeout(timer); live.clear(); };
  }, []);
}
