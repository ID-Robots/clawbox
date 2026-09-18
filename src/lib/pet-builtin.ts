// ── The pets ClawBox SHIPS ──
//
// `pet-curated.ts` is the shortlist of OTHER PEOPLE's pets: names only, art
// downloaded on the owner's click, nothing mirrored. That rule is about
// redistribution, and it is unchanged. This file is the other side of it —
// artwork that is ours, drawn for this product, and therefore bundled.
//
// Today there is exactly one: `vibrant-clawd`, the ClawBox crab as a nine-state
// Petdex pack (public/pets/vibrant-clawd/, credit and sheet geometry in
// CREDIT.txt beside it). It is the brand body — what an OpenClaw or dual box
// wears with no pet picked, where the still crab PNG used to be drawn — so on
// those editions it is not a tile BESIDE the crab in the picker: it is the crab
// tile, first in the grid and selected by default. On a Hermes-only box, where
// the bare desktop wears the egg instead, it stays an ordinary gallery tile the
// owner can pick, un-pick and come back to.
//
// Deliberately free of Node imports: the picker, the mascot and `pet-client`
// all read these names in the browser. Where the bytes are on disk is a server
// question and lives in `hermes-pets.ts` (`builtinPetDir`).

/** The ClawBox crab, as a pet. */
export const VIBRANT_CLAWD_SLUG = "vibrant-clawd";

export interface BuiltinPet {
  slug: string;
  displayName: string;
  kind: "character" | "creature" | "object";
  /** Shown in the picker, exactly as a curated pet's author is. */
  submittedBy: string;
  /** Pack version, for the credit file and the report — not a cache key: the
   *  sheet's `{mtime}:{size}` revision is what busts the browser's cache. */
  version: string;
}

export const BUILTIN_PETS: readonly BuiltinPet[] = [
  {
    slug: VIBRANT_CLAWD_SLUG,
    // The crab's own name, not the pack's working title: this IS the ClawBox
    // crab (owner, 2026-09-18), it is the first tile in the picker, and the
    // `hermes pets` CLI, the TUI and the upstream desktop app read the same
    // name out of pet.json. The SLUG stays `vibrant-clawd` — it is the
    // directory every store already holds the pack under.
    displayName: "ClawBox crab",
    kind: "creature",
    submittedBy: "ID-Robots",
    version: "2.1.0",
  },
];

const BY_SLUG = new Map(BUILTIN_PETS.map((p) => [p.slug, p]));

export function builtinPet(slug: string): BuiltinPet | undefined {
  return BY_SLUG.get(slug);
}

/** True for a pet whose sprites ship in this repository. Such a pet is never
 *  downloaded, never fetched from Petdex, and cannot be uninstalled. */
export function isBuiltinPet(slug: string): boolean {
  return BY_SLUG.has(slug);
}
