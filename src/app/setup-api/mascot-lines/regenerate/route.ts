import { NextResponse } from "next/server";
import { forceRegenerate } from "@/lib/mascot-phrases-server";

export const dynamic = "force-dynamic";

/**
 * POST /setup-api/mascot-lines/regenerate
 *
 * Forces a fresh full regen of the mascot phrase set in the user's
 * selected language, ignoring cache age. Used by Settings ("refresh
 * mascot phrases" button) and by anything that wants to immediately
 * reflect a language change.
 *
 * Returns:
 *  - 200 { ok: true, phrases } on success
 *  - 200 { ok: false, reason } if no local model is available — caller
 *    should keep using whatever they had (the inspiration fallback)
 */
export async function POST() {
  try {
    const phrases = await forceRegenerate();
    if (!phrases) {
      return NextResponse.json({
        ok: false,
        reason: "No local LLM available. Pull an Ollama model (Settings → Local AI) and retry.",
      });
    }
    return NextResponse.json({ ok: true, phrases });
  } catch (err) {
    // Don't let an Ollama hiccup or KV write failure bubble out as an
    // unhandled 500 from Next; surface a structured reason the UI can
    // show alongside the existing "no LLM" branch.
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
