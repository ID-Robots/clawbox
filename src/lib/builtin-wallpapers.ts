/**
 * The wallpapers a ClawBox ships with, and which of them THIS edition offers.
 *
 * The owner's ruling (2026-09-06): "Remove the Hermes wallpaper from the
 * OpenClaw version. And vice versa — the ClawBox wallpaper from the Hermes
 * version." So the built-in list is edition-scoped — the OpenClaw edition
 * offers its own brand (Lobster Orbital, the default since 2026-09-15, and the
 * older ClawBox picture, still selectable) plus the neutral Deep Space, the
 * Hermes edition offers the Hermes art plus Deep Space, the premium `dual` SKU
 * follows whichever harness is active, and the pictures the owner uploaded are
 * on every edition. A customer never sees the other product's artwork on a box
 * they bought.
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
 * and, on the one SKU that leaves the harness open, the config store — and
 * `null` means NOBODY HAS SAID YET. That covers four real states: the probe is
 * still in flight, the probe failed, the lock exists but no edition could be
 * read out of it, and a licensed `dual` box whose config store could not be
 * read. All four are the same question to this module, and the answer is the
 * same: show the neutral wallpaper only.
 *
 * That is the fail-closed direction, and it is chosen rather than inherited.
 * Both of those reads collapse "nobody could answer" into "openclaw" — the
 * right default for "which SKU is this", where guessing the non-premium answer
 * is the safe way to be wrong, and the WRONG one here, where the guess is a
 * competitor's picture across the customer's screen. So the route reports
 * whether `active` is a fact (`activeKnown`, from `getActiveHarnessSource`) and
 * this module refuses to brand a box on a guess.
 *
 * PAINTING vs PERSISTING is the rule PR #728 established for the same values
 * and it holds here: a guess is fine to paint, because the paint corrects itself
 * the moment the device answers, and is never fine to write to `wp_id` — that
 * key is box-wide SQLite, so a browser writing its guess there decides for every
 * other browser and for the box's own screen, permanently. That is the whole
 * difference between `defaultWallpaperId` (always names one) and
 * `brandWallpaperId` (null on a doubt, and so the only one safe to write).
 *
 * The same rule holds for a wallpaper's OPACITY. A built-in may carry a
 * `defaultOpacity` — the strength its picture is meant to be painted at when
 * the owner has never moved the slider (Lobster Orbital is a 50% picture: at
 * full strength it swallows the icons) — and `wallpaperOpacity` is the one
 * reader: a saved `wp_opacity` always wins, the wallpaper's own default comes
 * next, then the desktop's general default. It is painted and handed to the
 * slider, and never written to the store — a default that reached `wp_opacity`
 * would follow the owner onto every other wallpaper, and would still be there
 * after the default itself changed.
 */

import { customWallpaperIndex } from "@/lib/custom-wallpapers";

/** The neutral wallpaper. On every edition, and the only one on an unknown box. */
export const DEEP_SPACE_WALLPAPER_ID = "deep-space";

/**
 * Deeply readonly: the three entries below are module-level singletons handed to
 * every surface at once, so a field write would corrupt the painted background,
 * both Appearance grids and the Appearance subtitle together.
 */
export interface BuiltinWallpaper {
  readonly id: string;
  readonly name: string;
  /** The image file, or "" when the tile is painted from `gradient`/`stars`. */
  readonly image: string;
  readonly gradient: string;
  readonly stars: boolean;
  readonly nebula: boolean;
  /**
   * The opacity (0–100) this picture is painted at while the box has NO saved
   * `wp_opacity`. Absent means {@link DEFAULT_WALLPAPER_OPACITY}. Never
   * persisted — see {@link wallpaperOpacity}.
   */
  readonly defaultOpacity?: number;
}

/** What every wallpaper without a `defaultOpacity` of its own is painted at. */
export const DEFAULT_WALLPAPER_OPACITY = 50;

/**
 * The OpenClaw edition's default wallpaper (2026-09-15): a 3840×2160 picture
 * the owner supplies as `public/lobster-orbital-wallpaper.jpeg`, meant to be
 * seen at half strength.
 */
export const LOBSTER_ORBITAL_WALLPAPER: BuiltinWallpaper = {
  id: "lobster-orbital",
  name: "Lobster Orbital",
  image: "/lobster-orbital-wallpaper.jpeg",
  gradient: "",
  stars: false,
  nebula: false,
  defaultOpacity: 50,
};

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
// The Hermes picture is offered on an OpenClaw box as well (owner's ruling
// 2026-09-15: "it needs to be available for both hermes and openclaw"), which
// narrows the 2026-09-06 rule to the other direction — a Hermes box still
// shows no ClawBox art, and the DEFAULT on each edition is still its own brand.
const OPENCLAW_WALLPAPERS: readonly BuiltinWallpaper[] = [LOBSTER_ORBITAL_WALLPAPER, CLAWBOX_WALLPAPER, HERMES_WALLPAPER, DEEP_SPACE_WALLPAPER];
const HERMES_WALLPAPERS: readonly BuiltinWallpaper[] = [HERMES_WALLPAPER, DEEP_SPACE_WALLPAPER];

/**
 * The harness whose branding this device shows, or null while that is not
 * known — from the answer `fetchHarness()` gives.
 *
 * `active` rather than `edition` because the ruling says the dual SKU shows the
 * ACTIVE edition's brand, and that value is already the active edition on every
 * SKU: a single-harness edition is locked to itself, and only an unlocked
 * `dual` resolves a runtime choice.
 *
 * Anything but `activeKnown === true` discards `active` entirely — an absent
 * field included, since a server that predates it did not say. Where `active`
 * is a fallback it is a fallback to "openclaw" whatever the box really is, so
 * taking it would put ClawBox branding on a Hermes device, which is the one
 * outcome the ruling names.
 */
export function brandingHarness(
  info: { active?: string | null; activeKnown?: boolean } | null | undefined,
): string | null {
  if (info?.activeKnown !== true) return null;
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
  if (harness === "openclaw") return LOBSTER_ORBITAL_WALLPAPER.id;
  return null;
}

/**
 * What OPACITY to paint — and to show on the slider — for the wallpaper on
 * screen. A saved `wp_opacity` (`null` while the box holds none) always wins;
 * otherwise the wallpaper's own `defaultOpacity`, then the general default.
 * `wallpaper` is undefined for an uploaded picture, which has no default of
 * its own. The answer is never written back: see the module comment.
 */
export function wallpaperOpacity(
  saved: number | null,
  wallpaper: { readonly defaultOpacity?: number } | undefined,
): number {
  if (saved !== null && Number.isFinite(saved)) return saved;
  return wallpaper?.defaultOpacity ?? DEFAULT_WALLPAPER_OPACITY;
}

/**
 * {@link wallpaperOpacity} for the wallpaper actually ON SCREEN — the one
 * `renderedWallpaperId` names — looked up in this edition's list. An uploaded
 * picture (`custom-<n>`) is not in that list and has no default of its own;
 * it must not inherit the first built-in's. Both pages call this rather than
 * looking the entry up themselves, so the two cannot drift.
 */
export function paintedWallpaperOpacity(
  saved: number | null,
  renderedId: string,
  wallpapers: readonly BuiltinWallpaper[],
): number {
  if (customWallpaperIndex(renderedId) !== null) return wallpaperOpacity(saved, undefined);
  return wallpaperOpacity(saved, wallpapers.find((wp) => wp.id === renderedId));
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
 * A null `savedId` — nothing chosen yet — takes the same path as an unknown one
 * and lands on the default.
 */
export function renderedWallpaperId(
  savedId: string | null,
  harness: string | null,
  customWallpaperCount: number | null,
): string {
  if (savedId === null) return defaultWallpaperId(harness);
  const customIndex = customWallpaperIndex(savedId);
  if (customIndex !== null) {
    if (customWallpaperCount === null) return savedId;
    return customIndex < customWallpaperCount ? savedId : defaultWallpaperId(harness);
  }
  return builtinWallpapers(harness).some((wp) => wp.id === savedId)
    ? savedId
    : defaultWallpaperId(harness);
}
