import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * src/lib/tts-compress.ts — a spoken reply's WAV, compressed to MP3 or Opus.
 *
 * ffmpeg is mocked at the wrapper (runChild), as in stt-remux.test.ts: what is
 * checked is what ffmpeg is asked for, that the output is trusted only when it
 * really is the format asked for, that every failure answers null (the caller
 * then sends the WAV — a reply is never lost to this), and that the temp
 * copies of the reply are gone afterwards. tts-compress-ffmpeg.test.ts runs the
 * real binary.
 */

const runChild = vi.hoisted(() => vi.fn());
vi.mock("@/lib/child-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/child-run")>();
  return { ...actual, runChild };
});

type Lib = typeof import("@/lib/tts-compress");
let lib: Lib;
let tmp: string;
let originalTmpdir: string | undefined;

const WAV = new Uint8Array(Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVEfmt "), Buffer.alloc(8192, 3)]));
const MP3 = Buffer.concat([Buffer.from("ID3\x04\0"), Buffer.alloc(2048, 7)]);
const OGG = Buffer.concat([Buffer.from("OggS\0\x02"), Buffer.alloc(2048, 7)]);

function ran(over: Record<string, unknown> = {}) {
  return { code: 0, stdout: "", stderr: "", signal: null, timedOut: false, startFailed: false, startError: null, ...over };
}

/** An ffmpeg that writes `bytes` to the output path it was given, like the real one. */
function ffmpegWrites(bytes: Buffer, over: Record<string, unknown> = {}) {
  return async (_bin: string, args: string[]) => {
    fs.writeFileSync(args[args.length - 1], bytes);
    return ran(over);
  };
}

function leftovers(): string[] {
  return fs.readdirSync(tmp).filter((d) => d.startsWith("clawbox-tts-"));
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tts-compress-test-"));
  originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  runChild.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.resetModules();
  lib = await import("@/lib/tts-compress");
});

afterEach(() => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("compressSpeech", () => {
  it("asks ffmpeg for mono 48 kb/s MP3, file to file, with nothing but PATH", async () => {
    runChild.mockImplementation(ffmpegWrites(MP3));
    const out = await lib.compressSpeech(WAV, "mp3");

    expect(out && Buffer.from(out).equals(MP3)).toBe(true);
    expect(runChild).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = runChild.mock.calls[0];
    expect(bin).toBe("ffmpeg");
    expect(args).toEqual(expect.arrayContaining(["-c:a", "libmp3lame", "-b:a", "48k", "-ac", "1", "-f", "mp3", "-map_metadata", "-1"]));
    // A FILE: the MP3 muxer seeks back to write the frame count the browser
    // reads the duration from.
    const outPath = args[args.length - 1];
    expect(outPath.endsWith(".mp3")).toBe(true);
    expect(outPath).not.toMatch(/^pipe:|^-$/);
    // The input is the WAV we were given, written privately.
    const input = args[args.indexOf("-i") + 1];
    expect(input.startsWith(tmp)).toBe(true);
    expect(Object.keys(opts.env)).toEqual(["PATH"]);
    expect(opts.timeoutMs).toBe(lib.COMPRESS_TIMEOUT_MS);
  });

  it("asks for mono 32 kb/s Opus in Ogg", async () => {
    runChild.mockImplementation(ffmpegWrites(OGG));
    const out = await lib.compressSpeech(WAV, "opus");

    expect(out && Buffer.from(out).equals(OGG)).toBe(true);
    const args: string[] = runChild.mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining(["-c:a", "libopus", "-b:a", "32k", "-f", "ogg"]));
    expect(args[args.length - 1].endsWith(".ogg")).toBe(true);
  });

  it("takes the caller's budget when it has a tighter one", async () => {
    runChild.mockImplementation(ffmpegWrites(MP3));
    await lib.compressSpeech(WAV, "mp3", { timeoutMs: 5000 });
    expect(runChild.mock.calls[0][2].timeoutMs).toBe(5000);
  });

  it("answers null on a box with no ffmpeg — the caller sends the WAV", async () => {
    runChild.mockResolvedValue(ran({ code: null, startFailed: true, startError: "ENOENT" }));
    expect(await lib.compressSpeech(WAV, "mp3")).toBeNull();
    expect(leftovers()).toEqual([]);
  });

  it("answers null when the encoder is missing or ffmpeg fails", async () => {
    runChild.mockResolvedValue(ran({ code: 1, stderr: "Unknown encoder 'libmp3lame'" }));
    expect(await lib.compressSpeech(WAV, "mp3")).toBeNull();
  });

  it("answers null when ffmpeg outlives its budget", async () => {
    runChild.mockResolvedValue(ran({ code: null, timedOut: true, signal: "SIGKILL" }));
    expect(await lib.compressSpeech(WAV, "opus")).toBeNull();
  });

  it("does not trust an output that is not the format it asked for", async () => {
    // Exit 0 with a WAV where an MP3 should be: still the old bytes, wrongly named.
    runChild.mockImplementation(ffmpegWrites(Buffer.from(WAV)));
    expect(await lib.compressSpeech(WAV, "mp3")).toBeNull();
    runChild.mockImplementation(ffmpegWrites(MP3));
    expect(await lib.compressSpeech(WAV, "opus")).toBeNull();
  });

  it("does not trust an output too small to hold speech — headers and nothing else", async () => {
    runChild.mockImplementation(ffmpegWrites(Buffer.from("OggS\0\x02 just headers")));
    expect(await lib.compressSpeech(WAV, "opus")).toBeNull();
  });

  it("answers null when ffmpeg exits 0 and wrote nothing", async () => {
    runChild.mockResolvedValue(ran());
    expect(await lib.compressSpeech(WAV, "mp3")).toBeNull();
  });

  it("never throws, and leaves no copy of the reply behind on any path", async () => {
    runChild.mockRejectedValue(new Error("spawn exploded"));
    await expect(lib.compressSpeech(WAV, "mp3")).resolves.toBeNull();
    runChild.mockImplementation(ffmpegWrites(MP3));
    await lib.compressSpeech(WAV, "mp3");
    expect(leftovers()).toEqual([]);
  });
});
