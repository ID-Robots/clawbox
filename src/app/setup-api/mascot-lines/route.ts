import { NextResponse } from "next/server";
import { isPreferenceLanguage } from "@/lib/preference-schema";
import { getMascotPhrases } from "@/lib/mascot-phrases-server";

export const dynamic = "force-dynamic";

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
    return NextResponse.json({ phrases, meta });
  } catch (err) {
    // `getMascotPhrases` touches the KV file, the config store and a dynamic
    // pack import; a failure in any of those should be logged once and return
    // a structured 500, not bubble out as an unhandled Next error. The client
    // already falls back to its in-memory pack when this is not a 200.
    console.error("[mascot-lines] getMascotPhrases threw:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load mascot phrases" },
      { status: 500 },
    );
  }
}
