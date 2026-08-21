import { NextRequest, NextResponse } from "next/server";
import Busboy from "busboy";
import { Readable } from "stream";
import { CLAWBOX_AI_PROVIDER } from "@/lib/clawbox-ai-models";
import { CLAWBOX_AI_PROXY_URL } from "@/lib/hermes-clawai";
import { readConfig } from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

// -- Voice input ------------------------------------------------------------
//
// Turns a recording made in device chat into text. The mascot chat composer
// records with `MediaRecorder`, POSTs the blob here, and sends the returned
// text through the ordinary chat-turn path.
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

// The cap above can only be applied to a part once the body has been parsed,
// and parsing means the bytes are already in memory -- so the request as a
// whole needs a second bound, applied while it arrives. Nothing in front of
// this route provides one: the box serves its web UI from Next itself with no
// reverse proxy trimming bodies, and a route handler gets no default body
// limit. The spare megabyte is multipart framing and the `model` field, the
// same headroom the attachment route next door allows itself.
const MAX_REQUEST_BYTES = MAX_AUDIO_BYTES + 1024 * 1024;
const MAX_MULTIPART_PARTS = 4;

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
 * Meter the body and cut the stream off past `MAX_REQUEST_BYTES`.
 *
 * Counting the bytes as they pass rather than trusting Content-Length: a
 * chunked upload declares no length at all, so a header check bounds only the
 * callers that were never the problem. Erroring the transform cancels the
 * source, so someone pushing gigabytes stops being read one chunk after the
 * cap instead of at the end of their upload.
 *
 * The overflow is reported by the flag rather than by matching on what the
 * parser rethrows, because what a parser makes of a cancelled source is its
 * own business and not something to pin an HTTP status on.
 */
function boundedBody(body: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>;
  overflowed: () => boolean;
} {
  let total = 0;
  let over = false;
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > MAX_REQUEST_BYTES) {
          over = true;
          controller.error(new Error("request body exceeds the transcription size limit"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return { stream, overflowed: () => over };
}

/**
 * Read the one audio part out of the request.
 *
 * The byte meter protects against a huge file or chunked body. Busboy adds the
 * other bound `formData()` cannot express: part count. Tens of thousands of
 * one-byte fields fit inside the byte ceiling but amplify heavily while the
 * platform builds a FormData object, enough to exhaust a Nano under parallel
 * requests. This parser accepts exactly one file part and never materialises
 * fields at all.
 */
async function readAudio(req: NextRequest): Promise<{ file: Blob; name: string } | Failure> {
  // Content-Length is worth believing when it is offered -- an honest client
  // is turned away before a byte is read -- but it is a courtesy, not a bound:
  // a chunked body declares nothing, and a dishonest one declares whatever
  // gets it past this line. The counted read is what actually holds.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    return { status: 413, error: "The recording is too long" };
  }
  if (!req.body) return { status: 400, error: "Could not read the recording." };

  const bounded = boundedBody(req.body);
  try {
    return await new Promise<{ file: Blob; name: string } | Failure>((resolve) => {
      let busboy: ReturnType<typeof Busboy>;
      try {
        busboy = Busboy({
          headers: { "content-type": req.headers.get("content-type") ?? "" },
          limits: {
            files: 1,
            fields: 2,
            parts: MAX_MULTIPART_PARTS,
            // Busboy raises `limit` when the byte count reaches its configured
            // value. Give it one sentinel byte so the advertised <= limit is
            // accepted and only a genuinely larger recording is rejected.
            fileSize: MAX_AUDIO_BYTES + 1,
          },
        });
      } catch {
        resolve({ status: 400, error: "Could not read the recording." });
        return;
      }

      let settled = false;
      let sawFile = false;
      let completed: { file: Blob; name: string } | null = null;
      let activeFile: Readable | null = null;
      const nodeStream = Readable.fromWeb(
        bounded.stream as unknown as import("stream/web").ReadableStream,
      );

      const finish = (result: { file: Blob; name: string } | Failure, abort = false) => {
        if (settled) return;
        settled = true;
        if (abort) {
          nodeStream.unpipe(busboy);
          nodeStream.destroy();
          activeFile?.destroy();
        }
        resolve(result);
      };
      const badMultipart = () => {
        console.warn("[chat/transcribe] could not parse multipart body");
        finish({ status: 400, error: "Could not read the recording." }, true);
      };

      busboy.on("filesLimit", badMultipart);
      busboy.on("fieldsLimit", badMultipart);
      busboy.on("partsLimit", badMultipart);
      busboy.on("error", badMultipart);
      busboy.on("field", () => {
        finish({ status: 400, error: "Expected an audio `file` part" }, true);
      });
      nodeStream.on("error", () => {
        finish(bounded.overflowed()
          ? { status: 413, error: "The recording is too long" }
          : { status: 400, error: "Could not read the recording." }, true);
      });

      busboy.on("file", (field, stream, info) => {
        if (field !== "file" || sawFile) {
          stream.resume();
          badMultipart();
          return;
        }
        sawFile = true;
        activeFile = stream as unknown as Readable;
        const chunks: Buffer[] = [];
        let fileBytes = 0;
        stream.on("data", (chunk: Buffer) => {
          if (settled) return;
          fileBytes += chunk.byteLength;
          if (fileBytes > MAX_AUDIO_BYTES) {
            finish({ status: 413, error: "The recording is too long" }, true);
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        stream.on("limit", () => finish({ status: 413, error: "The recording is too long" }, true));
        stream.on("error", badMultipart);
        stream.on("end", () => {
          if (settled) return;
          const bytes = Buffer.concat(chunks);
          if (bytes.length === 0) {
            completed = null;
            return;
          }
          const type = info.mimeType || "application/octet-stream";
          completed = {
            file: new Blob([bytes], { type }),
            name: info.filename || "recording.webm",
          };
        });
      });

      busboy.on("finish", () => {
        if (settled) return;
        if (!sawFile) {
          finish({ status: 400, error: "Expected an audio `file` part" });
          return;
        }
        if (!completed) {
          finish({ status: 400, error: "The recording is empty" });
          return;
        }
        finish(completed);
      });

      nodeStream.pipe(busboy);
    });
  } catch (err) {
    if (bounded.overflowed()) {
      return { status: 413, error: "The recording is too long" };
    }
    // A truncated or malformed multipart body is the caller's to fix, so it is
    // a 400 -- reporting it as a 500 sends the user off debugging the box. The
    // parser's own wording for it ("Failed to parse body as FormData.") is not
    // written for a person and is not translated on its way to the composer,
    // so it stays in the box's log, where it is worth something, and out of the
    // status line, where it is not.
    console.warn("[chat/transcribe] could not parse the multipart body:", err);
    return { status: 400, error: "Could not read the recording." };
  }
}

// POST /setup-api/chat/transcribe
// Body: multipart/form-data with one `file` part holding the recording.
// Returns { ok: true, text } -- the transcript for the voice turn to send.
export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }
  if (!/;\s*boundary=/i.test(contentType)) {
    return NextResponse.json({ error: "Expected multipart/form-data with a boundary" }, { status: 400 });
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
      // A disconnected browser must not leave a paid upstream transcription
      // running until the server timeout expires.
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
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
