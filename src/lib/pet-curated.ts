// ── The curated Petdex shortlist ClawBox offers ──
//
// NAMES ONLY. No sprite bytes live in this repository and none ever will —
// see the licensing note below.
//
// LICENSING (read before adding anything here)
// --------------------------------------------
// Petdex's *code* is MIT, but its *art* is not covered by any blanket grant:
// "Pet assets are owned by their submitters under whatever license they choose
// to declare", "Pets are user-submitted fan art. Petdex does not claim rights
// to any underlying IP", plus a 48-hour takedown process. There is no per-pet
// license field in the manifest or in pet.json.
//
// So ClawBox must not redistribute any of it. Sprites are downloaded at
// runtime, by an explicit user action, onto that user's own device — by the
// `hermes pets install` CLI that is already on the box. We add no
// redistribution of our own: nothing is bundled into this PUBLIC repo and
// nothing is baked into the device image. That is exactly upstream Hermes'
// posture (the only sprite committed to hermes-agent is its own MIT
// `pet-egg-sheet.png`).
//
// The gallery upstream exposes has ~4578 pets, of which 2297 are `character`
// kind — a large share recognisable fan art of protected characters. A hobby
// gallery with a takedown queue can absorb that; a shipping appliance vendor
// cannot. ClawBox therefore offers only the CURATED pets — the ones Petdex
// serves from its own `assets.petdex.dev/curated/<slug>/` namespace rather
// than from the user-submission bucket — and links out to petdex.dev for the
// rest, instead of mirroring the gallery in-product.
//
// WHY THIRTEEN AND NOT SIXTEEN
// ----------------------------
// The manifest lists sixteen slugs against that curated namespace, but three
// of them — `daemon-dumpling`, `skipper`, `captain-quack` — are not pets at
// all. All three point their `spritesheetUrl` at `curated/cash-cuy/…` and
// their `petJsonUrl` at `pets/sabo-…/petjson.json`, so installing any of them
// downloads Cash Cuy's art and lands a `pet.json` that identifies itself as
// "Sabo": the tile renames itself after install and wears the wrong body.
// They are broken upstream, not here, so they are simply not offered.
//
// The obvious repair — backfilling with three pets from the general gallery —
// was rejected: the submitter is not a sufficient filter (`railly` also
// submitted `shadcn`, `conan` and `duo`, which are recognisable likenesses of
// other people's IP). The `/curated/` namespace is the boundary that actually
// carries the licensing argument above, so the list shrinks rather than
// reaching outside it.

/** Which file Petdex serves a curated pet's sheet under. Not guessable — see
 *  `petdex-manifest.ts`: seven curated pets use `sprite-v2.webp` and six use
 *  `spritesheet.webp`, and this field is only the OFFLINE fallback for the
 *  manifest's own `spritesheetUrl`. */
export type CuratedSheetFile = "sprite-v2.webp" | "spritesheet.webp";

export interface CuratedPet {
  slug: string;
  displayName: string;
  kind: "character" | "creature" | "object";
  /** Shown in the picker — Petdex asks that pets keep credit to their authors. */
  submittedBy: string;
  /** Last-resort sheet filename when the manifest cannot be reached. */
  sheetFile: CuratedSheetFile;
}

/** Where users go for the full gallery. We link; we do not mirror. */
export const PETDEX_URL = "https://petdex.dev";

export const CURATED_PETS: readonly CuratedPet[] = [
  { slug: "nukey", displayName: "Nukey", kind: "object", submittedBy: "railly", sheetFile: "sprite-v2.webp" },
  { slug: "socksy", displayName: "Socksy", kind: "character", submittedBy: "railly", sheetFile: "sprite-v2.webp" },
  { slug: "cache-capy", displayName: "Cache Capy", kind: "creature", submittedBy: "railly", sheetFile: "sprite-v2.webp" },
  { slug: "cosmo", displayName: "Crafternauta", kind: "character", submittedBy: "railly", sheetFile: "sprite-v2.webp" },
  { slug: "boba", displayName: "Boba", kind: "creature", submittedBy: "railly", sheetFile: "sprite-v2.webp" },
  { slug: "pixel-panda", displayName: "Pixel Panda", kind: "creature", submittedBy: "railly", sheetFile: "sprite-v2.webp" },
  { slug: "kebo", displayName: "Kebo", kind: "creature", submittedBy: "railly", sheetFile: "sprite-v2.webp" },
  { slug: "byte-bunny", displayName: "Byte Bunny", kind: "creature", submittedBy: "railly", sheetFile: "spritesheet.webp" },
  { slug: "cash-cuy", displayName: "Cash Cuy", kind: "creature", submittedBy: "railly", sheetFile: "spritesheet.webp" },
  { slug: "boxcat", displayName: "Boxcat", kind: "creature", submittedBy: "railly", sheetFile: "spritesheet.webp" },
  { slug: "prompt-penguin", displayName: "Prompt Penguin", kind: "creature", submittedBy: "railly", sheetFile: "spritesheet.webp" },
  { slug: "noir-webling", displayName: "Noir Webling", kind: "creature", submittedBy: "railly", sheetFile: "spritesheet.webp" },
  { slug: "scoop", displayName: "Scoop", kind: "object", submittedBy: "railly", sheetFile: "spritesheet.webp" },
];

const BY_SLUG = new Map(CURATED_PETS.map((p) => [p.slug, p]));

export function curatedPet(slug: string): CuratedPet | undefined {
  return BY_SLUG.get(slug);
}

/**
 * The sheet URL to try when the Petdex manifest is unreachable.
 *
 * A URL is not art: this is the same address `hermes pets install` would hit,
 * written down so an offline box still renders a picker instead of thirteen
 * name-only tiles. Nothing is bundled and nothing is mirrored.
 */
export function curatedFallbackSheetUrl(slug: string): string | null {
  const pet = BY_SLUG.get(slug);
  return pet ? `https://assets.petdex.dev/curated/${pet.slug}/${pet.sheetFile}` : null;
}

/**
 * The pet a fresh Hermes box lands on once the user opts in.
 *
 * Nothing is installed automatically — the first install needs ~2.2 MB of
 * internet and a deliberate click — but the picker highlights this one so
 * "just give me a pet" is a single tap.
 */
export const DEFAULT_PET_SLUG = "boba";
