/**
 * /setup-api/vision/describe-video — video understanding by frames, on the
 * vision model the box already uses, behind the `video_frames` media flag.
 *
 * Pinned: the flag and the link gate both GET (the MCP probe) and POST; the
 * fence is vision/describe's, shared, checked on the typed path and again on
 * the real file, with the type judged on the real file; the frame count is
 * bounded; and a failure is an answer in `error`, never a 500.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "../helpers/env";

const mocks = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  sample: vi.fn(),
  describeImages: vi.fn(),
  hasPersonSession: vi.fn(async () => true),
  activeRunId: vi.fn<() => string | null>(() => null),
  activeRunDirectory: vi.fn<() => string | null>(() => null),
  artifactsDir: vi.fn<(id: string) => string>(),
  getRun: vi.fn<(id: string) => { status: string; directory: string } | undefined>(() => undefined),
}));

vi.mock("@/lib/route-auth", () => ({ requireSession: async () => null }));
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: vi.fn(async (key: string) => mocks.store[key]),
}));
vi.mock("@/lib/owner-session", () => ({ hasPersonSession: mocks.hasPersonSession }));
vi.mock("@/lib/coding-agent", () => ({
  activeRunId: mocks.activeRunId,
  activeRunDirectory: mocks.activeRunDirectory,
  getRun: mocks.getRun,
}));
vi.mock("@/lib/coding-agent-artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-agent-artifacts")>()),
  artifactsDir: mocks.artifactsDir,
}));
vi.mock("@/lib/video-frames", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/video-frames")>()),
  sampleVideoFrames: mocks.sample,
}));
vi.mock("@/lib/vision-describe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vision-describe")>()),
  describeImages: mocks.describeImages,
}));

let GET: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let base: string;
let restoreEnv: () => void;

const post = (body: unknown) =>
  POST(new Request("http://localhost/setup-api/vision/describe-video", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

/** A file wherever the test wants one; the bytes never matter to the route. */
function file(...parts: string[]): string {
  const target = path.join(base, ...parts);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from([0]));
  return target;
}

const FRAMES = [
  { base64: "QQ==", mime: "image/jpeg", atSeconds: 1 },
  { base64: "Qg==", mime: "image/jpeg", atSeconds: 3 },
];

beforeEach(async () => {
  restoreEnv = saveEnv("FILES_ROOT");
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "describe-video-route-")));
  process.env.FILES_ROOT = base;
  mocks.store = { clawai_media_flags: ["video_frames"], clawai_token: "claw_token" };
  mocks.sample.mockReset();
  mocks.sample.mockResolvedValue({ frames: FRAMES, durationSeconds: 4 });
  mocks.describeImages.mockReset();
  mocks.describeImages.mockResolvedValue({ text: "a ball rolls left", error: null, vision: { attempts: [] } });
  mocks.hasPersonSession.mockResolvedValue(true);
  mocks.activeRunId.mockReturnValue(null);
  mocks.activeRunDirectory.mockReturnValue(null);
  mocks.artifactsDir.mockImplementation((id) => path.join(base, "artifacts", id));
  mocks.getRun.mockReturnValue(undefined);
  vi.resetModules();
  const mod = await import("@/app/setup-api/vision/describe-video/route");
  GET = mod.GET;
  POST = mod.POST;
});

afterEach(() => {
  restoreEnv();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("the gate", () => {
  it("is open with the flag on and ClawBox AI linked", async () => {
    expect(await (await GET(new Request("http://localhost/x"))).json()).toEqual({ available: true });
  });

  it.each([
    ["the flag off", () => { mocks.store.clawai_media_flags = ["music"]; }],
    ["no ClawBox AI token", () => { delete mocks.store.clawai_token; }],
  ])("is closed with %s, for the probe and for a call", async (_label, arrange) => {
    arrange();

    expect((await (await GET(new Request("http://localhost/x"))).json()).available).toBe(false);
    const res = await post({ path: file("clip.mp4") });
    expect(res.status).toBe(409);
    expect(mocks.sample).not.toHaveBeenCalled();
  });
});

describe("describing", () => {
  it("samples the frames and describes them together, with the question", async () => {
    const clip = file("videos", "clip.mp4");

    const res = await post({ path: clip, prompt: "which way does it roll?", frames: 2 });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      description: "a ball rolls left",
      error: null,
      frames: [1, 3],
      durationSeconds: 4,
    });
    expect(mocks.sample).toHaveBeenCalledWith(clip, 2);
    const [images, prompt] = mocks.describeImages.mock.calls[0];
    expect(images).toEqual([{ base64: "QQ==", mime: "image/jpeg" }, { base64: "Qg==", mime: "image/jpeg" }]);
    expect(prompt).toContain("frames sampled in order");
    expect(prompt).toContain("which way does it roll?");
  });

  it("bounds the frame count either way", async () => {
    await post({ path: file("a.mp4"), frames: 50 });
    await post({ path: file("b.mp4"), frames: 0 });

    expect(mocks.sample.mock.calls.map((call) => call[1])).toEqual([8, 1]);
  });

  it("refuses a frame count that is not a whole number", async () => {
    expect((await post({ path: file("a.mp4"), frames: 2.5 })).status).toBe(400);
  });

  it("hands a sampling failure back as an answer, not a 500", async () => {
    mocks.sample.mockResolvedValueOnce({ error: "No frame could be read from that file." });

    const res = await post({ path: file("clip.mp4") });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ description: null, error: "No frame could be read from that file." });
    expect(mocks.describeImages).not.toHaveBeenCalled();
  });
});

describe("the fence", () => {
  it("refuses a relative path", async () => {
    expect((await post({ path: "clip.mp4" })).status).toBe(400);
  });

  it("refuses a file outside the allowed tree", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    try {
      const clip = path.join(outside, "clip.mp4");
      fs.writeFileSync(clip, "x");
      expect((await post({ path: clip })).status).toBe(403);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a symlink inside the tree that leads out of it", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    try {
      const real = path.join(outside, "clip.mp4");
      fs.writeFileSync(real, "x");
      const link = path.join(base, "link.mp4");
      fs.symlinkSync(real, link);
      expect((await post({ path: link })).status).toBe(403);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("judges the type on the real file, not on a symlink's name", async () => {
    const notes = file("notes.txt");
    const link = path.join(base, "looks-like.mp4");
    fs.symlinkSync(notes, link);

    const res = await post({ path: link });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/can be described as video/);
  });

  it("answers a missing file as missing", async () => {
    expect((await post({ path: path.join(base, "nope.mp4") })).status).toBe(404);
  });

  it("holds the bearer to the active run's folders", async () => {
    mocks.hasPersonSession.mockResolvedValue(false);
    mocks.activeRunId.mockReturnValue("run-ab12cd34");
    mocks.activeRunDirectory.mockReturnValue(path.join(base, "work"));
    fs.mkdirSync(path.join(base, "work"), { recursive: true });
    fs.mkdirSync(path.join(base, "artifacts", "run-ab12cd34"), { recursive: true });

    expect((await post({ path: file("work", "clip.mp4") })).status).toBe(200);
    expect((await post({ path: file("elsewhere", "clip.mp4") })).status).toBe(403);
  });
});
