/**
 * A chat-microphone recording, made fit for the ClawBox AI proxy's
 * transcription endpoint before it is uploaded.
 *
 * WHY. Chrome's `MediaRecorder` writes WebM while it records, so the header
 * goes out before anyone knows how long the recording will be: the file has
 * no Duration and no Cues (`ffprobe` answers `duration=N/A`). The proxy reads
 * the duration before it accepts a recording, and it refuses one without it:
 *
 *   HTTP 400
 *   {"error":{"message":"Could not read the audio duration. Supported formats:
 *   wav, mp3, m4a, mp4, ogg, opus, flac, webm.","type":"invalid_request_error",
 *   "code":"unsupported_audio"}}
 *
 * That was every recording the chat microphone makes, on a customer box
 * (2026-09-25). The same audio after a copy-only remux, `ffmpeg -i live.webm
 * -c copy out.webm`, carries its duration and transcribes. The remux has to
 * write a FILE: ffmpeg's Matroska muxer fills the duration in by seeking back
 * once it knows it, and it cannot seek back into a pipe, so a remux to stdout
 * is exactly as duration-less as the input. Hence the temp files.
 *
 * ORDER. Copy first: no re-encode, no quality loss, a fraction of a second
 * even for a long clip. If the copy fails (a codec the WebM muxer will not
 * carry, a stream too broken to copy), decode and re-encode to Opus in WebM.
 * Opus is in the proxy's own list and stays as small as the recording the size
 * cap already admitted. WAV would not: half an hour of dictation as 16 kHz PCM
 * is ~57 MB, far over the proxy's upload limit. If both fail, or the box has no
 * ffmpeg, the recording goes up exactly as it came. The proxy decides, and a
 * refusal sends the transcribe route on to the box's own engine. Nothing here
 * ever throws: the caller is a fallback chain.
 *
 * WHAT is touched: Matroska/WebM only, recognised by its EBML magic rather
 * than by the name or type the browser chose. Firefox records Ogg and Safari
 * MP4, and both reach the proxy exactly as they always have. The on-box engine
 * needs none of this: faster-whisper decodes the duration-less file as it is.
 *
 * SERVER ONLY: this spawns ffmpeg and writes temp files.
 */

import { promises as fs } from "fs";
import os from "os";
import path from "@/lib/runtime-path";
import { failureDetail, runChild, type ChildResult } from "@/lib/child-run";

/** Resolved on the PATH, where install.sh's `ffmpeg_install` step puts it. */
export const FFMPEG_BIN = "ffmpeg";

/** The four bytes every Matroska file, WebM included, starts with. */
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const;

// A copy-only remux of the largest recording the route admits (8 MB) takes
// well under a second on a Nano. The budget is for a box that is busy, not for
// a slow remux. A copy that outlives it is pathological, and a transcode after
// it would only make the user wait longer for the same answer.
const REMUX_TIMEOUT_MS = 20_000;
// Decoding and re-encoding half an hour of speech is tens of seconds on a
// Nano's CPU. The transcode is the rare path, so it may take its time.
const TRANSCODE_TIMEOUT_MS = 90_000;
// Mono Opus at 32 kb/s is transparent to a transcriber and close to what
// MediaRecorder picks itself, so a transcoded recording is no larger than the
// one the route's size cap already let in.
const TRANSCODE_BITRATE = "32k";

/** How the recording reached the proxy, for the box's log and for tests. */
export type CloudAudioPreparation = "as-is" | "remuxed" | "transcoded";

export interface CloudAudio {
  file: Blob;
  name: string;
  prepared: CloudAudioPreparation;
}

/** Does this recording start like a Matroska/WebM file? */
export function isMatroska(bytes: Uint8Array): boolean {
  return bytes.length >= EBML_MAGIC.length && EBML_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * The upstream filename for a WebM we wrote. The proxy uses the extension as a
 * container hint, so it must say `.webm`. The caller's own name is kept when
 * it already does, and anything else about a browser-supplied name stays out.
 */
export function webmName(name: string): string {
  const base = path.basename(name);
  if (/^[\w.-]{1,120}\.webm$/i.test(base)) return base;
  const stem = base.replace(/\.[^.]*$/, "");
  return /^[\w.-]{1,120}$/.test(stem) ? `${stem}.webm` : "recording.webm";
}

function ffmpegEnv(): Record<string, string> {
  return { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" };
}

/** Both passes read the first audio stream, write WebM, and say only errors. */
function ffmpegArgs(input: string, output: string, codec: string[]): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", input,
    "-map", "0:a:0",
    ...codec,
    "-f", "webm",
    output,
  ];
}

/** The pass's output, or null when it produced nothing usable. */
async function outputOf(result: ChildResult, output: string): Promise<Buffer | null> {
  if (result.code !== 0) return null;
  try {
    const bytes = await fs.readFile(output);
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * The recording as the cloud should receive it. Never throws; when nothing
 * could be done the recording comes back untouched, marked `as-is`.
 *
 * `signal` is the caller's request. Once it has aborted, no further ffmpeg pass
 * is started: the upload after this will not happen either, and a 90-second
 * transcode for a browser that has gone is a Nano's CPU spent on nobody.
 */
export async function audioForCloud(audio: { file: Blob; name: string }, signal?: AbortSignal): Promise<CloudAudio> {
  const untouched: CloudAudio = { file: audio.file, name: audio.name, prepared: "as-is" };
  let dir: string | null = null;
  try {
    const bytes = new Uint8Array(await audio.file.arrayBuffer());
    if (!isMatroska(bytes) || signal?.aborted) return untouched;

    dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-remux-"));
    const input = path.join(dir, "recording-in.webm");
    await fs.writeFile(input, bytes, { mode: 0o600 });
    const name = webmName(audio.name);
    const ready = (out: Buffer, prepared: CloudAudioPreparation): CloudAudio => ({
      file: new Blob([new Uint8Array(out)], { type: "audio/webm" }),
      name,
      prepared,
    });

    const remuxed = path.join(dir, "recording-remuxed.webm");
    const copy = await runChild(FFMPEG_BIN, ffmpegArgs(input, remuxed, ["-c", "copy"]), {
      timeoutMs: REMUX_TIMEOUT_MS,
      env: ffmpegEnv(),
      notStarted: "ffmpeg could not be started",
    });
    const copied = await outputOf(copy, remuxed);
    if (copied) return ready(copied, "remuxed");
    console.warn("[stt-remux] copy-only remux failed:", failureDetail(copy, "ffmpeg"));
    // No ffmpeg at all, or a copy that hung: a transcode would fail the same
    // way or take longer to. Upload what the browser made and let the proxy
    // answer. A caller that left meanwhile gets no transcode either.
    if (copy.startFailed || copy.timedOut || signal?.aborted) return untouched;

    const transcodedPath = path.join(dir, "recording-transcoded.webm");
    const transcode = await runChild(
      FFMPEG_BIN,
      ffmpegArgs(input, transcodedPath, ["-ac", "1", "-c:a", "libopus", "-b:a", TRANSCODE_BITRATE]),
      { timeoutMs: TRANSCODE_TIMEOUT_MS, env: ffmpegEnv(), notStarted: "ffmpeg could not be started" },
    );
    const transcoded = await outputOf(transcode, transcodedPath);
    if (transcoded) return ready(transcoded, "transcoded");
    console.warn("[stt-remux] transcode to Opus failed; uploading the recording as recorded:", failureDetail(transcode, "ffmpeg"));
    return untouched;
  } catch (err) {
    console.warn("[stt-remux] could not prepare the recording; uploading it as recorded:", err);
    return untouched;
  } finally {
    // The temp files are somebody's voice. Gone whatever happened.
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
