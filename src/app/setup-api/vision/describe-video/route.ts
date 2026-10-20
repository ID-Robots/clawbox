import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "@/lib/runtime-path";
import { requireSession } from "@/lib/route-auth";
import { get as configGet } from "@/lib/config-store";
import { isProtectedFilePath } from "@/lib/file-guard";
import { getRun } from "@/lib/coding-agent";
import { safeRunId } from "@/lib/coding-agent-artifacts";
import { readClawaiMediaFlags } from "@/lib/clawai-media-flags";
import { describeImages } from "@/lib/vision-describe";
import { visionAllowedRoots } from "@/lib/vision-file-fence";
import {
  isVideoPath,
  sampleVideoFrames,
  VIDEO_DEFAULT_FRAMES,
  VIDEO_EXTENSIONS,
  VIDEO_MAX_FRAMES,
  videoPrompt,
} from "@/lib/video-frames";

export const dynamic = "force-dynamic";

/** Longest question accepted, in characters. */
const MAX_PROMPT_CHARS = 600;
/** Largest video the route will open. ffmpeg seeks, so this bounds a file, not a read. */
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
/**
 * The vision call's budget for several frames at once — the single-image
 * budget's 60 s plus room for the extra pictures. The MCP tool's own timeout
 * (DESCRIBE_VIDEO_CALL_TIMEOUT_MS) sits above this plus the frame sampling.
 */
const DESCRIBE_FRAMES_TIMEOUT_MS = 90_000;

const ACCEPTED = VIDEO_EXTENSIONS.join(", ");

/** The flag and the link, in one place: GET answers it, POST obeys it. */
async function videoAvailability(): Promise<{ available: boolean; error?: string }> {
  const flags = await readClawaiMediaFlags();
  if (!flags.has("video_frames")) {
    return { available: false, error: "Video understanding is not switched on for this ClawBox yet." };
  }
  const token = await configGet("clawai_token").catch(() => undefined);
  if (typeof token !== "string" || !token.trim()) {
    return { available: false, error: "ClawBox AI is not connected on this device." };
  }
  return { available: true };
}

/**
 * GET → { available } — the MCP server's startup probe for `describe_video`.
 * POST { path, prompt?, frames?, codingRunId? } → { description, error, frames, durationSeconds }
 *
 * Video understanding WITHOUT a video model: a few frames sampled across the
 * file (src/lib/video-frames.ts) described together by the vision model the
 * box already uses. Behind the `video_frames` media flag.
 *
 * Which files may be read is `vision/describe`'s fence, shared
 * (src/lib/vision-file-fence.ts), checked the same way: on the path as typed,
 * and again on the real file once symlinks are resolved. Same failure contract
 * too — an unlinked account or an offline proxy is an answer in `error`, never
 * a 500.
 */
export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  return NextResponse.json(await videoAvailability());
}

export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  let body: { path?: unknown; prompt?: unknown; frames?: unknown; codingRunId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const availability = await videoAvailability();
  if (!availability.available) return NextResponse.json({ error: availability.error }, { status: 409 });

  // Rebuilt from the alphabet rather than passed through — see vision/describe.
  let requestedRunId: string | undefined;
  if (body.codingRunId !== undefined) {
    const safe = safeRunId(body.codingRunId);
    if (safe === null || getRun(safe)?.status !== "running") {
      return NextResponse.json({ error: "Coding run is not active" }, { status: 400 });
    }
    requestedRunId = safe;
  }
  const given = typeof body.path === "string" ? body.path.trim() : "";
  if (!given || !path.isAbsolute(given)) {
    return NextResponse.json({ error: "Pass the absolute path of a video file." }, { status: 400 });
  }
  const prompt = typeof body.prompt === "string" && body.prompt.trim()
    ? body.prompt.trim().slice(0, MAX_PROMPT_CHARS)
    : undefined;
  if (body.frames !== undefined && (typeof body.frames !== "number" || !Number.isInteger(body.frames))) {
    return NextResponse.json({ error: "frames must be a whole number." }, { status: 400 });
  }
  const count = typeof body.frames === "number"
    ? Math.max(1, Math.min(VIDEO_MAX_FRAMES, body.frames))
    : VIDEO_DEFAULT_FRAMES;

  const { roots, refusal } = await visionAllowedRoots(request, requestedRunId);
  const resolved = path.resolve(given);
  let typed: string | null = null;
  for (const root of roots) {
    if (resolved.startsWith(root + path.sep)) {
      typed = resolved;
      break;
    }
  }
  if (typed === null) return NextResponse.json({ error: refusal }, { status: 403 });

  let real: string;
  try {
    real = await fs.realpath(/* turbopackIgnore: true */ typed);
  } catch {
    return NextResponse.json({ error: "There is no file at that path." }, { status: 404 });
  }
  // A secret store answers exactly like a missing file.
  if (isProtectedFilePath(real)) {
    return NextResponse.json({ error: "There is no file at that path." }, { status: 404 });
  }
  let target: string | null = null;
  for (const root of roots) {
    if (real.startsWith(root + path.sep)) {
      target = real;
      break;
    }
  }
  if (target === null) return NextResponse.json({ error: refusal }, { status: 403 });
  // The REAL file's type, never a symlink's name.
  if (!isVideoPath(target)) {
    return NextResponse.json({ error: `Only ${ACCEPTED} files can be described as video.` }, { status: 400 });
  }
  try {
    const stat = await fs.lstat(/* turbopackIgnore: true */ target);
    if (!stat.isFile()) return NextResponse.json({ error: "That path is not a file." }, { status: 400 });
    if (stat.size > MAX_VIDEO_BYTES) {
      return NextResponse.json({ error: "The video is too large: at most 1 GB." }, { status: 413 });
    }
  } catch {
    return NextResponse.json({ error: "The file could not be read." }, { status: 400 });
  }

  const sample = await sampleVideoFrames(target, count);
  if ("error" in sample) return NextResponse.json({ description: null, error: sample.error });
  const described = await describeImages(
    sample.frames.map((frame) => ({ base64: frame.base64, mime: frame.mime })),
    videoPrompt(sample.frames, sample.durationSeconds, prompt),
    DESCRIBE_FRAMES_TIMEOUT_MS,
  );
  return NextResponse.json({
    description: described.text,
    error: described.error,
    frames: sample.frames.map((frame) => frame.atSeconds),
    durationSeconds: sample.durationSeconds,
    vision: described.vision,
  });
}
