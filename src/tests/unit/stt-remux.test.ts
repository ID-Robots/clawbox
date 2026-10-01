import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * src/lib/stt-remux.ts — a chat-microphone recording, made fit for the ClawBox
 * AI proxy before it is uploaded (TASK-1214).
 *
 * The proxy refuses Chrome's MediaRecorder WebM with 400 `unsupported_audio`
 * because that WebM carries no duration. A copy-only ffmpeg remux to a file
 * writes one. ffmpeg is mocked at the wrapper (runChild) here, and the
 * contract around it is what is checked: which recordings are touched, what
 * ffmpeg is asked for, the order of the fallbacks, and that the temp copies of
 * somebody's voice are gone afterwards. src/tests/unit/stt-remux-ffmpeg.test.ts
 * runs the real binary.
 */

const runChild = vi.hoisted(() => vi.fn());
vi.mock("@/lib/child-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/child-run")>();
  return { ...actual, runChild };
});

type Lib = typeof import("@/lib/stt-remux");
let lib: Lib;
let tmp: string;
let originalTmpdir: string | undefined;

/** What MediaRecorder's WebM starts with: the EBML magic, then anything. */
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("rest-of-a-live-recording")]);
const OGG = Buffer.from("OggS\0\x02rest-of-a-firefox-recording");
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisomrest-of-a-safari-recording")]);
const REMUXED = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("same-audio-now-with-a-duration")]);
const TRANSCODED = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("re-encoded-opus")]);

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

function recording(bytes: Buffer, name = "recording.webm", type = "audio/webm") {
  return { file: new Blob([new Uint8Array(bytes)], { type }), name };
}

async function bytesOf(blob: Blob): Promise<Buffer> {
  return Buffer.from(await blob.arrayBuffer());
}

/** The clawbox-remux-* dirs under our private tmpdir. Must be empty after every call. */
function leftovers(): string[] {
  return fs.readdirSync(tmp).filter((d) => d.startsWith("clawbox-remux-"));
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stt-remux-test-"));
  originalTmpdir = process.env.TMPDIR;
  // os.tmpdir() reads TMPDIR on each call, so the module's temp files land in
  // a directory this test owns and can list.
  process.env.TMPDIR = tmp;
  runChild.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.resetModules();
  lib = await import("@/lib/stt-remux");
});

afterEach(() => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("isMatroska", () => {
  it("recognises WebM by its EBML magic", () => {
    expect(lib.isMatroska(WEBM)).toBe(true);
  });

  it("leaves Ogg, MP4 and anything shorter than the magic alone", () => {
    expect(lib.isMatroska(OGG)).toBe(false);
    expect(lib.isMatroska(MP4)).toBe(false);
    expect(lib.isMatroska(Buffer.from([0x1a, 0x45, 0xdf]))).toBe(false);
    expect(lib.isMatroska(Buffer.alloc(0))).toBe(false);
  });
});

describe("webmName", () => {
  it("keeps a name that already says .webm, since the proxy reads the extension", () => {
    expect(lib.webmName("recording.webm")).toBe("recording.webm");
    expect(lib.webmName("voice-note.WEBM")).toBe("voice-note.WEBM");
  });

  it("gives any other name the .webm the remuxed file now is", () => {
    expect(lib.webmName("voice-note.mkv")).toBe("voice-note.webm");
    expect(lib.webmName("blob")).toBe("blob.webm");
  });

  it("keeps nothing of a browser-supplied path or odd characters", () => {
    expect(lib.webmName("../../etc/voice.webm")).toBe("voice.webm");
    expect(lib.webmName("Aufnahme vom 25.09.webm")).toBe("recording.webm");
    expect(lib.webmName("")).toBe("recording.webm");
  });
});

describe("audioForCloud", () => {
  it("does not touch a recording that is not WebM, and never starts ffmpeg for it", async () => {
    for (const [bytes, name, type] of [[OGG, "voice.ogg", "audio/ogg"], [MP4, "voice.mp4", "audio/mp4"]] as const) {
      const input = recording(bytes, name, type);
      const out = await lib.audioForCloud(input);
      expect(out.prepared).toBe("as-is");
      expect(out.file).toBe(input.file);
      expect(out.name).toBe(name);
    }
    // Recognised by content, not by what the browser called it: a WebM label
    // on Ogg bytes is still Ogg.
    expect((await lib.audioForCloud(recording(OGG, "mislabelled.webm"))).prepared).toBe("as-is");
    expect(runChild).not.toHaveBeenCalled();
  });

  it("copy-remuxes a WebM into a FILE, so ffmpeg can write the duration", async () => {
    runChild.mockImplementation(ffmpegWrites(REMUXED));
    const out = await lib.audioForCloud(recording(WEBM, "voice-note.webm"));

    expect(out.prepared).toBe("remuxed");
    expect(await bytesOf(out.file)).toEqual(REMUXED);
    expect(out.file.type).toBe("audio/webm");
    expect(out.name).toBe("voice-note.webm");

    expect(runChild).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = runChild.mock.calls[0];
    expect(bin).toBe("ffmpeg");
    // Copy only: no re-encode, no quality loss, the same audio.
    expect(args.join(" ")).toContain("-c copy");
    expect(args).toContain("-nostdin");
    const output = args[args.length - 1];
    // To a pipe the muxer cannot seek back and the duration stays N/A, which
    // is the whole bug. The output has to be a path.
    expect(output).not.toMatch(/^(pipe:|-$)/);
    expect(args.slice(-3, -1)).toEqual(["-f", "webm"]);
    const input = args[args.indexOf("-i") + 1];
    expect(path.dirname(input)).toBe(path.dirname(output));
    expect(opts.timeoutMs).toBeGreaterThan(0);
    // A deliberate environment, not the web server's.
    expect(Object.keys(opts.env)).toEqual(["PATH"]);
  });

  it("hands ffmpeg the recording in a private temp file and removes it afterwards", async () => {
    let seen: { dirMode: number; fileMode: number; bytes: Buffer } | null = null;
    runChild.mockImplementation(async (_bin: string, args: string[]) => {
      const input = args[args.indexOf("-i") + 1];
      seen = {
        dirMode: fs.statSync(path.dirname(input)).mode & 0o777,
        fileMode: fs.statSync(input).mode & 0o777,
        bytes: fs.readFileSync(input),
      };
      fs.writeFileSync(args[args.length - 1], REMUXED);
      return ran();
    });

    await lib.audioForCloud(recording(WEBM));

    expect(seen).not.toBeNull();
    expect(seen!.bytes).toEqual(WEBM);
    expect(seen!.dirMode).toBe(0o700);
    expect(seen!.fileMode).toBe(0o600);
    expect(leftovers()).toEqual([]);
  });

  it("transcodes to Opus in WebM when the copy fails", async () => {
    runChild
      .mockResolvedValueOnce(ran({ code: 1, stderr: "Could not write header: codec not currently supported in container" }))
      .mockImplementationOnce(ffmpegWrites(TRANSCODED));

    const out = await lib.audioForCloud(recording(WEBM, "voice-note.webm"));

    expect(out.prepared).toBe("transcoded");
    expect(await bytesOf(out.file)).toEqual(TRANSCODED);
    expect(out.name).toBe("voice-note.webm");
    expect(runChild).toHaveBeenCalledTimes(2);
    const args: string[] = runChild.mock.calls[1][1];
    // Opus, not WAV: half an hour of dictation as PCM is far over the proxy's
    // upload limit, while Opus stays the size the route already admitted.
    expect(args.join(" ")).toContain("-c:a libopus");
    expect(args.slice(-3, -1)).toEqual(["-f", "webm"]);
    expect(leftovers()).toEqual([]);
  });

  it("uploads the recording as it came when ffmpeg is not on the box, without a second try", async () => {
    runChild.mockResolvedValue(ran({ code: null, startFailed: true, startError: "ENOENT", stderr: "ffmpeg could not be started" }));
    const input = recording(WEBM);

    const out = await lib.audioForCloud(input);

    expect(out.prepared).toBe("as-is");
    expect(out.file).toBe(input.file);
    expect(runChild).toHaveBeenCalledTimes(1);
    expect(leftovers()).toEqual([]);
  });

  it("does not follow a copy that hung with a longer transcode", async () => {
    runChild.mockResolvedValue(ran({ code: null, signal: "SIGKILL", timedOut: true }));

    const out = await lib.audioForCloud(recording(WEBM));

    expect(out.prepared).toBe("as-is");
    expect(runChild).toHaveBeenCalledTimes(1);
  });

  it("uploads the recording as it came when both passes fail", async () => {
    runChild.mockResolvedValue(ran({ code: 1, stderr: "Invalid data found when processing input" }));
    const input = recording(WEBM);

    const out = await lib.audioForCloud(input);

    expect(out.prepared).toBe("as-is");
    expect(out.file).toBe(input.file);
    expect(out.name).toBe(input.name);
    expect(runChild).toHaveBeenCalledTimes(2);
    expect(leftovers()).toEqual([]);
  });

  it("does not take an empty file for a remux, even when ffmpeg exited 0", async () => {
    runChild
      .mockImplementationOnce(ffmpegWrites(Buffer.alloc(0)))
      .mockImplementationOnce(async () => ran());

    const out = await lib.audioForCloud(recording(WEBM));

    expect(out.prepared).toBe("as-is");
    expect(runChild).toHaveBeenCalledTimes(2);
  });

  it("starts no ffmpeg for a caller that has already gone", async () => {
    const caller = new AbortController();
    caller.abort();

    const out = await lib.audioForCloud(recording(WEBM), caller.signal);

    expect(out.prepared).toBe("as-is");
    expect(runChild).not.toHaveBeenCalled();
  });

  it("does not follow a failed copy with a transcode once the caller has gone", async () => {
    const caller = new AbortController();
    runChild.mockImplementation(async () => {
      caller.abort();
      return ran({ code: 1, stderr: "Invalid data found when processing input" });
    });

    const out = await lib.audioForCloud(recording(WEBM), caller.signal);

    expect(out.prepared).toBe("as-is");
    expect(runChild).toHaveBeenCalledTimes(1);
    expect(leftovers()).toEqual([]);
  });

  it("never throws, whatever goes wrong underneath", async () => {
    runChild.mockRejectedValue(new Error("spawn exploded"));
    const input = recording(WEBM);

    const out = await lib.audioForCloud(input);

    expect(out).toEqual({ file: input.file, name: input.name, prepared: "as-is" });
    expect(leftovers()).toEqual([]);
  });
});
