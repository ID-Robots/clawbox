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

import { en } from "./en";
import { neutral } from "./neutral";
import {
  mergeWithPackSync,
  type MascotPhraseSet,
} from "@/lib/mascot-phrases";

export { en, neutral };

/** The language-free pack. Safe to render in any locale, at any time. */
export const NEUTRAL_PACK: MascotPhraseSet = neutral;

type PackLoader = () => Promise<MascotPhraseSet>;

// TODO(feat/mascot-locale-packs): the locale packs are written on their own
// branch. Add one entry here per pack file as it lands — the import specifier
// must stay a string literal so the bundler can code-split it:
//
//   bg: async () => (await import("./bg")).bg,
//   de: async () => (await import("./de")).de,
//   es: async () => (await import("./es")).es,
//   fr: async () => (await import("./fr")).fr,
//   it: async () => (await import("./it")).it,
//   ja: async () => (await import("./ja")).ja,
//   nl: async () => (await import("./nl")).nl,
//   sv: async () => (await import("./sv")).sv,
//   zh: async () => (await import("./zh")).zh,
//
// Until an entry exists the locale renders from `neutral`, which is correct
// (language-free) if joyless.
const LOADERS: Readonly<Record<string, PackLoader>> = {
  en: async () => en,
};

const loaded = new Map<string, MascotPhraseSet>([["en", en], ["neutral", neutral]]);

/**
 * The pack for `locale` if it is already in memory, otherwise the neutral
 * pack. Synchronous — for render paths that cannot await (the mascot's first
 * tick). Never returns English for a non-English locale.
 */
export function packForSync(locale: string): MascotPhraseSet {
  return loaded.get(locale) ?? NEUTRAL_PACK;
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
  const cached = loaded.get(locale);
  if (cached) return cached;
  const loader = Object.prototype.hasOwnProperty.call(LOADERS, locale) ? LOADERS[locale] : undefined;
  if (!loader) return NEUTRAL_PACK;
  try {
    const pack = await loader();
    loaded.set(locale, pack);
    return pack;
  } catch (err) {
    console.error(`[mascot-packs] failed to load pack for ${locale}:`, err);
    return NEUTRAL_PACK;
  }
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
