export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { hasHermesHarness } from "@/lib/edition-source";
import { curatedPet } from "@/lib/pet-curated";
import {
  activePetDescriptor,
  disablePet,
  safePetSlug,
  selectPet,
} from "@/lib/hermes-pets";

/**
 * POST /setup-api/pets/select  { slug: string }   — install if needed, activate
 * POST /setup-api/pets/select  { slug: null }     — `hermes pets off`
 *
 * Writes go through the `hermes pets` CLI, never into config.yaml directly, so
 * ClawBox and the terminal surfaces cannot disagree about the active pet.
 *
 * The install leg downloads ~2.2 MB from Petdex and can take a while on a home
 * link; the CLI call is given 120 s (the shared helper's default is 30 s, which
 * would abort mid-download and leave a partial pet directory behind).
 */
export async function POST(request: Request) {
  if (!hasHermesHarness()) {
    return NextResponse.json({ error: "Pets need the Hermes edition" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const raw = (body as { slug?: unknown } | null)?.slug;
  if (raw === null || raw === "" || raw === undefined) {
    const outcome = await disablePet();
    if (!outcome.ok) return NextResponse.json({ error: "Could not turn the pet off" }, { status: 500 });
    return NextResponse.json({ ok: true, active: null });
  }

  const slug = safePetSlug(raw);
  if (!slug) return NextResponse.json({ error: "Invalid pet" }, { status: 400 });

  const outcome = await selectPet(slug);
  if (!outcome.ok) {
    // Fixed strings: the CLI's own stderr can carry filesystem paths and
    // upstream internals, so it is logged (in selectPet) and never returned.
    const message =
      outcome.reason === "hermes-missing"
        ? "Hermes is not installed on this device"
        : outcome.reason === "install-failed"
          ? "Could not download that pet"
          : "Could not switch to that pet";
    return NextResponse.json({ error: message, reason: outcome.reason }, { status: 502 });
  }

  const active = await activePetDescriptor((s) => curatedPet(s)?.submittedBy ?? "");
  return NextResponse.json({ ok: true, active });
}
