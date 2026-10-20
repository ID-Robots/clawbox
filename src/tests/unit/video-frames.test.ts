/**
 * Video understanding by frames (src/lib/video-frames.ts).
 *
 * Pinned: where frames are taken (slice midpoints, never the fade-in or the
 * end card, one frame when the length is unknown), that ffmpeg is closed to
 * the network and seeks before it opens, that a box without ffmpeg answers in
 * a sentence, and — where this host has ffmpeg — that a real clip comes back
 * as real JPEGs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Starts real ffmpeg processes in the last block.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0
  && spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

import {
  frameTimes,
  isVideoPath,
  sampleVideoFrames,
  VIDEO_MAX_FRAMES,
  videoPrompt,
} from "@/lib/video-frames";

describe("frameTimes", () => {
  it("takes the midpoint of each equal slice", () => {
    expect(frameTimes(60, 6)).toEqual([5, 15, 25, 35, 45, 55]);
  });

  it("never takes the first or the last instant", () => {
    const times = frameTimes(10, 4);
    expect(times[0]).toBeGreaterThan(0);
    expect(times[times.length - 1]).toBeLessThan(10);
  });

  it("caps the count and keeps at least one", () => {
    expect(frameTimes(100, 50)).toHaveLength(VIDEO_MAX_FRAMES);
    expect(frameTimes(100, 0)).toHaveLength(1);
  });

  it.each([[null], [0], [-3], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    "takes one frame at the start when the length is %s",
    (duration) => {
      expect(frameTimes(duration, 6)).toEqual([0]);
    },
  );
});

describe("isVideoPath", () => {
  it.each(["a.mp4", "b.MOV", "c.webm", "d.mkv", "e.m4v", "f.avi"])("accepts %s", (file) => {
    expect(isVideoPath(file)).toBe(true);
  });

  it.each(["a.png", "b.gif", "c.mp3", "d", "e.mp4.txt"])("refuses %s", (file) => {
    expect(isVideoPath(file)).toBe(false);
  });
});

describe("videoPrompt", () => {
  it("says how many frames, in order, at which seconds, and from how long a video", () => {
    const frames = [0.5, 1.5].map((atSeconds) => ({ base64: "", mime: "image/jpeg" as const, atSeconds }));

    const prompt = videoPrompt(frames, 2, "is anyone waving?");

    expect(prompt).toContain("These 2 images are frames sampled in order from a video 2 seconds long, taken at 0.5s, 1.5s.");
    expect(prompt).toMatch(/cannot be told from a few still frames/);
    expect(prompt).toContain("is anyone waving?");
  });
});

describe("sampleVideoFrames — the ffmpeg it runs", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.doUnmock("@/lib/child-run"));

  it("probes, then seeks before opening, closed to the network, one frame per time", async () => {
    const calls: { bin: string; args: string[] }[] = [];
    vi.doMock("@/lib/child-run", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/child-run")>()),
      runChild: vi.fn(async (bin: string, args: string[]) => {
        calls.push({ bin, args });
        if (bin === "ffprobe") return { code: 0, stdout: "20.0\n", stderr: "", signal: null, timedOut: false, startFailed: false, startError: null };
        fs.writeFileSync(args[args.length - 1], Buffer.from([0xff, 0xd8, 0xff]));
        return { code: 0, stdout: "", stderr: "", signal: null, timedOut: false, startFailed: false, startError: null };
      }),
    }));
    const { sampleVideoFrames: sample } = await import("@/lib/video-frames");

    const result = await sample("/videos/clip.mp4", 2);

    expect("frames" in result && result.frames.map((f) => f.atSeconds)).toEqual([5, 15]);
    expect(calls[0].bin).toBe("ffprobe");
    expect(calls[0].args).toEqual(expect.arrayContaining(["-protocol_whitelist", "file", "/videos/clip.mp4"]));
    const extract = calls.slice(1);
    expect(extract).toHaveLength(2);
    for (const call of extract) {
      expect(call.bin).toBe("ffmpeg");
      const args = call.args;
      expect(args.indexOf("-protocol_whitelist")).toBeGreaterThanOrEqual(0);
      expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file");
      expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
      expect(args[args.indexOf("-frames:v") + 1]).toBe("1");
    }
  });

  it("answers in a sentence on a box without ffmpeg", async () => {
    vi.doMock("@/lib/child-run", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/child-run")>()),
      runChild: vi.fn(async () => ({ code: null, stdout: "", stderr: "", signal: null, timedOut: false, startFailed: true, startError: "ENOENT" })),
    }));
    const { sampleVideoFrames: sample } = await import("@/lib/video-frames");

    expect(await sample("/videos/clip.mp4", 3)).toEqual({ error: "This ClawBox cannot read video: ffmpeg is not installed." });
  });
});

describe.skipIf(!hasFfmpeg)("sampleVideoFrames — on a real clip", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-frames-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns real JPEG frames across a generated four-second clip", async () => {
    const clip = path.join(dir, "clip.mp4");
    const made = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=10",
      "-pix_fmt", "yuv420p", clip,
    ]);
    expect(made.status).toBe(0);

    const result = await sampleVideoFrames(clip, 4);

    if (!("frames" in result)) expect.fail(result.error);
    expect(result.durationSeconds).toBeCloseTo(4, 0);
    expect(result.frames.map((f) => f.atSeconds)).toEqual([0.5, 1.5, 2.5, 3.5]);
    for (const frame of result.frames) {
      const bytes = Buffer.from(frame.base64, "base64");
      expect(bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    }
  });

  it("answers in a sentence for a file that is not a video", async () => {
    const fake = path.join(dir, "fake.mp4");
    fs.writeFileSync(fake, "this is not a video");

    const result = await sampleVideoFrames(fake, 2);

    expect(result).toEqual({ error: expect.stringMatching(/No frame could be read/) });
  });
});
