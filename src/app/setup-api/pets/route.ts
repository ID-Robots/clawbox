export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { readEdition } from "@/lib/edition-source";
import { BUILTIN_PETS, builtinPet } from "@/lib/pet-builtin";
import { CURATED_PETS, curatedPet, DEFAULT_PET_SLUG, petAuthor, PETDEX_URL } from "@/lib/pet-curated";
import {
  activePetDescriptor,
  builtinInstalledPets,
  installedPets,
  mascotPlaceholder,
  readPetConfig,
  type PetConfig,
  type PetDescriptor,
} from "@/lib/hermes-pets";

/**
 * GET /setup-api/pets            — what the mascot needs (active pet, or null)
 * GET /setup-api/pets?gallery=1  — plus the picker's list
 *
 * Every edition answers `supported: true` — the picker has been on OpenClaw
 * since 2026-09-07, on ClawBox's own store rather than the `hermes` CLI. What
 * the edition still decides is `placeholder`: the body worn with NOTHING
 * picked, which is the ClawBox crab (`vibrant-clawd`, shipped in this repo)
 * wherever ClawBox's own harness runs and the egg on a Hermes-only box.
 *
 * Fail-open throughout: a pet is decoration, and a decoration must never be the
 * reason a desktop fails to render. Every unhappy path answers 200 with
 * `active: null`, which the mascot reads as "no pet".
 */
export async function GET(request: Request) {
  const edition = readEdition();
  // What the desktop wears with NO pet picked: the crab wherever ClawBox's own
  // harness runs (openclaw, dual), the egg on a Hermes-only box — the crab is
  // ClawBox's brand and is not a stand-in on someone else's harness. Since
  // 2026-09-17 that crab is itself a pet (`vibrant-clawd`), so the answer is
  // owned by hermes-pets.ts, which also resolves the body it names.
  const placeholder = mascotPlaceholder();

  const wantGallery = new URL(request.url).searchParams.get("gallery") === "1";

  let config: PetConfig = { enabled: false, slug: "" };
  let active: PetDescriptor | null = null;
  try {
    config = await readPetConfig();
    active = await activePetDescriptor(petAuthor);
  } catch (err) {
    console.warn("[pets] gallery read failed:", err);
  }

  if (!wantGallery) {
    return NextResponse.json({
      supported: true,
      edition,
      placeholder,
      enabled: config.enabled,
      activeSlug: active?.slug ?? "",
      active,
    });
  }

  // The list is the curated shortlist UNION whatever is actually on disk, so a
  // pet installed from the CLI (or generated locally) is still selectable here
  // even though ClawBox never offered it. Installed-state comes from the
  // filesystem rather than from the Petdex manifest, so this whole response is
  // correct with no internet at all — the offline fail-open upstream's
  // `pet.gallery` has, without needing the fallback.
  // Both stores: the harness's own, and the packs ClawBox ships. They are
  // separate lists on purpose (see `builtinInstalledPets`) and only the gallery
  // wants them merged — an owner's own copy of a bundled slug wins, which is
  // the same precedence `loadPet` applies.
  const installed = new Map([...builtinInstalledPets(), ...installedPets()].map((p) => [p.slug, p]));
  const pets = [
    // Ours first: a pet that ships with the product needs no download, works
    // offline on a box that has never had a network, and is the default body.
    ...BUILTIN_PETS.map((p) => ({
      slug: p.slug,
      // OURS, not the copy's — the one place the merged-installed precedence
      // above is deliberately not applied. A box whose owner picked the crab
      // before it was renamed keeps a materialised `pet.json` still saying
      // "Vibrant Clawd", and the copy is never refreshed (`materialiseBuiltinPet`
      // skips a destination that exists), so the gallery went on showing the
      // old name for a pack ClawBox itself ships and itself names. Only the
      // NAME is taken back: `installed` still decides whether the pack is
      // there, and `loadPet` still serves the owner's own copy of the body.
      displayName: p.displayName,
      kind: p.kind,
      submittedBy: p.submittedBy,
      curated: true,
      builtin: true,
      // From the filesystem, like every other tile: a build whose bundled pack
      // did not survive the copy must not claim the pet is there.
      installed: installed.has(p.slug),
    })),
    ...CURATED_PETS.map((p) => ({
      slug: p.slug,
      displayName: installed.get(p.slug)?.displayName || p.displayName,
      kind: p.kind,
      submittedBy: p.submittedBy,
      curated: true,
      builtin: false,
      installed: installed.has(p.slug),
    })),
    ...[...installed.values()]
      .filter((p) => !curatedPet(p.slug) && !builtinPet(p.slug))
      .map((p) => ({
        slug: p.slug,
        displayName: p.displayName,
        kind: "creature" as const,
        submittedBy: p.createdBy === "generator" ? "you" : "",
        curated: false,
        builtin: false,
        installed: true,
      })),
  ];

  return NextResponse.json({
    supported: true,
    edition,
    placeholder,
    enabled: config.enabled,
    activeSlug: active?.slug ?? "",
    active,
    defaultSlug: DEFAULT_PET_SLUG,
    galleryUrl: PETDEX_URL,
    pets,
  });
}
