export const dynamic = "force-dynamic";

import { openclawIsAbsent, readConfig } from "@/lib/openclaw-config";
import { refuse, speakInCloud, speakLocally, withSpeechLock } from "@/lib/voice-speak";
import { SAMPLE_MAX_CHARS } from "@/lib/voice-catalog";

/**
 * POST /setup-api/tts/sample {text, engine, voice?} → the audio, for the browser.
 *
 * The Voice tab's "hear it" button. This does not go through the gateway's
 * chain — the owner is auditioning ONE engine with ONE voice, and a chain that
 * quietly fell through to the other engine would play them the wrong one. The
 * engines themselves live in src/lib/voice-speak.ts, shared with the reply
 * route (`tts/speak`), which DOES walk the chain.
 *
 * The text is spoken and forgotten: never logged, never written to state.
 */

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters have no sound and can break a command line.
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!text || text.length > SAMPLE_MAX_CHARS) return null;
  return text;
}

export async function POST(req: Request) {
  if (openclawIsAbsent()) return refuse("Voice output is not part of this edition.", "edition", 409);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refuse("Invalid request body", "bad_request", 400);
  }
  const { text: rawText, engine, voice } = (body ?? {}) as Record<string, unknown>;
  const text = cleanText(rawText);
  if (!text) return refuse(`Type something to hear, up to ${SAMPLE_MAX_CHARS} characters.`, "bad_text", 400);
  if (engine !== "local" && engine !== "cloud") return refuse("Pick the voice on this box or the cloud voice.", "unknown_engine", 400);
  return withSpeechLock(async () => {
    try {
      const config = await readConfig();
      return engine === "local"
        ? await speakLocally(config, voice, text)
        : await speakInCloud(config, voice, text);
    } catch (err) {
      console.warn("[setup-api/tts/sample] failed:", err instanceof Error ? err.message : err);
      return refuse("Could not speak that on this box.", "failed", 500);
    }
  });
}
