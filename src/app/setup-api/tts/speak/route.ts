export const dynamic = "force-dynamic";

import { speechTextFor, SPEECH_MAX_CHARS } from "@/lib/speech-text";
import { getVoiceAutoReply } from "@/lib/voice-reply";
import { isSameOriginRequest } from "@/lib/same-origin";
import { refuse, speakReply, withSpeechQueue } from "@/lib/voice-speak";

/**
 * POST /setup-api/tts/speak {text} → the reply, spoken, for the desktop chat.
 *
 * A voice message in the desktop chat is transcribed on the box and sent as
 * text, so the gateway never learns it was spoken and its own `tts.auto:
 * "inbound"` cannot answer it. The chat asks here instead, with the reply's
 * text, and plays what comes back beside the bubble. Through the CHAIN — the
 * engine the Voice tab put first, then the other — because the owner wants to
 * hear the answer, not audition an engine (that is `tts/sample`).
 *
 * The Markdown is lifted off the text here as well as in the chat, so a
 * caller that sends the raw reply still gets words rather than asterisks, and
 * the result is capped at SPEECH_MAX_CHARS. Refused while the owner's switch
 * is off: the chat does not ask then, and nothing else should get a spoken
 * reply out of a box whose owner turned them off.
 */

export async function POST(req: Request) {
  if (!(await getVoiceAutoReply())) return refuse("Spoken replies are switched off in Settings → Voice.", "switched_off", 409);
  // From OUR page only: the owner's cookie rides on a POST any other site
  // fires at the box, and a spoken reply through the cloud voice is billed
  // per character (same-origin.ts). curl and the MCP server send no Origin
  // and pass; they are gated by their own credential.
  if (!isSameOriginRequest(req)) return refuse("Spoken replies only work from this ClawBox's own pages.", "cross_origin", 403);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refuse("Invalid request body", "bad_request", 400);
  }
  const raw = (body as { text?: unknown } | null)?.text;
  const text = typeof raw === "string" ? speechTextFor(raw, SPEECH_MAX_CHARS) : "";
  if (!text) return refuse("Nothing to say.", "bad_text", 400);

  // Waits for an earlier reply rather than refusing: see withSpeechQueue. The
  // synthesis itself is `speakReply` in src/lib/voice-speak.ts — shared with
  // the coding agent's generate_audio so the two cannot drift apart.
  return withSpeechQueue(() => speakReply(text));
}
