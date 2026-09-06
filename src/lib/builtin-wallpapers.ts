/**
 * The wallpapers a ClawBox ships with, and which of them THIS edition offers.
 *
 * The owner's ruling (2026-09-06): "Remove the Hermes wallpaper from the
 * OpenClaw version. And vice versa — the ClawBox wallpaper from the Hermes
 * version." So the built-in list is edition-scoped — the OpenClaw edition
 * offers its own brand plus the neutral Deep Space, the Hermes edition offers
 * the Hermes art plus Deep Space, the premium `dual` SKU follows whichever
 * harness is active, and the pictures the owner uploaded are on every edition.
 * A customer never sees the other product's artwork on a box they bought.
 *
 * ONE list, because there are five readers of it — the desktop's painted
 * background, the desktop's Appearance grid, `/app/settings`'s Appearance grid,
 * the Appearance row's subtitle (which prints the selected wallpaper's NAME),
 * and the upload path that appends to it. The desktop and the standalone route
 * each held their own copy with a comment asking for them to be kept in step by
 * hand; a rule that has to be applied twice is a rule that will be applied once.
 *
 * WHAT THE EDITION IS, AND WHAT IT IS NOT
 *
 * `harness` here is the device's OWN answer — `/setup-api/harness/active`,
 * which resolves through the root-owned edition lock (src/lib/edition-source.ts)
 * — and `null` means NOBODY HAS SAID YET, which covers three real states: the
 * probe is still in flight, the probe failed, and the lock exists but no edition
 * could be read out of it. All three are the same question to this module, and
 * the answer is the same: show the neutral wallpaper only.
 *
 * That is the fail-closed direction, and it is chosen rather than inherited.
 * `readEditionSource()` collapses "nobody said" into its own "openclaw" default
 * — the right default for "which SKU is this", where guessing the non-premium
 * answer is the safe way to be wrong, and the WRONG one here, where the guess is
 * a competitor's picture across the customer's screen. So the route reports
 * whether anything actually named an edition (`editionKnown`) and this module
 * refuses to brand a box on a guess.
 *
 * PAINTING vs PERSISTING is the rule PR #728 established for the same values
 * and it holds here: a guess is fine to paint, because the paint corrects itself
 * the moment the device answers, and is never fine to write to `wp_id` — that
 * key is box-wide SQLite, so a browser writing its guess there decides for every
 * other browser and for the box's own screen, permanently. That is the whole
 * difference between `defaultWallpaperId` (always names one) and
 * `brandWallpaperId` (null on a doubt, and so the only one safe to write).
 */

import { customWallpaperIndex } from "@/lib/custom-wallpapers";

/** The neutral wallpaper. On every edition, and the only one on an unknown box. */
export const DEEP_SPACE_WALLPAPER_ID = "deep-space";

export interface BuiltinWallpaper {
  id: string;
  name: string;
  /** The image file, or "" when the tile is painted from `gradient`/`stars`. */
  image: string;
  gradient: string;
  stars: boolean;
  nebula: boolean;
}

const CLAWBOX_WALLPAPER: BuiltinWallpaper = {
  id: "clawbox",
  name: "ClawBox",
  image: "/clawbox-wallpaper.jpeg",
  gradient: "",
  stars: false,
  nebula: false,
};

const HERMES_WALLPAPER: BuiltinWallpaper = {
  id: "hermes",
  name: "Hermes",
  image: "/hermes-wallpaper.jpeg",
  gradient: "",
  stars: false,
  nebula: false,
};

const DEEP_SPACE_WALLPAPER: BuiltinWallpaper = {
  id: DEEP_SPACE_WALLPAPER_ID,
  name: "Deep Space",
  image: "",
  gradient: "bg-gradient-to-br from-[#0a0f1a] via-[#111827] to-[#1a1f2e]",
  stars: true,
  nebula: false,
};

const NEUTRAL_ONLY: readonly BuiltinWallpaper[] = [DEEP_SPACE_WALLPAPER];
const OPENCLAW_WALLPAPERS: readonly BuiltinWallpaper[] = [CLAWBOX_WALLPAPER, DEEP_SPACE_WALLPAPER];
const HERMES_WALLPAPERS: readonly BuiltinWallpaper[] = [HERMES_WALLPAPER, DEEP_SPACE_WALLPAPER];

/**
 * The harness whose branding this device shows, or null while that is not
 * known — from the answer `fetchHarness()` gives.
 *
 * `active` rather than `edition` because the ruling says the dual SKU shows the
 * ACTIVE edition's brand, and `getActiveHarness()` is already that value on
 * every SKU: a single-harness edition is locked to itself, and only an unlocked
 * `dual` resolves a runtime choice.
 *
 * Anything but `editionKnown === true` discards `active` entirely — an absent
 * field included, since a server that predates it did not say. On a box whose
 * lock cannot be read that field is not an independent answer either:
 * `getActiveHarness()` traces back through `lockedHarness()` to the very same
 * file, so it can only echo "openclaw", on a Hermes box as readily as on an
 * OpenClaw one. Taking it would put ClawBox branding on a Hermes device, which
 * is the one outcome the ruling names.
 */
export function brandingHarness(
  info: { active?: string | null; editionKnown?: boolean } | null | undefined,
): string | null {
  if (info?.editionKnown !== true) return null;
  return info.active === "hermes" || info.active === "openclaw" ? info.active : null;
}

/**
 * This edition's own brand wallpaper, or null while the edition is unknown.
 *
 * The null is what makes this the ONLY one of the three answers here that may
 * be WRITTEN. `wp_id` is box-wide SQLite, so a fallback a browser derived from
 * a probe that had not answered is a permanent decision made on a guess — the
 * rule #728 established for the same value. {@link defaultWallpaperId} always
 * names something, which is right for a paint and wrong for a write.
 */
export function brandWallpaperId(harness: string | null): string | null {
  if (harness === "hermes") return HERMES_WALLPAPER.id;
  if (harness === "openclaw") return CLAWBOX_WALLPAPER.id;
  return null;
}

/** The built-in wallpapers this edition offers, in the order they are shown. */
export function builtinWallpapers(harness: string | null): readonly BuiltinWallpaper[] {
  if (harness === "hermes") return HERMES_WALLPAPERS;
  if (harness === "openclaw") return OPENCLAW_WALLPAPERS;
  return NEUTRAL_ONLY;
}

/**
 * What to PAINT when the saved selection cannot be shown on this device — this
 * edition's own brand, or the neutral wallpaper while the edition is unknown.
 *
 * Never written anywhere; see {@link brandWallpaperId}.
 */
export function defaultWallpaperId(harness: string | null): string {
  return brandWallpaperId(harness) ?? DEEP_SPACE_WALLPAPER_ID;
}

/**
 * What is actually on screen for a saved `wp_id`, which is not always what the
 * box holds.
 *
 * Two ways a selection can be unshowable here, and both heal in the RENDER and
 * nowhere else:
 *
 *  - a `custom-<n>` this browser cannot answer. The pictures live in one
 *    browser's `localStorage` while `wp_id` is box-wide, so an id past the end
 *    of THIS list is almost always another browser's, still resolving perfectly
 *    there (#728). `customWallpaperCount` is null while this browser's list has
 *    not been read yet — every `custom-<n>` would be out of range against an
 *    empty initial state, and a good selection would flash the default on load.
 *  - a built-in this edition does not ship: the other product's brand, from a
 *    box re-imaged onto the other edition or a choice made before the ruling.
 *    It resolves to this edition's own art, and the stored value stays put —
 *    the owner's next explicit pick is what replaces it.
 *
 * An empty `savedId` — nothing chosen yet — takes the same path as an unknown
 * one and lands on the default.
 */
export function renderedWallpaperId(
  savedId: string,
  harness: string | null,
  customWallpaperCount: number | null,
): string {
  const customIndex = customWallpaperIndex(savedId);
  if (customIndex !== null) {
    if (customWallpaperCount === null) return savedId;
    return customIndex < customWallpaperCount ? savedId : defaultWallpaperId(harness);
  }
  return builtinWallpapers(harness).some((wp) => wp.id === savedId)
    ? savedId
    : defaultWallpaperId(harness);
}
