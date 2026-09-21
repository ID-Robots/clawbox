// ── Mascot phrase packs ──
//
// One hand-written pack per UI locale. The pack is the mascot's floor: it is
// what the crab says on a fresh box, what fills a category the local generator
// could not produce, and what the render gate falls back to. There is NO
// English fallback for a non-English locale — a locale without a pack falls
// back to `neutral` (emoji only), because showing English on a Bulgarian box
// is the bug this whole module exists to fix.
//
// Loading strategy: `en` and `neutral` are bundled statically (tiny, and the
// neutral pack is needed on the very first render). Every other locale is
// dynamically imported the first time it is asked for, so a Japanese box does
// not ship nine unused packs to the browser.

import { en, enCrab } from "./en";
import { neutral, neutralCrab } from "./neutral";
import {
  mergeWithPackSync,
  type MascotPhraseSet,
} from "@/lib/mascot-phrases";

export { en, neutral };

/** The language-free pack. Safe to render in any locale, at any time. */
export const NEUTRAL_PACK: MascotPhraseSet = neutral;

/** The 🦀-literal entries of the neutral pack — see `mascot-pet-voice.ts`. */
export const NEUTRAL_CRAB_LINES: readonly string[] = neutralCrab;

/**
 * A locale's pack together with the crab-literal lines inside it.
 *
 * Loaded as one unit because they live in one module: the crab tags are only
 * useful next to the pack they describe, and pairing them here means a locale
 * still downloads exactly one chunk.
 */
export interface LocalePack {
  phrases: MascotPhraseSet;
  /** Entries a pet must never speak. Subtracted by `petSafePhrases`. */
  crab: readonly string[];
}

type PackLoader = () => Promise<LocalePack>;

// One entry per locale ClawBox ships a UI language for. Each import specifier
// is a string literal on purpose: that is what lets the bundler code-split the
// pack into its own chunk, so a Japanese box never downloads the other nine.
//
// A locale missing from this map renders from `neutral` — correct
// (language-free) if joyless — and `mascot-packs.test.ts` fails, because every
// PREFERENCE_LANGUAGES entry is required to have a real pack.
const LOADERS: Readonly<Record<string, PackLoader>> = {
  en: async () => ({ phrases: en, crab: enCrab }),
  bg: async () => { const m = await import("./bg"); return { phrases: m.bg, crab: m.bgCrab }; },
  de: async () => { const m = await import("./de"); return { phrases: m.de, crab: m.deCrab }; },
  es: async () => { const m = await import("./es"); return { phrases: m.es, crab: m.esCrab }; },
  fr: async () => { const m = await import("./fr"); return { phrases: m.fr, crab: m.frCrab }; },
  it: async () => { const m = await import("./it"); return { phrases: m.it, crab: m.itCrab }; },
  ja: async () => { const m = await import("./ja"); return { phrases: m.ja, crab: m.jaCrab }; },
  nl: async () => { const m = await import("./nl"); return { phrases: m.nl, crab: m.nlCrab }; },
  sv: async () => { const m = await import("./sv"); return { phrases: m.sv, crab: m.svCrab }; },
  zh: async () => { const m = await import("./zh"); return { phrases: m.zh, crab: m.zhCrab }; },
};

const NEUTRAL_LOCALE_PACK: LocalePack = { phrases: neutral, crab: neutralCrab };

const loaded = new Map<string, LocalePack>([
  ["en", { phrases: en, crab: enCrab }],
  ["neutral", NEUTRAL_LOCALE_PACK],
]);

/**
 * The pack for `locale` if it is already in memory, otherwise the neutral
 * pack. Synchronous — for render paths that cannot await (the mascot's first
 * tick). Never returns English for a non-English locale.
 */
export function packForSync(locale: string): MascotPhraseSet {
  return (loaded.get(locale) ?? NEUTRAL_LOCALE_PACK).phrases;
}

/** The crab tags for `locale` if its pack is already in memory, else the
 *  neutral pack's. Sync companion to `packForSync`. */
export function crabLinesForSync(locale: string): readonly string[] {
  return (loaded.get(locale) ?? NEUTRAL_LOCALE_PACK).crab;
}

/** True when `locale` has a real pack (as opposed to falling back to neutral). */
export function hasPack(locale: string): boolean {
  return Object.prototype.hasOwnProperty.call(LOADERS, locale);
}

/**
 * Load (and memoise) the pack for `locale`. Falls back to the neutral pack for
 * a locale whose pack file has not landed yet, or whose import fails.
 */
export async function packFor(locale: string): Promise<MascotPhraseSet> {
  return (await localePackFor(locale)).phrases;
}

/** As `packFor`, but keeps the crab tags alongside the phrases. */
export async function localePackFor(locale: string): Promise<LocalePack> {
  const cached = loaded.get(locale);
  if (cached) return cached;
  const loader = Object.prototype.hasOwnProperty.call(LOADERS, locale) ? LOADERS[locale] : undefined;
  if (!loader) return NEUTRAL_LOCALE_PACK;
  try {
    const pack = await loader();
    loaded.set(locale, pack);
    return pack;
  } catch (err) {
    console.error(`[mascot-packs] failed to load pack for ${locale}:`, err);
    return NEUTRAL_LOCALE_PACK;
  }
}

/** The crab-literal entries of `locale`'s pack. Neutral's for an unknown one. */
export async function crabLinesFor(locale: string): Promise<readonly string[]> {
  return (await localePackFor(locale)).crab;
}

/**
 * Validate `set` against `locale` and top every category that did not survive
 * up from that locale's pack. The async companion to `mergeWithPackSync` —
 * this is the one callers normally want.
 */
export async function mergeWithPack(
  set: Partial<MascotPhraseSet> | null | undefined,
  locale: string,
): Promise<MascotPhraseSet> {
  return mergeWithPackSync(set, await packFor(locale), locale);
}
