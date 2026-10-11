import { beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compressSpeech } from "@/lib/tts-compress";
import { sniffAudioMime } from "@/lib/voice-reply-format";

// Starts a real process (ffmpeg): vitest's 5 s test and 10 s hook defaults are
// not enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * src/lib/tts-compress.ts against the REAL ffmpeg.
 *
 * The input is what Kokoro writes — 16-bit mono PCM at 24 kHz in a WAV — and
 * the output must be what the browser is told it is, playable for the same
 * length of time, and a fraction of the size: the whole point of the change.
 *
 * Skipped where ffmpeg with both encoders is not installed. The mocked suite
 * next door covers the logic everywhere.
 */

function output(bin: string, args: string[]): string | null {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}
const encoders = output("ffmpeg", ["-hide_banner", "-encoders"]) ?? "";
const canRun = /\blibopus\b/.test(encoders) && /\blibmp3lame\b/.test(encoders) && output("ffprobe", ["-version"]) !== null;

/** Probed from a FILE: from a pipe neither container can be seeked for its length. */
function duration(bytes: Uint8Array): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-compress-ffmpeg-"));
  try {
    const file = path.join(dir, "clip");
    fs.writeFileSync(file, bytes);
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], {
      encoding: "utf8",
    });
    return Number(out.trim());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!canRun)("compressSpeech with the real ffmpeg", () => {
  let wav: Uint8Array;

  beforeAll(() => {
    // Five seconds of a voice-band signal shaped like Kokoro's output.
    wav = new Uint8Array(execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.3:duration=5:sample_rate=24000",
      "-af", "lowpass=f=3400,highpass=f=120",
      "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1",
    ]));
  });

  it("starts from a WAV the size Kokoro writes — 48 KB a second", () => {
    expect(sniffAudioMime(wav)).toBe("audio/wav");
    expect(wav.byteLength).toBeGreaterThan(5 * 47_000);
  });

  it.each([
    ["mp3", "audio/mpeg", 5],
    ["opus", "audio/ogg", 8],
  ] as const)("makes %s that is what it says, as long as the WAV, and several times smaller", async (format, mime, factor) => {
    const out = await compressSpeech(wav, format);
    expect(out).not.toBeNull();
    expect(sniffAudioMime(out!)).toBe(mime);
    expect(Math.abs(duration(out!) - 5)).toBeLessThan(0.2);
    expect(out!.byteLength * factor).toBeLessThan(wav.byteLength);
  });

  it("answers null for bytes ffmpeg cannot read, rather than throwing", async () => {
    const junk = new Uint8Array(Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVE"), Buffer.alloc(64, 0x42)]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await compressSpeech(junk, "mp3")).toBeNull();
    warn.mockRestore();
  });
});
