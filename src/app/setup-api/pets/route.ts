export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { hasHermesHarness, readEdition } from "@/lib/edition-source";
import { CURATED_PETS, curatedPet, DEFAULT_PET_SLUG, PETDEX_URL } from "@/lib/pet-curated";
import {
  activePetDescriptor,
  installedPets,
  readPetConfig,
  type PetConfig,
  type PetDescriptor,
} from "@/lib/hermes-pets";

/**
 * GET /setup-api/pets            — what the mascot needs (active pet, or null)
 * GET /setup-api/pets?gallery=1  — plus the picker's list
 *
 * Edition gate: pets are a Hermes feature and the `hermes` binary does not
 * exist on an OpenClaw box, so an OpenClaw device answers `supported: false`
 * and nothing else. That is the ONE check the client needs — no pet code
 * mounts, no pet route does any work, and the crab keeps the desktop exactly
 * as it has it today.
 *
 * Fail-open throughout: a pet is decoration, and a decoration must never be the
 * reason a desktop fails to render. Every unhappy path answers 200 with
 * `active: null`, which the mascot reads as "no pet".
 */
export async function GET(request: Request) {
  const edition = readEdition();
  if (!hasHermesHarness()) {
    return NextResponse.json({ supported: false, edition, enabled: false, active: null, pets: [] });
  }

  const wantGallery = new URL(request.url).searchParams.get("gallery") === "1";

  let config: PetConfig = { enabled: false, slug: "" };
  let active: PetDescriptor | null = null;
  try {
    config = await readPetConfig();
    active = await activePetDescriptor((slug) => curatedPet(slug)?.submittedBy ?? "");
  } catch (err) {
    console.warn("[pets] gallery read failed:", err);
  }

  if (!wantGallery) {
    return NextResponse.json({
      supported: true,
      edition,
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
  const installed = new Map(installedPets().map((p) => [p.slug, p]));
  const pets = [
    ...CURATED_PETS.map((p) => ({
      slug: p.slug,
      displayName: installed.get(p.slug)?.displayName || p.displayName,
      kind: p.kind,
      submittedBy: p.submittedBy,
      curated: true,
      installed: installed.has(p.slug),
    })),
    ...[...installed.values()]
      .filter((p) => !curatedPet(p.slug))
      .map((p) => ({
        slug: p.slug,
        displayName: p.displayName,
        kind: "creature" as const,
        submittedBy: p.createdBy === "generator" ? "you" : "",
        curated: false,
        installed: true,
      })),
  ];

  return NextResponse.json({
    supported: true,
    edition,
    enabled: config.enabled,
    activeSlug: active?.slug ?? "",
    active,
    defaultSlug: DEFAULT_PET_SLUG,
    galleryUrl: PETDEX_URL,
    pets,
  });
}
