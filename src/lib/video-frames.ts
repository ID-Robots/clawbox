/**
 * Video understanding by frames, on the vision model the box already has.
 * SERVER ONLY: this spawns ffprobe and ffmpeg and writes temp files.
 *
 * The ClawBox AI proxy serves an image model, not a video one, and adding a
 * video provider is not on the table — so a video is UNDERSTOOD by sampling a
 * handful of stills across its length and describing them together, in order,
 * in one vision request (`describeImages` in src/lib/vision-describe.ts). The
 * same tool works on both harnesses because it is ClawBox's own. OpenClaw's
 * native video understanding needs a video-capable provider (Google, Moonshot
 * or Qwen on the pinned core), which is exactly what this avoids.
 *
 * Frames are taken at the MIDPOINTS of equal slices of the video rather than
 * at its ends: frame 0 is so often a black fade-in, and the last one a fade-out
 * or an end card, that sampling the edges spends two of a few frames on
 * nothing. Each frame is its own fast seek (`-ss` before `-i`), so a long video
 * costs no more than a short one.
 *
 * Network access is closed to ffmpeg (`-protocol_whitelist file`): the input is
 * a local file, and a container that names an external reference must not
 * turn a description into an outbound request.
 */
import { promises as fs } from "fs";
import os from "os";
import path from "@/lib/runtime-path";
import { failureDetail, runChild } from "@/lib/child-run";
import { FFMPEG_BIN } from "@/lib/stt-remux";

/** Installed beside ffmpeg by the same package. */
export const FFPROBE_BIN = "ffprobe";

/** Frames sampled when the caller does not say. Enough to follow a scene, few enough for one request. */
export const VIDEO_DEFAULT_FRAMES = 6;
/** The most a caller may ask for: each frame is an image in the one vision request. */
export const VIDEO_MAX_FRAMES = 8;
/** Frame width in pixels; never upscaled. Legible text, and a request well under the proxy's body cap. */
export const VIDEO_FRAME_WIDTH = 768;

const PROBE_TIMEOUT_MS = 15_000;
/** Per frame: a fast seek and one decoded picture. A Nano does it in well under a second. */
const FRAME_TIMEOUT_MS = 15_000;

/** The video containers accepted, by extension — what a phone, a screen recorder or a browser writes. */
export const VIDEO_EXTENSIONS = [".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"] as const;

export function isVideoPath(file: string): boolean {
  return (VIDEO_EXTENSIONS as readonly string[]).includes(path.extname(file).toLowerCase());
}

export interface VideoFrame {
  base64: string;
  mime: "image/jpeg";
  /** Where in the video this frame was taken, in seconds. */
  atSeconds: number;
}

export type VideoFrameSample =
  | { frames: VideoFrame[]; durationSeconds: number | null }
  | { error: string };

function toolEnv(): Record<string, string> {
  return { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" };
}

/**
 * When to take `count` frames from a video `durationSeconds` long: the
 * midpoint of each of `count` equal slices. A duration that could not be read
 * gives one frame at the start — something to describe, never a guess at a
 * length nobody measured.
 */
export function frameTimes(durationSeconds: number | null, count: number): number[] {
  const n = Math.max(1, Math.min(VIDEO_MAX_FRAMES, Math.floor(count)));
  if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return [0];
  return Array.from({ length: n }, (_, i) => Math.round(((durationSeconds * (i + 0.5)) / n) * 100) / 100);
}

/** The video's length in seconds, or null when ffprobe could not say. */
export async function probeVideoDuration(file: string): Promise<number | null> {
  const result = await runChild(
    FFPROBE_BIN,
    ["-v", "error", "-protocol_whitelist", "file", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
    { timeoutMs: PROBE_TIMEOUT_MS, env: toolEnv(), notStarted: "ffprobe could not be started", maxStdoutChars: 200 },
  );
  if (result.code !== 0) return null;
  const seconds = Number.parseFloat(result.stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Sample `count` frames from a local video as JPEG.
 *
 * Never throws: a box without ffmpeg, a file that is not a video, a seek that
 * produced nothing — each is an `error` the route hands back as an answer. A
 * frame that fails mid-video is skipped rather than failing the rest; no frame
 * at all is the error.
 */
export async function sampleVideoFrames(file: string, count = VIDEO_DEFAULT_FRAMES): Promise<VideoFrameSample> {
  let dir: string | null = null;
  try {
    const durationSeconds = await probeVideoDuration(file);
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-frames-"));
    const frames: VideoFrame[] = [];
    let lastFailure = "";
    for (const [index, at] of frameTimes(durationSeconds, count).entries()) {
      const out = path.join(dir, `frame-${index}.jpg`);
      const result = await runChild(
        FFMPEG_BIN,
        [
          "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
          "-protocol_whitelist", "file",
          "-ss", String(at),
          "-i", file,
          "-frames:v", "1",
          "-vf", `scale=w='min(${VIDEO_FRAME_WIDTH},iw)':h=-2`,
          "-q:v", "4",
          out,
        ],
        { timeoutMs: FRAME_TIMEOUT_MS, env: toolEnv(), notStarted: "ffmpeg could not be started" },
      );
      if (result.startFailed) return { error: "This ClawBox cannot read video: ffmpeg is not installed." };
      let bytes: Buffer | null = null;
      if (result.code === 0) bytes = await fs.readFile(out).catch(() => null);
      if (bytes && bytes.length > 0) {
        frames.push({ base64: bytes.toString("base64"), mime: "image/jpeg", atSeconds: at });
      } else {
        lastFailure = failureDetail(result, "ffmpeg");
      }
    }
    if (frames.length === 0) {
      console.warn("[video-frames] no frame could be taken:", lastFailure);
      return { error: "No frame could be read from that file; it may not be a video this box can decode." };
    }
    return { frames, durationSeconds };
  } catch (err) {
    console.warn("[video-frames] could not sample the video:", err instanceof Error ? err.message : err);
    return { error: "The video could not be read." };
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The instruction that goes with the frames: what they are, in order, and when. */
export function videoPrompt(frames: VideoFrame[], durationSeconds: number | null, ask?: string): string {
  const when = frames.map((frame) => `${frame.atSeconds}s`).join(", ");
  const length = durationSeconds ? ` from a video ${Math.round(durationSeconds)} seconds long` : " from a video";
  return [
    `These ${frames.length} images are frames sampled in order${length}, taken at ${when}.`,
    "Describe what the video shows and what happens across it, as one account rather than frame by frame: the setting, the people or objects, any visible text (verbatim when short), and how things change between frames.",
    "Say plainly when something cannot be told from a few still frames, such as speech, sound or very fast motion.",
    ...(ask ? [`The person asking wants to know: ${ask}`] : []),
  ].join(" ");
}
