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
// cannot. ClawBox therefore offers only the sixteen CURATED pets (submitted by
// `railly` / `Petdex seed`, i.e. first-party to Petdex rather than fan art of
// someone else's IP) and links out to petdex.dev for the rest, instead of
// mirroring the gallery in-product.

export interface CuratedPet {
  slug: string;
  displayName: string;
  kind: "character" | "creature" | "object";
  /** Shown in the picker — Petdex asks that pets keep credit to their authors. */
  submittedBy: string;
}

/** Where users go for the full gallery. We link; we do not mirror. */
export const PETDEX_URL = "https://petdex.dev";

export const CURATED_PETS: readonly CuratedPet[] = [
  { slug: "nukey", displayName: "Nukey", kind: "object", submittedBy: "railly" },
  { slug: "socksy", displayName: "Socksy", kind: "character", submittedBy: "railly" },
  { slug: "cache-capy", displayName: "Cache Capy", kind: "creature", submittedBy: "railly" },
  { slug: "cosmo", displayName: "Crafternauta", kind: "character", submittedBy: "railly" },
  { slug: "daemon-dumpling", displayName: "Daemon Dumpling", kind: "creature", submittedBy: "Petdex seed" },
  { slug: "boba", displayName: "Boba", kind: "creature", submittedBy: "railly" },
  { slug: "skipper", displayName: "Skipper", kind: "creature", submittedBy: "Petdex seed" },
  { slug: "captain-quack", displayName: "Captain Quack", kind: "creature", submittedBy: "Petdex seed" },
  { slug: "pixel-panda", displayName: "Pixel Panda", kind: "creature", submittedBy: "railly" },
  { slug: "byte-bunny", displayName: "Byte Bunny", kind: "creature", submittedBy: "railly" },
  { slug: "cash-cuy", displayName: "Cash Cuy", kind: "creature", submittedBy: "railly" },
  { slug: "boxcat", displayName: "Boxcat", kind: "creature", submittedBy: "railly" },
  { slug: "prompt-penguin", displayName: "Prompt Penguin", kind: "creature", submittedBy: "railly" },
  { slug: "noir-webling", displayName: "Noir Webling", kind: "creature", submittedBy: "railly" },
  { slug: "scoop", displayName: "Scoop", kind: "object", submittedBy: "railly" },
  { slug: "kebo", displayName: "Kebo", kind: "creature", submittedBy: "railly" },
];

const BY_SLUG = new Map(CURATED_PETS.map((p) => [p.slug, p]));

export function curatedPet(slug: string): CuratedPet | undefined {
  return BY_SLUG.get(slug);
}

/**
 * The pet a fresh Hermes box lands on once the user opts in.
 *
 * Nothing is installed automatically — the first install needs ~2.2 MB of
 * internet and a deliberate click — but the picker highlights this one so
 * "just give me a pet" is a single tap.
 */
export const DEFAULT_PET_SLUG = "boba";
