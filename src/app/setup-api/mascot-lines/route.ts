import { NextResponse } from "next/server";
import { isPreferenceLanguage } from "@/lib/preference-schema";
import { getMascotPhrases } from "@/lib/mascot-phrases-server";
import { hasHermesHarness } from "@/lib/edition-source";
import { isPetActive } from "@/lib/hermes-pets";
import { petSafePhrases } from "@/lib/mascot-pet-voice";

export const dynamic = "force-dynamic";

/**
 * Who is speaking. An OpenClaw box short-circuits to the crab without touching
 * the Hermes config at all, so nothing about the pet subsystem runs there.
 */
async function speakerIsPet(): Promise<boolean> {
  if (!hasHermesHarness()) return false;
  return isPetActive();
}

/**
 * GET /setup-api/mascot-lines?locale=<locale>
 *
 * Returns the categorized phrase set the mascot speaks, in the requested UI
 * locale. `?locale` is authoritative when it names a locale the device ships
 * (INV-5) — the client knows which language it is currently rendering, which
 * can be ahead of the stored `pref:ui_language` by a few hundred milliseconds
 * right after a language switch. An unknown/absent value falls back to the
 * stored preference, then to English.
 *
 * The set is always complete and always in that locale: generated phrases
 * where the local model has produced any, the locale's hand-written pack
 * otherwise, and the language-free neutral pack as the floor.
 *
 * Response:
 * {
 *   phrases: MascotPhraseSet
 *   meta: { source: "pack" | "local", reason, locale, validatorVersion,
 *           lastFullRegen, lastTopUp }
 * }
 *
 * The legacy `lines` / `date` fields are gone along with the chat snippet
 * capture that fed them.
 */
export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("locale");
  const locale = isPreferenceLanguage(requested) ? requested : null;
  try {
    const { phrases, meta } = await getMascotPhrases(locale);
    // A pet never speaks as a crab — in any category, in any locale. Filtered
    // here as well as on the client because this response is the mascot's
    // whole vocabulary for the session, and a bubble is picked from it long
    // after the fetch. The crab is served the set untouched.
    const pet = await speakerIsPet();
    return NextResponse.json({
      phrases: pet ? await petSafePhrases(phrases, meta.locale) : phrases,
      meta: { ...meta, voice: pet ? "pet" : "crab" },
    });
  } catch (err) {
    // `getMascotPhrases` touches the KV file, the config store and a dynamic
    // pack import; a failure in any of those should be logged once and return
    // a structured 500, not bubble out as an unhandled Next error. The client
    // already falls back to its in-memory pack when this is not a 200.
    // The exception stays in the server log — its message can carry filesystem
    // paths and other internals, so the client gets a fixed string.
    console.error("[mascot-lines] getMascotPhrases threw:", err);
    return NextResponse.json({ error: "Failed to load mascot phrases" }, { status: 500 });
  }
}
