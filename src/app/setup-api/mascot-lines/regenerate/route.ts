import { NextResponse } from "next/server";
import { isPreferenceLanguage } from "@/lib/preference-schema";
import { forceRegenerate } from "@/lib/mascot-phrases-server";

export const dynamic = "force-dynamic";

/**
 * POST /setup-api/mascot-lines/regenerate?locale=<locale>
 *
 * Forces a fresh full regen of the mascot phrase set for the given locale
 * (falling back to `pref:ui_language`, then English), ignoring cache age.
 *
 * Returns:
 *  - 200 { ok: true, phrases } on success
 *  - 200 { ok: false, reason } when the on-device model cannot run right now
 *    (busy serving the user's chat, not enough free RAM, or — until the local
 *    generation hook lands — not implemented). The caller keeps whatever it
 *    had; the locale's pack is a correct answer, just a static one.
 */
export async function POST(request: Request) {
  try {
    const requested = new URL(request.url).searchParams.get("locale");
    const locale = isPreferenceLanguage(requested) ? requested : null;
    const phrases = await forceRegenerate(locale);
    if (!phrases) {
      return NextResponse.json({
        ok: false,
        reason: "On-device phrase generation is unavailable right now. The mascot keeps using its built-in phrases.",
      });
    }
    return NextResponse.json({ ok: true, phrases });
  } catch (err) {
    // Don't let a model hiccup or KV write failure bubble out as an unhandled
    // 500 from Next; surface a structured reason the UI can show alongside
    // the existing "unavailable" branch.
    console.error("[mascot-lines/regenerate] forceRegenerate threw:", err);
    return NextResponse.json(
      {
        ok: false,
        reason: err instanceof Error ? err.message : "Mascot phrase regen failed",
      },
      { status: 500 },
    );
  }
}
