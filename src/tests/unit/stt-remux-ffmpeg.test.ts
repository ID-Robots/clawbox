import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { audioForCloud } from "@/lib/stt-remux";

// Starts a real process (ffmpeg / ffprobe): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * src/lib/stt-remux.ts against the REAL ffmpeg (TASK-1214).
 *
 * The recording is made the way MediaRecorder makes one: Opus in WebM,
 * written as a stream with no way to seek back, so the container has no
 * duration (`ffprobe` → `duration=N/A`). That is the file the ClawBox AI proxy
 * refuses. After `audioForCloud` the same audio must carry a duration, and it
 * must still be the same Opus stream: copied, not re-encoded.
 *
 * Skipped where ffmpeg/ffprobe (with libopus, to make the fixture) are not
 * installed. The mocked suite next door covers the logic everywhere.
 */

function output(bin: string, args: string[]): string | null {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}
const canRun = /\blibopus\b/.test(output("ffmpeg", ["-hide_banner", "-encoders"]) ?? "")
  && output("ffprobe", ["-version"]) !== null;

function probe(file: string, entries: string): string {
  return execFileSync("ffprobe", ["-v", "error", "-show_entries", entries, "-of", "default=noprint_wrappers=1", file], {
    encoding: "utf8",
  }).trim();
}

describe.skipIf(!canRun)("audioForCloud with the real ffmpeg", () => {
  let dir: string;
  let live: Buffer;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "stt-remux-ffmpeg-"));
    // Three seconds of tone, encoded as a live recorder would, to stdout.
    live = execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-ac", "1", "-c:a", "libopus", "-b:a", "32k",
      "-f", "webm", "pipe:1",
    ]);
    fs.writeFileSync(path.join(dir, "live.webm"), live);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("starts from a recording with no duration, exactly as the report's live.webm", () => {
    expect(probe(path.join(dir, "live.webm"), "format=duration")).toBe("duration=N/A");
  });

  it("comes back with a duration, the same Opus audio, and a .webm name", async () => {
    const out = await audioForCloud({ file: new Blob([new Uint8Array(live)], { type: "audio/webm" }), name: "recording.webm" });

    expect(out.prepared).toBe("remuxed");
    expect(out.name).toBe("recording.webm");
    expect(out.file.type).toBe("audio/webm");
    const remuxed = path.join(dir, "remuxed.webm");
    fs.writeFileSync(remuxed, Buffer.from(await out.file.arrayBuffer()));

    const duration = Number(probe(remuxed, "format=duration").replace("duration=", ""));
    expect(duration).toBeGreaterThan(2.9);
    expect(duration).toBeLessThan(3.2);
    expect(probe(remuxed, "stream=codec_name")).toBe("codec_name=opus");
    expect(probe(remuxed, "format=format_name")).toContain("webm");
    // Copied, not re-encoded: the size barely moves (cues and a duration).
    expect(Math.abs(out.file.size - live.length)).toBeLessThan(live.length * 0.1);
  });

  it("leaves a recording ffmpeg cannot read as it came", async () => {
    // The EBML magic and nothing a demuxer can use.
    const junk = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 0x42)]);
    const file = new Blob([new Uint8Array(junk)], { type: "audio/webm" });

    const out = await audioForCloud({ file, name: "recording.webm" });

    expect(out.prepared).toBe("as-is");
    expect(out.file).toBe(file);
  });
});
