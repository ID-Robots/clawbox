/**
 * POST /setup-api/vision/describe — text eyes for a local image file.
 *
 * Pinned: only absolute paths to real image files are read (the type is
 * judged after realpath, so a symlink cannot smuggle another kind of file
 * under an image name), the byte cap answers before the upload, and the
 * vision backend's failure is an answer in `error`, never a 500.
 *
 * And the fence is the ROUTE's, not the calling tool's: a credential store
 * answers like a missing file for everyone, and the bearer — the agent's and
 * the run's credential — may only look inside the active run's two folders
 * (or, with no run live, the home folder), while the owner's session cookie
 * keeps the wide absolute-path contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { saveEnv } from "../helpers/env";

const mocks = vi.hoisted(() => ({
  describeImage: vi.fn(async (): Promise<{ text: string | null; error: string | null }> => ({ text: "a red square", error: null })),
  hasOwnerSession: vi.fn(async () => true),
  activeRunId: vi.fn<() => string | null>(() => null),
  activeRunDirectory: vi.fn<() => string | null>(() => null),
  artifactsDir: vi.fn<(id: string) => string>(),
}));
vi.mock("@/lib/vision-describe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vision-describe")>()),
  describeImage: mocks.describeImage,
}));
vi.mock("@/lib/route-auth", () => ({ requireSession: async () => null }));
vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: mocks.hasOwnerSession }));
vi.mock("@/lib/coding-agent", () => ({
  activeRunId: mocks.activeRunId,
  activeRunDirectory: mocks.activeRunDirectory,
}));
vi.mock("@/lib/coding-agent-artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-agent-artifacts")>()),
  artifactsDir: mocks.artifactsDir,
}));

let POST: (req: Request) => Promise<Response>;
let base: string;
let restoreEnv: () => void;

const req = (body: unknown) =>
  new Request("http://localhost/setup-api/vision/describe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** A PNG-named file wherever the test wants one; the bytes never matter to the route. */
function png(...parts: string[]): string {
  const file = path.join(base, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from([0x89]));
  return file;
}

beforeEach(async () => {
  restoreEnv = saveEnv("FILES_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "vision-route-"));
  // Every caller reads under the Files root; the tests' files live in `base`.
  process.env.FILES_ROOT = base;
  mocks.describeImage.mockClear();
  mocks.describeImage.mockResolvedValue({ text: "a red square", error: null });
  mocks.hasOwnerSession.mockResolvedValue(true);
  mocks.activeRunId.mockReturnValue(null);
  mocks.activeRunDirectory.mockReturnValue(null);
  mocks.artifactsDir.mockImplementation((id) => path.join(base, "artifacts", id));
  vi.resetModules();
  POST = (await import("@/app/setup-api/vision/describe/route")).POST;
});

afterEach(() => {
  restoreEnv();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("describing a local image", () => {
  it("describes a real image and passes its actual mime through", async () => {
    const img = path.join(base, "shot.jpg");
    fs.writeFileSync(img, Buffer.from([0xff, 0xd8, 0xff]));
    const res = await POST(req({ path: img, prompt: "what color?" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ description: "a red square", error: null });
    expect(mocks.describeImage).toHaveBeenCalledWith(expect.any(String), "what color?", "image/jpeg");
  });

  it("refuses relative paths, missing files, and non-image extensions", async () => {
    expect((await POST(req({ path: "shot.png" }))).status).toBe(400);
    expect((await POST(req({ path: path.join(base, "missing.png") }))).status).toBe(404);
    const txt = path.join(base, "notes.txt");
    fs.writeFileSync(txt, "hello");
    expect((await POST(req({ path: txt }))).status).toBe(400);
    // The artifacts store serves .gif inline, but the vision proxy does not
    // take one: the derived map must drop it, not inherit it.
    const gif = path.join(base, "anim.gif");
    fs.writeFileSync(gif, "GIF89a");
    expect((await POST(req({ path: gif }))).status).toBe(400);
    expect(mocks.describeImage).not.toHaveBeenCalled();
  });

  it("judges the type of the file actually read, not the symlink's name", async () => {
    const secret = path.join(base, "config.json");
    fs.writeFileSync(secret, "{}");
    const link = path.join(base, "innocent.png");
    fs.symlinkSync(secret, link);
    expect((await POST(req({ path: link }))).status).toBe(400);
    expect(mocks.describeImage).not.toHaveBeenCalled();
  });

  it("refuses an image over the byte cap before uploading anything", async () => {
    const big = path.join(base, "huge.png");
    fs.writeFileSync(big, "");
    // Sparse, so the test costs no disk: what the route judges is the size.
    // 8 MiB is the route's MAX_IMAGE_BYTES.
    fs.truncateSync(big, 8 * 1024 * 1024 + 1);
    const res = await POST(req({ path: big }));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/too large/);
    expect(mocks.describeImage).not.toHaveBeenCalled();
  });

  it("refuses a folder wearing an image name", async () => {
    const dir = path.join(base, "shots.png");
    fs.mkdirSync(dir);
    const res = await POST(req({ path: dir }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That path is not a file." });
    expect(mocks.describeImage).not.toHaveBeenCalled();
  });

  it("relays the backend's failure as an answer, not a 500", async () => {
    mocks.describeImage.mockResolvedValueOnce({ text: null, error: "ClawBox AI is not connected on this device" });
    const res = await POST(req({ path: png("shot.png") }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ description: null, error: "ClawBox AI is not connected on this device" });
  });
});

describe("the fence", () => {
  it("does not follow a symlink planted at the resolved path after the check", async () => {
    // The route resolves symlinks first, so a link at the target path can only
    // be one that appeared after the check — the open must refuse to follow it.
    const secret = path.join(base, "config.json");
    fs.writeFileSync(secret, "{}");
    const link = path.join(base, "late.png");
    fs.symlinkSync(secret, link);
    const realpath = fsp.realpath;
    // Only the target's own resolution is faked; the roots resolve for real.
    const spy = vi.spyOn(fsp, "realpath").mockImplementation((async (p: string) =>
      p === link ? link : realpath.call(fsp, p)) as typeof fsp.realpath);
    try {
      const res = await POST(req({ path: link }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "The file could not be read." });
      expect(mocks.describeImage).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      expect(fsp.realpath).toBe(realpath);
    }
  });

  it("keeps a person at the desktop inside the Files root too", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vision-outside-"));
    try {
      const img = path.join(outside, "shot.png");
      fs.writeFileSync(img, Buffer.from([0x89]));
      const res = await POST(req({ path: img }));
      expect(res.status).toBe(403);
      expect(mocks.describeImage).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("answers a credential store exactly like a missing file, whoever asks", async () => {
    const key = png(".ssh", "key.png");
    const res = await POST(req({ path: key }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "There is no file at that path." });
    expect(mocks.describeImage).not.toHaveBeenCalled();
  });

  it("keeps the bearer inside the active run's working and evidence folders", async () => {
    mocks.hasOwnerSession.mockResolvedValue(false);
    mocks.activeRunId.mockReturnValue("run-abc12345");
    mocks.activeRunDirectory.mockReturnValue(path.join(base, "work"));

    expect((await POST(req({ path: png("work", "index.png") }))).status).toBe(200);
    expect((await POST(req({ path: png("artifacts", "run-abc12345", "shot-001.png") }))).status).toBe(200);

    const elsewhere = await POST(req({ path: png("elsewhere", "photo.png") }));
    expect(elsewhere.status).toBe(403);
    expect((await elsewhere.json()).error).toMatch(/outside the active coding run/);
    // Another run's evidence is not this run's.
    expect((await POST(req({ path: png("artifacts", "run-zzzzzzzz", "shot-001.png") }))).status).toBe(403);
    expect(mocks.describeImage).toHaveBeenCalledTimes(2);
  });

  it("judges the fence on the real file, not on a symlink planted inside the run's folder", async () => {
    mocks.hasOwnerSession.mockResolvedValue(false);
    mocks.activeRunId.mockReturnValue("run-abc12345");
    mocks.activeRunDirectory.mockReturnValue(path.join(base, "work"));
    const outside = png("elsewhere", "photo.png");
    fs.mkdirSync(path.join(base, "work"), { recursive: true });
    fs.symlinkSync(outside, path.join(base, "work", "mine.png"));
    expect((await POST(req({ path: path.join(base, "work", "mine.png") }))).status).toBe(403);
    expect(mocks.describeImage).not.toHaveBeenCalled();
  });

  it("keeps the bearer inside the home folder when no run is live", async () => {
    mocks.hasOwnerSession.mockResolvedValue(false);
    process.env.FILES_ROOT = path.join(base, "home");
    expect((await POST(req({ path: png("home", "Pictures", "cat.png") }))).status).toBe(200);
    const res = await POST(req({ path: png("other", "cat.png") }));
    expect(res.status).toBe(403);
    expect(mocks.describeImage).toHaveBeenCalledTimes(1);
  });

  it("lets the owner's session cookie describe any image the box can read", async () => {
    mocks.activeRunId.mockReturnValue("run-abc12345");
    mocks.activeRunDirectory.mockReturnValue(path.join(base, "work"));
    expect((await POST(req({ path: png("elsewhere", "photo.png") }))).status).toBe(200);
  });
});
