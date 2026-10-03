"use client";

import { useCallback, useSyncExternalStore } from "react";
import { useT } from "@/lib/i18n";

/**
 * The desktop's clock — the shelf's time and the power menu's time and date —
 * as a store of its own, read by the two labels that show it.
 *
 * It used to be state of the desktop's ROOT component, ticking every second,
 * and its only readers were the shelf and the tray: every new minute rebuilt
 * the whole desktop — every window and the app in it, the chat with its
 * transcript, the mascot — to change one text node, and the second after each
 * of those renders React ran the root's body once more to bail out of an
 * unchanged string. Now a new minute re-renders the labels and nothing else.
 *
 * ONE ticker for every label on screen, so the shelf and an open power menu
 * turn the minute in the same frame, as they did when they shared the root's
 * state. It runs only while a label is mounted, every second as before: the box
 * has no RTC and its clock jumps when NTP syncs, and a one-second tick is what
 * puts the jump on screen within a second rather than at the next minute
 * boundary the old clock had computed.
 *
 * Formatted with `toLocale*String` on every tick, not with a cached
 * `Intl.DateTimeFormat`: a formatter keeps the time zone it was built in, and
 * the box's zone is changed at runtime (Settings, TimezoneAdopter) — the
 * per-call form follows the change, a cached one would show the old zone until
 * a reload.
 */
export interface DesktopClock {
  time: string;
  date: string;
}

const EMPTY: DesktopClock = { time: "", date: "" };

/**
 * The language tag the clock is written in: the desktop's own language, never
 * the browser's — `[]` meant navigator.language, so a German box opened from an
 * en-US browser showed "09:27 AM" on the shelf and "Monday, September 7" in the
 * power menu while About printed its build date in German — with the browser's
 * REGION for that language when it offers one. `locale` is a bare tag, and a
 * bare "en" is en-US to Intl: "09:27 AM" for every English desktop, the en-GB,
 * en-IE and en-ZA browsers that read "09:27" until then included. The box's
 * language still wins: the German box above finds no "de-…" entry in an en-US
 * browser's list and keeps "de". A bare "en" ahead of "en-GB" in the list adds
 * nothing over `locale`, so only a regional entry is taken.
 */
export function clockLocaleTag(locale: string, languages: readonly string[] | undefined): string {
  return languages?.find((l) => l.toLowerCase().startsWith(`${locale}-`)) ?? locale;
}

function formatClock(now: Date, tag: string): DesktopClock {
  return {
    time: now.toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" }),
    date: now.toLocaleDateString(tag, { weekday: "long", month: "long", day: "numeric" }),
  };
}

interface ClockEntry {
  text: DesktopClock;
  listeners: Set<() => void>;
}

/** One entry per language tag on screen (in practice one: the desktop's). */
const clocks = new Map<string, ClockEntry>();
let ticker: ReturnType<typeof setInterval> | null = null;

function anyoneListening(): boolean {
  for (const entry of clocks.values()) if (entry.listeners.size > 0) return true;
  return false;
}

function tick(): void {
  const now = new Date();
  for (const [tag, entry] of clocks) {
    // Read by a render that never mounted: nothing will ever be told.
    if (entry.listeners.size === 0) {
      clocks.delete(tag);
      continue;
    }
    const text = formatClock(now, tag);
    // The same minute: a new object would re-render every label for nothing.
    if (text.time === entry.text.time && text.date === entry.text.date) continue;
    entry.text = text;
    for (const listener of entry.listeners) listener();
  }
  if (!anyoneListening() && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

/** The clock as it reads now — formatted on first sight, so a label never paints empty. */
function readClock(tag: string): DesktopClock {
  let entry = clocks.get(tag);
  if (!entry) {
    entry = { text: formatClock(new Date(), tag), listeners: new Set() };
    clocks.set(tag, entry);
  }
  return entry.text;
}

function subscribeClock(tag: string, listener: () => void): () => void {
  readClock(tag);
  const entry = clocks.get(tag)!;
  entry.listeners.add(listener);
  if (!ticker) ticker = setInterval(tick, 1000);
  return () => {
    entry.listeners.delete(listener);
    // Gone with its last label, so the next one to mount formats afresh
    // instead of painting a time from when it was last on screen.
    if (entry.listeners.size === 0 && clocks.get(tag) === entry) clocks.delete(tag);
    if (!anyoneListening() && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

const serverClock = () => EMPTY;

/** The desktop's time and date, re-rendering the caller only when the text changes. */
export function useDesktopClock(): DesktopClock {
  const { locale } = useT();
  // Re-read when the locale resolves, since every provider starts on a
  // provisional "en": a new tag is a new entry, formatted at once.
  const tag = clockLocaleTag(locale, typeof navigator === "undefined" ? undefined : navigator.languages);
  const subscribe = useCallback((listener: () => void) => subscribeClock(tag, listener), [tag]);
  const getSnapshot = useCallback(() => readClock(tag), [tag]);
  return useSyncExternalStore(subscribe, getSnapshot, serverClock);
}
