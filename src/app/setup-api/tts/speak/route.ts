export const dynamic = "force-dynamic";

import { speechTextFor, SPEECH_MAX_CHARS } from "@/lib/speech-text";
import { getVoiceAutoReply } from "@/lib/voice-reply";
import { isSameOriginRequest } from "@/lib/same-origin";
import { refuse, speakReply, withSpeechQueue } from "@/lib/voice-speak";
import { pickReplyFormat } from "@/lib/voice-reply-format";

/**
 * POST /setup-api/tts/speak {text, formats?} → the reply, spoken, for the
 * desktop chat.
 *
 * A message in the desktop chat reaches the gateway as TEXT — a recording is
 * transcribed on the box first — so `tts.auto: "inbound"` can never fire on a
 * reply to one, whether it was typed or spoken. The chat asks here instead,
 * with the reply's text, and renders what comes back beside the bubble (played
 * at once for a spoken question; left to press for a typed one by default,
 * played as well when the owner switched auto-play on). Through the
 * CHAIN — the
 * engine the Voice tab put first, then the other — because the owner wants to
 * hear the answer, not audition an engine (that is `tts/sample`).
 *
 * The Markdown is lifted off the text here as well as in the chat, so a
 * caller that sends the raw reply still gets words rather than asterisks, and
 * the result is capped at SPEECH_MAX_CHARS. Refused while the owner's switch
 * is off: the chat does not ask then, and nothing else should get a spoken
 * reply out of a box whose owner turned them off.
 *
 * COMPRESSED, never WAV unless nothing else can be made: `formats` is what the
 * page's browser said it can play (`playableReplyFormats`), and the answer is
 * Ogg Opus when Opus is on that list and MP3 otherwise — a request that states
 * nothing gets MP3, which every browser decodes. The Content-Type names what
 * the bytes are; on a box without ffmpeg the local engine's WAV goes out as it
 * came (src/lib/voice-reply-format.ts, src/lib/tts-compress.ts).
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
  const { text: raw, formats } = (body ?? {}) as { text?: unknown; formats?: unknown };
  const text = typeof raw === "string" ? speechTextFor(raw, SPEECH_MAX_CHARS) : "";
  if (!text) return refuse("Nothing to say.", "bad_text", 400);
  const format = pickReplyFormat(formats);

  // Waits for an earlier reply rather than refusing: see withSpeechQueue. The
  // synthesis itself is `speakReply` in src/lib/voice-speak.ts — shared with
  // the coding agent's generate_audio so the two cannot drift apart.
  return withSpeechQueue(() => speakReply(text, undefined, { format }));
}
