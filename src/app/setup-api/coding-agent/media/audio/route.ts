import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { speechTextFor, SPEECH_MAX_CHARS } from "@/lib/speech-text";
import { speakReply, withSpeechQueue } from "@/lib/voice-speak";
import { mediaError, resolveMediaTarget, writeMediaFile } from "@/lib/coding-agent-media";

export const dynamic = "force-dynamic";

/**
 * POST { path, text } → a WAV of that text, spoken in this box's own voice and
 * written into the active coding run's folder.
 *
 * The box already speaks — the chat plays a reply back through
 * `src/lib/voice-speak.ts` — and a run building anything with sound had no way
 * to reach it. This is the same chain, the same engines in the same order and
 * the same one-at-a-time queue, writing to a file instead of a response body.
 *
 * The two gates the chat's own speak route keeps are deliberately NOT here:
 * its same-origin check (this caller sends no Origin and is gated by its
 * bearer) and `voice_auto_reply`, which is the owner's switch for the box
 * TALKING BACK in a conversation. A clip written into a project is not that;
 * its switch is the Coding Agent's own, checked by resolveMediaTarget.
 *
 * WHERE it may write is decided by src/lib/coding-agent-media.ts and nowhere
 * else — see that module for why the tool's own check is only a courtesy.
 *
 * A refusal from the engines is relayed as it stands: the memory guard's
 * numbers, "busy", "no voice". Each is a fact about the box at this moment
 * rather than about the text, and the brief tells the run to try once more
 * later and then carry on without sound.
 */

/** Below this a WAV is a header and nothing else — the same floor voice-speak uses. */
const MIN_AUDIO_BYTES = 1024;

export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  let body: { path?: unknown; text?: unknown; overwrite?: unknown };
  try {
    body = await request.json();
  } catch {
    return mediaError("Invalid request body", "bad_request", 400);
  }
  // The same cap and the same Markdown stripping the chat's spoken replies
  // get: the cloud voice is billed per character, and a run that sent its
  // report verbatim would pay for every asterisk in it.
  const text = typeof body.text === "string" ? speechTextFor(body.text, SPEECH_MAX_CHARS) : "";
  if (!text) return mediaError("Say what should be spoken.", "bad_request", 400);

  const resolved = await resolveMediaTarget({
    path: body.path,
    extension: ".wav",
    kind: "audio",
    overwrite: body.overwrite === true,
  });
  if (!resolved.ok) return resolved.response;
  const { target } = resolved;

  // Waits its turn rather than refusing outright: the queue is box-wide and
  // shared with the chat's spoken replies, and a run's clip that arrives a few
  // seconds late is still the clip it asked for. A queue that is already
  // several deep answers 429 `busy`, which the tool relays as "try later".
  const spoken = await withSpeechQueue(() => speakReply(text));
  if (!spoken.ok) return relay(spoken);

  const audio = Buffer.from(await spoken.arrayBuffer());
  if (audio.byteLength < MIN_AUDIO_BYTES) {
    return mediaError("The voice produced no audio.", "write_failed", 502, { reason: "empty" });
  }
  const engine = spoken.headers.get("X-ClawBox-Voice-Engine");
  const mime = spoken.headers.get("content-type")?.split(";")[0].trim() ?? "audio/wav";
  const written = await writeMediaFile(target, "audio", audio);
  if (!written.ok) return written.response;
  return NextResponse.json(
    { path: target.file, bytes: audio.byteLength, mime, engine, used: written.used, cap: target.cap },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Hand the engines' own refusal back, code and all.
 *
 * `refuse()` bodies already carry a stable `code` and, for the memory guard,
 * the gigabytes — which is exactly what the MCP rule words for the run. Rebuilt
 * rather than streamed through so the response is a plain JSON body with this
 * route's own headers, and so a body that is not JSON (which would mean the
 * chain changed shape) still becomes something the caller can read.
 */
async function relay(refusal: Response): Promise<Response> {
  const body = await refusal.json().catch(() => null) as Record<string, unknown> | null;
  if (body && typeof body.error === "string") {
    return NextResponse.json(body, { status: refusal.status, headers: { "Cache-Control": "no-store" } });
  }
  return mediaError("The box could not speak that.", "write_failed", refusal.status || 502);
}
