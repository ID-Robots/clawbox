import { MAX_AUDIO_BYTES } from "@/lib/transcribe-limits";
import { NextRequest, NextResponse } from "next/server";
import Busboy from "busboy";
import { Readable } from "stream";
import { CLAWBOX_AI_PROXY_URL, resolveClawaiToken } from "@/lib/harness/credentials";
import { localSttInstalled, transcribeLocally } from "@/lib/stt-local";
import { getSttPrimary, sttEngineOrder, TRANSCRIBE_MODEL } from "@/lib/stt-preference";

export const dynamic = "force-dynamic";

// -- Voice input ------------------------------------------------------------
//
// Turns a recording made in device chat into text. The mascot chat composer
// records with `MediaRecorder`, POSTs the blob here, and sends the returned
// text through the ordinary chat-turn path.
//
// Two engines can do it: ClawBox AI (the cloud) and faster-whisper on the box
// itself. The owner picks which goes first (src/lib/stt-preference.ts) and the
// other is the fallback, so a box with no uplink still takes dictation and a
// box whose whisper is cold still answers quickly. When both fail the caller
// hears about the PRIMARY's failure — that is the engine they chose, and its
// message is the one that names their next step.
//
// Why the device proxies instead of the browser calling out directly: the
// ClawBox AI token is the device's credential, not the page's. Handing it to
// client JavaScript would put it in every devtools network panel and in the
// memory of any script the chat surface ever loads. The browser talks to the
// box; only the box talks to the proxy.
//
// WHERE that token lives differs by edition, and this route no longer knows or
// cares — `resolveClawaiToken` does. It used to read `openclaw.json` and
// nothing else, which is the entire reason voice input was dark on a Hermes
// box: nothing about transcription is OpenClaw-specific, but the lookup was,
// so the route could only ever answer "not linked" and the microphone was
// hidden to cover for it.
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

// The cloud model is defined next to the gateway's audio config so the two
// surfaces cannot drift (src/lib/stt-preference.ts); a route module may
// export handlers and Next's config keys only, so it is read from there.

// A minute of Opus at the bitrate MediaRecorder picks is well under a
// megabyte, so 8 MB is half an hour of dictation while still bounding what one
// request can push at the proxy. The check is on what actually arrives, not on
// a header the caller controls.
//
// Why not more: Next 16 cuts every request body this route can see at 10 MB
// (`experimental.proxyClientMaxBodySize`, default 10mb, applied because
// src/middleware.ts matches this path) and hands the handler the truncated
// remainder. The contract used to say 25 MB, and every recording between 10
// and 25 MB arrived cut off, failed to parse, and was reported as a bad
// recording rather than a long one. The ceiling has to sit under the
// platform's for the meters below to be the ones that answer — and the cloud
// proxy refuses uploads of ~9 MB with its own 413 anyway, so nothing that
// could have been transcribed is lost by saying 8.
// MAX_AUDIO_BYTES lives in src/lib/transcribe-limits.ts (a route module may
// export handlers and Next's config keys only).

// The cap above can only be applied to a part once the body has been parsed,
// and parsing means the bytes are already in memory -- so the request as a
// whole needs a second bound, applied while it arrives, before the platform's
// 10 MB cut turns an oversized upload into an unparseable one. The spare
// megabyte is multipart framing and the `model` field, the same headroom the
// attachment route next door allows itself.
const MAX_REQUEST_BYTES = MAX_AUDIO_BYTES + 1024 * 1024;

const TOO_LONG = `The recording is too long (over ${MAX_AUDIO_BYTES / (1024 * 1024)} MB).`;
const MAX_MULTIPART_PARTS = 4;

// Long enough that a slow uplink on a busy box still finishes, short enough
// that a wedged upstream cannot pin the recording UI in "transcribing" for
// minutes with no way out.
const UPSTREAM_TIMEOUT_MS = 120_000;

/** Everything the caller needs to be told, without saying how we are built. */
type Failure = { status: number; error: string };

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
    return { status: 413, error: TOO_LONG };
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
          ? { status: 413, error: TOO_LONG }
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
            finish({ status: 413, error: TOO_LONG }, true);
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        stream.on("limit", () => finish({ status: 413, error: TOO_LONG }, true));
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
      return { status: 413, error: TOO_LONG };
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

type Audio = { file: Blob; name: string };
type Transcript = { text: string };

/** The cloud engine: the recording goes to the ClawBox AI proxy. */
async function transcribeInCloud(req: NextRequest, audio: Audio): Promise<Transcript | Failure> {
  const token = await resolveClawaiToken();
  if (!token) {
    // Actionable on purpose: this is the one failure the user can actually do
    // something about, and "transcription failed" would send them nowhere.
    return {
      status: 503,
      error: "This ClawBox is not linked to ClawBox AI yet, so it cannot transcribe audio.",
    };
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
    return {
      status: 504,
      error: timedOut ? "Transcription timed out. Please try again." : "Could not reach ClawBox AI to transcribe the recording.",
    };
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
    return { status, error };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { status: 502, error: "Transcription returned an unreadable response." };
  }

  const text = (payload as { text?: unknown } | null)?.text;
  if (typeof text !== "string") {
    return { status: 502, error: "Transcription returned no text." };
  }
  return { text };
}

/**
 * The on-box engine, or null when it is not installed — which is a fact about
 * the box, not a failure of this recording, so it must not become the error
 * the caller sees.
 */
async function transcribeOnBox(audio: Audio): Promise<Transcript | Failure | null> {
  if (!(await localSttInstalled()).installed) return null;
  const result = await transcribeLocally(Buffer.from(await audio.file.arrayBuffer()), audio.name);
  if (!result.ok) {
    // The detail names a temp path and whatever python printed. Worth having
    // in the box's log; not something to hand the composer's status line.
    console.warn("[chat/transcribe] on-box transcription failed:", result.error);
    return { status: 500, error: "Transcription failed on this box." };
  }
  return { text: result.text };
}

// POST /setup-api/chat/transcribe
// Body: multipart/form-data with one `file` part holding the recording.
// Returns { ok: true, text, engine } -- the transcript for the voice turn to
// send, and which engine ("cloud" | "local") produced it.
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

  let firstFailure: Failure | null = null;
  for (const engine of sttEngineOrder(await getSttPrimary())) {
    // The caller left. The cloud call above honours `req.signal` and comes
    // back as a failure like any other — which, unchecked, would send the
    // recording on to the box's own engine and hold a two-minute whisper run
    // for nobody. Nothing is spawned for a request nobody is waiting on.
    if (req.signal.aborted) return NextResponse.json({ error: "The recording was cancelled." }, { status: 499 });
    const result = engine === "cloud" ? await transcribeInCloud(req, audio) : await transcribeOnBox(audio);
    if (result === null) continue;
    if ("status" in result) {
      firstFailure ??= result;
      continue;
    }
    // An empty transcript is a successful call that heard nothing -- silence,
    // or a microphone that captured only room noise. The composer says so; it
    // is not an error and must not be reported as one.
    return NextResponse.json({ ok: true, text: result.text.trim(), engine });
  }
  // The cloud engine always answers, so the null case is unreachable today;
  // it is spelled out rather than asserted away so a chain of two optional
  // engines would still fail with a status instead of a crash.
  const failure = firstFailure ?? { status: 503, error: "No transcription engine is available on this ClawBox." };
  return NextResponse.json({ error: failure.error }, { status: failure.status });
}
