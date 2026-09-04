import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { speechTextFor, SPEECH_MAX_CHARS } from "@/lib/speech-text";
import { speakReply, withSpeechQueue } from "@/lib/voice-speak";
import { mediaError, releaseMediaTarget, resolveMediaTarget, writeMediaFile } from "@/lib/coding-agent-media";

export const dynamic = "force-dynamic";

/**
 * POST { path, text } → that text spoken in this box's own voice, written
 * into the active coding run's folder as the file the caller named.
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

/**
 * What the file may be called, and how to tell whether the bytes agree.
 *
 * The chain answers WAV on an OpenClaw box, but a Hermes box speaks through
 * its own harness and hands back whatever that produced. Writing those bytes
 * into the `.wav` the caller asked for would put a lie on disk that the next
 * thing to open the file — a browser's audio element, the run's own page —
 * would trust, so the name has to be earned rather than assumed.
 */
const AUDIO_FORMATS: { extension: string; matches: (bytes: Buffer) => boolean }[] = [
  // "RIFF....WAVE": the container's own name, at the two places it appears.
  { extension: ".wav", matches: (b) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WAVE" },
  // An MPEG audio frame, or the ID3 tag that so often precedes one.
  { extension: ".mp3", matches: (b) => b.length > 3 && (b.toString("latin1", 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) },
  // "OggS", which is what an Opus stream arrives in.
  { extension: ".ogg", matches: (b) => b.length > 4 && b.toString("latin1", 0, 4) === "OggS" },
];

export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return mediaError("Invalid request body", "bad_request", 400);
  }
  // A literal `null` body parses cleanly, so the catch never runs and reading
  // `.text` off it threw where this route had already promised a 400 — the one
  // answer a model can act on. Same for an array or a bare number.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return mediaError("Invalid request body", "bad_request", 400);
  }
  const body = parsed as { path?: unknown; text?: unknown; overwrite?: unknown };
  // The same cap and the same Markdown stripping the chat's spoken replies
  // get: the cloud voice is billed per character, and a run that sent its
  // report verbatim would pay for every asterisk in it.
  const text = typeof body.text === "string" ? speechTextFor(body.text, SPEECH_MAX_CHARS) : "";
  if (!text) return mediaError("Say what should be spoken.", "bad_request", 400);

  const asked = typeof body.path === "string" ? body.path.trim().toLowerCase() : "";
  const wanted = AUDIO_FORMATS.find((f) => asked.endsWith(f.extension)) ?? AUDIO_FORMATS[0];
  const resolved = await resolveMediaTarget({
    path: body.path,
    extension: wanted.extension,
    kind: "audio",
    overwrite: body.overwrite === true,
  });
  if (!resolved.ok) return resolved.response;
  const { target } = resolved;

  let kept = false;
  try {
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
    if (!wanted.matches(audio)) {
      const actual = AUDIO_FORMATS.find((f) => f.matches(audio));
      return mediaError(
        actual
          ? `This box's voice answered ${actual.extension.slice(1).toUpperCase()}, not ${wanted.extension.slice(1).toUpperCase()}. Ask again for a file ending in ${actual.extension}.`
          : "This box's voice answered in a format this tool cannot name.",
        "format",
        409,
        actual ? { extension: actual.extension, mime } : { mime },
      );
    }
    const written = await writeMediaFile(target, audio);
    if (!written.ok) return written.response;
    kept = true;
    return NextResponse.json(
      { path: target.file, bytes: audio.byteLength, mime, engine, used: written.used, cap: target.cap },
      { headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    // The slot is taken before the voice is asked for, so a refusal, a silent
    // engine or a container that did not match the name has to give it back —
    // a run must not lose one of its clips to something it never heard.
    if (!kept) releaseMediaTarget(target);
  }
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
