import { NextRequest, NextResponse } from "next/server";
import Busboy from "busboy";
import { Readable } from "stream";
import { boundedBody } from "@/lib/bounded-body";
import {
  CLAWBOX_AI_PROXY_URL,
  clawaiCredentialRefused,
  clawaiCredentialGeneration,
  noteClawaiCredentialRefused,
  proxyRefusedClawaiCredential,
  resolveClawaiToken,
} from "@/lib/harness/credentials";
import { localSttInstalled, transcribeLocally } from "@/lib/stt-local";
import { getSttPrimary, sttEngineOrder, TRANSCRIBE_MODEL, type SttEngine } from "@/lib/stt-preference";
import { audioForCloud } from "@/lib/stt-remux";

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
// box whose whisper is cold still answers quickly. ANY failure of the first
// engine sends the recording to the second: a 4xx the proxy chose, a 5xx, a
// network error, a timeout, or something under the engine throwing. When both
// fail the caller hears about the PRIMARY's failure — that is the engine they
// chose, and its message is the one that names their next step.
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
// `{ text }`. On 2026-08-21 the browser's WebM/Opus transcribed as it was
// recorded. By 2026-09-25 it did not: the proxy now reads the duration before it
// accepts a recording, and `MediaRecorder`'s WebM has none, so every recording
// came back 400 `unsupported_audio`. The cloud leg therefore remuxes the
// recording on the box first (src/lib/stt-remux.ts). That costs a fraction of a
// second and does not depend on which side moved.
//
// Session-gated by middleware, which lists /setup-api/chat among the surfaces
// that stay closed even during the pre-setup AP window.

// The cloud model is defined next to the gateway's audio config so the two
// surfaces cannot drift; re-exported here because this route is where callers
// have always read it from.
export { TRANSCRIBE_MODEL };

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
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

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

/**
 * Everything the caller needs to be told, without saying how we are built.
 * `detail` is for the box's log only and never reaches the response.
 */
type Failure = { status: number; error: string; detail?: string };

// Enough for the proxy's error envelope, which is all that is read out of it.
const MAX_ERROR_BODY_BYTES = 4096;

/**
 * The proxy's own error code (`unsupported_audio`, `rate_limited`, …) from a
 * refusal, for the box's log. Only a short lowercase identifier is kept. The
 * rest of the body can echo the request back, and the request carried a bearer
 * token, so none of it is logged or relayed.
 */
async function upstreamErrorCode(res: Response): Promise<string | null> {
  const body = res.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        total += value.byteLength;
        if (total > MAX_ERROR_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(Buffer.from(value));
      }
      if (done) break;
    }
    const code = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === "string" && /^[a-z0-9_.-]{1,64}$/.test(code) ? code : null;
  } catch {
    return null;
  }
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

  // The meter (src/lib/bounded-body.ts) counts what actually arrives and cuts
  // the source off past the cap; a chunked upload declares no length, so the
  // header check above bounds only the callers that were never the problem.
  const bounded = boundedBody(req.body, {
    limit: MAX_REQUEST_BYTES,
    message: "request body exceeds the transcription size limit",
  });
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

  // The proxy has already told this box it will not accept this credential,
  // and a recording is ~9 MB. Uploading it to be refused again costs the
  // customer their uplink and the box its time, and answers nothing the first
  // refusal did not already answer — so the same sentence is returned here,
  // without the upload. Cleared the moment the device is re-linked.
  const refused = clawaiCredentialRefused();
  if (refused !== null) {
    return {
      status: 503,
      error: "ClawBox AI rejected this device's credentials. Re-link the device and try again.",
    };
  }

  // Snapshotted BEFORE the upload, for the reason the image path documents: a
  // re-link that lands mid-request makes the answer a verdict on a credential
  // the box no longer holds.
  const generation = clawaiCredentialGeneration();

  // MediaRecorder's WebM has no duration and the proxy will not take a
  // recording without one (src/lib/stt-remux.ts). It is done here, after the
  // credential checks, so a box that is not going to upload does not pay for
  // it. It is also done on this leg only: faster-whisper decodes the browser's
  // own output as it is.
  const upload = await audioForCloud(audio, req.signal);

  const upstream = new FormData();
  upstream.set("file", upload.file, upload.name);
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
      detail: `${timedOut ? "upstream timed out" : "upstream unreachable"}, recording sent ${upload.prepared}`,
    };
  }

  if (!res.ok) {
    // Upstream bodies can carry the request we sent back at us, and that
    // request carried a bearer token. Only the status is relayed, never the
    // body, so a proxy that echoes cannot leak the device credential into a
    // browser console.
    // The proxy names the credential as the problem with its own
    // `missing_token` / `invalid_token`; a bare 401/403 can be an edge rule or
    // a plan gate, and remembering one of those would mute the microphone on a
    // box whose credential is fine. Only the proxy's own verdict is recorded.
    const credentialStatus = res.status === 401 || res.status === 403;
    if (await proxyRefusedClawaiCredential(res)) await noteClawaiCredentialRefused(res.status, generation);
    // The credential check above has already read a 401/403 body.
    const code = credentialStatus ? null : await upstreamErrorCode(res);
    const status = credentialStatus
      ? 503
      : res.status >= 400 && res.status < 500 ? 400 : 502;
    const error = status === 503
      ? "ClawBox AI rejected this device's credentials. Re-link the device and try again."
      : `Transcription failed (upstream ${res.status}).`;
    return { status, error, detail: `upstream ${res.status}${code ? ` ${code}` : ""}, recording sent ${upload.prepared}` };
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

/** An engine this box does not have, and why — for the log, never the caller. */
type Unavailable = { unavailable: string };

/**
 * The on-box engine, or `unavailable` when it is not installed. That is a fact
 * about the box, not a failure of this recording, so it must not become the
 * error the caller sees.
 */
async function transcribeOnBox(audio: Audio): Promise<Transcript | Failure | Unavailable> {
  const probe = await localSttInstalled();
  if (!probe.installed) return { unavailable: probe.detail };
  const result = await transcribeLocally(Buffer.from(await audio.file.arrayBuffer()), audio.name);
  if (!result.ok) {
    // The detail names a temp path and whatever python printed. Worth having
    // in the box's log; not something to hand the composer's status line.
    return { status: 500, error: "Transcription failed on this box.", detail: result.error };
  }
  return { text: result.text };
}

/**
 * One engine's attempt, which never throws. Either engine can fail from
 * somewhere beneath it: a credential store that will not parse, a disk that
 * refuses the refusal note, a temp dir that cannot be made. A throw used to
 * escape the loop below as a bare 500, and the other engine was never asked.
 * It is one more failure now, and the fallback runs.
 */
async function attempt(engine: SttEngine, req: NextRequest, audio: Audio): Promise<Transcript | Failure | Unavailable> {
  try {
    return engine === "cloud" ? await transcribeInCloud(req, audio) : await transcribeOnBox(audio);
  } catch (err) {
    // Only the error's NAME from the cloud leg: its message can quote the
    // credential file it failed to parse, and this line goes to the journal.
    return engine === "cloud"
      ? { status: 502, error: "Transcription failed.", detail: `cloud leg threw ${err instanceof Error ? err.name : typeof err}` }
      : { status: 500, error: "Transcription failed on this box.", detail: `on-box leg threw: ${String(err)}` };
  }
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
    const result = await attempt(engine, req, audio);
    // Each fallback is logged, and so is a fallback that had nothing to go to.
    // Without these lines a box whose on-box engine is missing, and whose
    // cloud refuses every recording, shows only a column of 400s.
    if ("unavailable" in result) {
      if (firstFailure) console.warn(`[chat/transcribe] no ${engine} engine to fall back to: ${result.unavailable}`);
      continue;
    }
    if ("status" in result) {
      console.warn(
        `[chat/transcribe] ${engine} engine failed (${result.status}${result.detail ? `: ${result.detail}` : ""})`
        + (firstFailure ? "" : "; trying the other engine"),
      );
      firstFailure ??= result;
      continue;
    }
    // An empty transcript is a successful call that heard nothing -- silence,
    // or a microphone that captured only room noise. The composer says so; it
    // is not an error and must not be reported as one.
    return NextResponse.json({ ok: true, text: result.text.trim(), engine });
  }
  // The cloud engine always answers, so the all-unavailable case is unreachable today;
  // it is spelled out rather than asserted away so a chain of two optional
  // engines would still fail with a status instead of a crash.
  const failure = firstFailure ?? { status: 503, error: "No transcription engine is available on this ClawBox." };
  return NextResponse.json({ error: failure.error }, { status: failure.status });
}
