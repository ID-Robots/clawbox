// Client-only helpers shared by the Mascot component. Lives in `lib/` to
// keep the component file focused on stateful React logic — these are pure
// fetch/transform functions with module-level caches.

import { INSPIRATION_PHRASES, ensureFullPhraseSet, type MascotPhraseSet } from "@/lib/mascot-phrases";

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

// Phrase cache, keyed by `${date}:${locale}` so a language switch doesn't
// keep showing yesterday's phrases until midnight, and two locales can
// coexist (user toggles back and forth). `lastByLocale` keeps the most
// recent entry per locale so a stale-day fetch failure can fall back to
// "yesterday's English" instead of plain inspiration.
export interface PhraseCacheEntry {
  phrases: MascotPhraseSet;
  snippets: string[];
}

const PHRASE_CACHE_MAX = 10;
const phraseCache = new Map<string, PhraseCacheEntry>();
const lastByLocale = new Map<string, PhraseCacheEntry>();

function cacheKey(locale: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${today}:${locale}`;
}

export async function fetchPhraseSet(locale: string): Promise<PhraseCacheEntry> {
  const key = cacheKey(locale);
  const hit = phraseCache.get(key);
  if (hit) return hit;
  const stalest = lastByLocale.get(locale) ?? { phrases: INSPIRATION_PHRASES, snippets: [] };
  try {
    const res = await fetch(`/setup-api/mascot-lines?locale=${encodeURIComponent(locale)}`);
    if (!res.ok) return stalest;
    const data = (await res.json()) as { phrases?: Partial<MascotPhraseSet>; lines?: string[] };
    const fresh: PhraseCacheEntry = {
      phrases: ensureFullPhraseSet(data.phrases ?? null),
      snippets: Array.isArray(data.lines) ? data.lines : [],
    };
    if (phraseCache.size >= PHRASE_CACHE_MAX) {
      const oldest = phraseCache.keys().next().value;
      if (oldest) phraseCache.delete(oldest);
    }
    phraseCache.set(key, fresh);
    lastByLocale.set(locale, fresh);
    return fresh;
  } catch {
    return stalest;
  }
}

export function pickNameGreeting(name: string, phrases: MascotPhraseSet): string {
  const list = phrases.nameGreetings.length > 0 ? phrases.nameGreetings : INSPIRATION_PHRASES.nameGreetings;
  const tpl = list[Math.floor(Math.random() * list.length)];
  return tpl.replace(/\{name\}/g, name);
}
