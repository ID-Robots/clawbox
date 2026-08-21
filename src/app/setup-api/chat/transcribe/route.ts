import { NextRequest, NextResponse } from "next/server";
import { CLAWBOX_AI_PROVIDER } from "@/lib/clawbox-ai-models";
import { CLAWBOX_AI_PROXY_URL } from "@/lib/hermes-clawai";
import { readConfig } from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

// -- Voice input ------------------------------------------------------------
//
// Turns a recording made in device chat into text. The mascot chat composer
// records with `MediaRecorder`, POSTs the blob here, and puts what comes back
// in the input box for the user to read before they send it.
//
// Why the device proxies instead of the browser calling out directly: the
// ClawBox AI token lives in `~/.openclaw/openclaw.json` and is the device's
// credential, not the page's. Handing it to client JavaScript would put it in
// every devtools network panel and in the memory of any script the chat surface
// ever loads. The browser talks to the box; only the box talks to the proxy.
//
// The upstream is the same ClawBox AI proxy that serves chat and vision, and it
// speaks OpenAI's transcription shape: multipart with a `file` part, answering
// `{ text }`. Verified against the live proxy from a real box on 2026-08-21 --
// WAV and WebM/Opus both transcribe, and WebM/Opus is what Chrome's
// `MediaRecorder` actually produces, so the browser's native output needs no
// re-encoding on the device.
//
// Session-gated by middleware, which lists /setup-api/chat among the surfaces
// that stay closed even during the pre-setup AP window.

/**
 * The transcription model.
 *
 * `gpt-4o-mini-transcribe` at $0.003/minute is the cheapest of OpenAI's eight
 * transcription options -- half of Whisper's $0.006, and a sixth of
 * `gpt-live-transcribe`. At roughly an hour of dictation per user per month
 * that is about $0.18. Overridable so a staging box can be pointed elsewhere
 * without a code change.
 */
export const TRANSCRIBE_MODEL =
  process.env.CLAWBOX_AI_TRANSCRIBE_MODEL?.trim() || "gpt-4o-mini-transcribe";

// A minute of Opus at the bitrate MediaRecorder picks is well under a
// megabyte, so this is generous for dictation while still bounding what one
// request can push at the proxy. The check is on what actually arrives, not on
// a header the caller controls.
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// Long enough that a slow uplink on a busy box still finishes, short enough
// that a wedged upstream cannot pin the recording UI in "transcribing" for
// minutes with no way out.
const UPSTREAM_TIMEOUT_MS = 120_000;

/** Everything the caller needs to be told, without saying how we are built. */
type Failure = { status: number; error: string };

/**
 * The device's ClawBox AI credential.
 *
 * Read per request rather than cached: the gateway rewrites `openclaw.json`
 * on restart and a token can be re-minted by the portal at any time, so a
 * value captured at module load goes stale exactly when someone re-links the
 * device and least expects to have to reboot it.
 */
async function readProxyToken(): Promise<string | null> {
  const config = await readConfig();
  const provider = config.models?.providers?.[CLAWBOX_AI_PROVIDER];
  const key = provider?.apiKey;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

/**
 * Read the audio part out of the request.
 *
 * `request.formData()` is used rather than a streaming parser because, unlike
 * the attachment route next door, nothing is written to disk here: the bytes
 * go straight back out to the proxy. There is no partial file to clean up and
 * no staged path to hand back, so the streaming machinery would buy nothing.
 */
async function readAudio(req: NextRequest): Promise<{ file: Blob; name: string } | Failure> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    // A truncated or malformed multipart body is the caller's to fix, so it is
    // a 400 -- reporting it as a 500 sends the user off debugging the box.
    return { status: 400, error: `Could not read the recording: ${err instanceof Error ? err.message : String(err)}` };
  }
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return { status: 400, error: "Expected an audio `file` part" };
  }
  if (file.size === 0) {
    // A zero-length blob is what a recording that never captured anything
    // looks like -- a denied microphone, or stop pressed before the first
    // chunk. Saying so beats forwarding silence and relaying "no speech".
    return { status: 400, error: "The recording is empty" };
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return { status: 413, error: "The recording is too long" };
  }
  const name = file instanceof File && file.name ? file.name : "recording.webm";
  return { file, name };
}

// POST /setup-api/chat/transcribe
// Body: multipart/form-data with one `file` part holding the recording.
// Returns { ok: true, text } -- the transcript, for the composer to show.
export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const audio = await readAudio(req);
  if ("status" in audio) {
    return NextResponse.json({ error: audio.error }, { status: audio.status });
  }

  const token = await readProxyToken();
  if (!token) {
    // Actionable on purpose: this is the one failure the user can actually do
    // something about, and "transcription failed" would send them nowhere.
    return NextResponse.json(
      { error: "This ClawBox is not linked to ClawBox AI yet, so it cannot transcribe audio." },
      { status: 503 },
    );
  }

  const upstream = new FormData();
  upstream.set("file", audio.file, audio.name);
  upstream.set("model", TRANSCRIBE_MODEL);

  let res: Response;
  try {
    res = await fetch(`${CLAWBOX_AI_PROXY_URL}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: upstream,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    // A box on a flaky uplink is the common case here, and the distinction
    // matters to the user: "try again" versus "check your internet".
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return NextResponse.json(
      { error: timedOut ? "Transcription timed out. Please try again." : "Could not reach ClawBox AI to transcribe the recording." },
      { status: 504 },
    );
  }

  if (!res.ok) {
    // Upstream bodies can carry the request we sent back at us, and that
    // request carried a bearer token. Only the status is relayed, never the
    // body, so a proxy that echoes cannot leak the device credential into a
    // browser console.
    const status = res.status === 401 || res.status === 403
      ? 503
      : res.status >= 400 && res.status < 500 ? 400 : 502;
    const error = status === 503
      ? "ClawBox AI rejected this device's credentials. Re-link the device and try again."
      : `Transcription failed (upstream ${res.status}).`;
    return NextResponse.json({ error }, { status });
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return NextResponse.json({ error: "Transcription returned an unreadable response." }, { status: 502 });
  }

  const text = (payload as { text?: unknown } | null)?.text;
  if (typeof text !== "string") {
    return NextResponse.json({ error: "Transcription returned no text." }, { status: 502 });
  }
  // An empty transcript is a successful call that heard nothing -- silence, or
  // a microphone that captured only room noise. The composer says so; it is
  // not an error and must not be reported as one.
  return NextResponse.json({ ok: true, text: text.trim() });
}
