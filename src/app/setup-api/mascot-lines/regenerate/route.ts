import { NextResponse } from "next/server";
import { isPreferenceLanguage } from "@/lib/preference-schema";
import { forceRegenerate, type ForceRegenerateReason } from "@/lib/mascot-phrases-server";

export const dynamic = "force-dynamic";

/**
 * One message per outcome. These used to collapse into a single "unavailable
 * right now" string, so a busy model, a memory-pressured box and a model
 * answering with junk were byte-identical responses — and a Settings button
 * wired to this could not tell the user which of the three had happened.
 */
const MESSAGES: Record<ForceRegenerateReason, string> = {
  generated: "Fresh phrases generated on the device.",
  // These two are NOT one message. "Busy with your chat" shown while the box
  // was quietly refreshing the crab's own phrases told the owner something
  // they could see was untrue — and it is the second one that a Settings
  // button hits most often, because the page's own background refresh may
  // have taken the lock moments earlier.
  "chat-busy": "The on-device model is busy with your chat. Try again in a minute.",
  "refresh-in-progress": "A mascot phrase refresh is already running. Give it a minute.",
  "generation-disabled-for-locale":
    "Phrase generation runs in English only. In this language the mascot uses its hand-written phrases.",
  "low-memory": "Not enough free memory to load the model right now. Try again shortly.",
  unavailable: "Local AI is switched off or no model is installed, so the mascot keeps its built-in phrases.",
  timeout: "The on-device model took too long to answer. The mascot keeps its built-in phrases.",
  transport: "Could not reach the on-device model. The mascot keeps its built-in phrases.",
  malformed: "The on-device model did not return usable phrases. The mascot keeps its built-in phrases.",
  // Not a failure of the box, and it must not read like one: the model ran and
  // answered, it just repeated lines the crab already had.
  "no-new-phrases":
    "The on-device model only came up with phrases the mascot already knows. Nothing new this time.",
};

/** Only "generated" produced anything; everything else leaves the pack in place. */
function sourceFor(reason: ForceRegenerateReason): "pack" | "local" {
  return reason === "generated" ? "local" : "pack";
}

/**
 * POST /setup-api/mascot-lines/regenerate?locale=<locale>
 *
 * Forces a fresh full regen of the mascot phrase set for the given locale
 * (falling back to `pref:ui_language`, then English), ignoring cache age.
 *
 * Returns 200 with:
 *  - { ok: true, phrases, meta } when the model produced a usable batch
 *  - { ok: false, reason, meta } otherwise. `meta.reason` is the machine-
 *    readable outcome and `reason` its human-readable form; the caller keeps
 *    whatever it had, and the locale's pack is a correct answer, just a
 *    static one.
 *
 * `meta` mirrors the GET route's shape ({ source, reason, locale }) so a caller
 * can treat both responses the same way.
 *
 * Generation is local-only — this triggers a call to the on-device llama.cpp
 * server and nothing else. There is no cloud path.
 */
export async function POST(request: Request) {
  try {
    const requested = new URL(request.url).searchParams.get("locale");
    const locale = isPreferenceLanguage(requested) ? requested : null;
    const result = await forceRegenerate(locale);
    const meta = { source: sourceFor(result.reason), reason: result.reason, locale: result.locale };

    if (!result.phrases) {
      return NextResponse.json({ ok: false, reason: MESSAGES[result.reason], meta });
    }
    return NextResponse.json({ ok: true, phrases: result.phrases, meta });
  } catch (err) {
    // Don't let a model hiccup or KV write failure bubble out as an unhandled
    // 500 from Next; surface a structured reason the UI can show alongside
    // the existing "unavailable" branch. The exception itself stays in the
    // server log — its message can carry filesystem paths and other
    // internals, so the client gets a fixed string.
    console.error("[mascot-lines/regenerate] forceRegenerate threw:", err);
    return NextResponse.json({ ok: false, reason: "Mascot phrase regen failed" }, { status: 500 });
  }
}
