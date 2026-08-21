// Client-only helpers shared by the Mascot component. Lives in `lib/` to
// keep the component file focused on stateful React logic — these are pure
// fetch/transform functions with module-level caches.

import { mergeWithPack, packFor, packForSync, NEUTRAL_PACK } from "@/lib/mascot-packs";
import type { MascotPhraseSet } from "@/lib/mascot-phrases";

// `ui_user_name` cache — fetched once on mount and on the
// `clawbox-user-name-changed` event from Settings so the popups
// pick up edits without a reload.
let cachedUserName: string | null = null;

export async function fetchUserName(): Promise<string | null> {
  try {
    const res = await fetch("/setup-api/preferences?keys=ui_user_name");
    if (!res.ok) return cachedUserName;
    const data = await res.json();
    const raw = data?.ui_user_name;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      cachedUserName = trimmed.length > 0 ? trimmed : null;
    }
  } catch {
    /* keep last cached value */
  }
  return cachedUserName;
}

// Phrase cache, keyed by `${date}:${locale}` so a language switch doesn't keep
// showing yesterday's phrases until midnight, and two locales can coexist
// (user toggles back and forth). `lastByLocale` keeps the most recent entry
// PER LOCALE — a stale-day fetch failure falls back to yesterday's phrases in
// the SAME language, never to another language's.
const PHRASE_CACHE_MAX = 10;
const phraseCache = new Map<string, MascotPhraseSet>();
const lastByLocale = new Map<string, MascotPhraseSet>();

function cacheKey(locale: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${today}:${locale}`;
}

/**
 * The phrases for `locale`, from the API when it answers and from that
 * locale's pack when it doesn't. Never resolves to another locale's phrases.
 */
export async function fetchPhraseSet(locale: string): Promise<MascotPhraseSet> {
  const key = cacheKey(locale);
  const hit = phraseCache.get(key);
  if (hit) return hit;
  const fallback = lastByLocale.get(locale) ?? (await packFor(locale));
  try {
    const res = await fetch(`/setup-api/mascot-lines?locale=${encodeURIComponent(locale)}`);
    if (!res.ok) return fallback;
    const data = (await res.json()) as {
      phrases?: Partial<MascotPhraseSet>;
      meta?: { locale?: string };
    };
    // The server echoes the locale it actually served. If it disagrees with
    // what we asked for, the payload is for a different language — drop it
    // rather than render it.
    if (data.meta?.locale && data.meta.locale !== locale) return fallback;
    const fresh = await mergeWithPack(data.phrases ?? null, locale);
    if (phraseCache.size >= PHRASE_CACHE_MAX) {
      const oldest = phraseCache.keys().next().value;
      if (oldest) phraseCache.delete(oldest);
    }
    phraseCache.set(key, fresh);
    lastByLocale.set(locale, fresh);
    return fresh;
  } catch {
    return fallback;
  }
}

/**
 * The phrases to render right now, without awaiting anything: the locale's
 * pack if it is already in memory, the neutral (emoji-only) pack otherwise.
 * Used for the mascot's very first tick — it must never be English on a
 * non-English box.
 */
export function initialPhraseSet(locale: string): MascotPhraseSet {
  return phraseCache.get(cacheKey(locale)) ?? lastByLocale.get(locale) ?? packForSync(locale);
}

export { NEUTRAL_PACK };

/** A bubble the mascot can render: the template it was picked from, and the text to show. */
export interface MascotLine {
  /** Pre-substitution — this is what the language gate must judge. */
  template: string;
  text: string;
}

/**
 * Pick a greeting and substitute the user's name. Returns the template too:
 * the render gate validates THAT, so an owner called "Красимир" on an English
 * box still gets greeted instead of silenced.
 */
export function pickNameGreeting(name: string, phrases: MascotPhraseSet): MascotLine {
  const list = phrases.nameGreetings.length > 0 ? phrases.nameGreetings : NEUTRAL_PACK.nameGreetings;
  const template = list[Math.floor(Math.random() * list.length)];
  return { template, text: template.replace(/\{name\}/g, name) };
}
