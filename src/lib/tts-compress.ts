/**
 * A spoken reply, compressed from the WAV an engine wrote into MP3 or Opus.
 *
 * WHY. Kokoro (`clawbox-tts.sh`) only ever writes WAV, and a cloud voice or a
 * Hermes provider may answer WAV too. A reply is one-shot speech for a
 * browser, often across the Remote Access tunnel, and as PCM it is roughly
 * eight times the MP3 and thirteen times the Opus of the same words
 * (src/lib/voice-reply-format.ts has the numbers and the format rule).
 *
 * HOW. The same way `stt-remux.ts` handles a recording: ffmpeg, the binary
 * install.sh's `ffmpeg_install` step puts on the PATH (the box relies on it
 * already — a channel voice note is Opus), run through `runChild` with temp
 * FILES in a private directory. A file and not a pipe: the MP3 muxer writes
 * its Xing header — the frame count a browser reads the duration from — by
 * seeking back once it knows it, which it cannot do into a pipe.
 *
 * NEVER FAILS THE REPLY. No ffmpeg, a missing encoder, a timeout, an output too
 * small to hold speech: every one answers null, and the caller sends the WAV it
 * already has. A larger clip is a slower reply; a missing clip is no reply.
 *
 * SERVER ONLY: spawns ffmpeg and writes temp files.
 */

import { promises as fs } from "fs";
import os from "os";
import path from "./runtime-path";
import { failureDetail, runChild } from "./child-run";
import { FFMPEG_BIN } from "./stt-remux";
import { MIN_COMPRESSED_BYTES, REPLY_FORMAT_MIME, sniffAudioMime } from "./voice-reply-format";

export type CompressedFormat = "mp3" | "opus";

/**
 * Encoding a fifteen-second reply takes a fifth of a second on a laptop and
 * well under two on an Orin Nano's CPU. The budget is for a box that is busy,
 * not for a slow encode — one that outlives it would only hold the reply back
 * for the same words in a smaller file.
 */
export const COMPRESS_TIMEOUT_MS = 20_000;

/**
 * Mono at both rates. 48 kb/s MP3 at the engines' own 24 kHz is clear speech
 * (the MPEG-2 layer III rates are made for it); 32 kb/s Opus is the rate
 * `stt-remux.ts` already trusts for a transcriber, and comfortably above where
 * Opus voice stops sounding like a phone line.
 */
const ENCODERS: Readonly<Record<CompressedFormat, { codec: string[]; muxer: string; ext: string }>> = Object.freeze({
  mp3: { codec: ["-c:a", "libmp3lame", "-b:a", "48k"], muxer: "mp3", ext: "mp3" },
  opus: { codec: ["-c:a", "libopus", "-b:a", "32k"], muxer: "ogg", ext: "ogg" },
});

/** The arguments of one encode: first audio stream, mono, no metadata, errors only. */
export function compressArgs(input: string, output: string, format: CompressedFormat): string[] {
  const encoder = ENCODERS[format];
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", input,
    "-map", "0:a:0",
    "-map_metadata", "-1",
    "-ac", "1",
    ...encoder.codec,
    "-f", encoder.muxer,
    output,
  ];
}

/**
 * `wav` in `format`, or null when it could not be made. Never throws.
 *
 * The output is checked before it is trusted: it must start like the format
 * that was asked for and be big enough to hold speech, so a muxer that wrote
 * headers and gave up is a fallback, not a silent clip.
 */
export async function compressSpeech(
  wav: Uint8Array,
  format: CompressedFormat,
  { timeoutMs = COMPRESS_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<Uint8Array<ArrayBuffer> | null> {
  let dir: string | null = null;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-tts-"));
    const input = path.join(dir, "speech.wav");
    const output = path.join(dir, `speech.${ENCODERS[format].ext}`);
    await fs.writeFile(input, wav, { mode: 0o600 });
    const run = await runChild(FFMPEG_BIN, compressArgs(input, output, format), {
      timeoutMs,
      env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
      notStarted: "ffmpeg could not be started",
    });
    if (run.code !== 0) {
      console.warn(`[tts-compress] could not encode the reply as ${format}; sending the WAV:`, failureDetail(run, "ffmpeg"));
      return null;
    }
    const bytes = new Uint8Array(await fs.readFile(output));
    if (bytes.byteLength < MIN_COMPRESSED_BYTES || sniffAudioMime(bytes) !== REPLY_FORMAT_MIME[format]) {
      console.warn(`[tts-compress] the ${format} encode produced no usable audio; sending the WAV`);
      return null;
    }
    return bytes;
  } catch (err) {
    console.warn("[tts-compress] could not compress the reply; sending the WAV:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    // The temp files are the words of a reply. Gone whatever happened.
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
