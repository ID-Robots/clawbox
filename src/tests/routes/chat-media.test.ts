import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

// A 1x1 PNG — enough for the route to have real bytes to serve.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let tmpHome: string;
let mediaDir: string;
let originalHome: string | undefined;
let originalOpenclawHome: string | undefined;
let GET: (req: NextRequest) => Promise<Response>;

function request(rawPath: string | null, range?: string, mime?: string): NextRequest {
  const url = new URL("http://localhost/setup-api/chat/media");
  if (rawPath !== null) url.searchParams.set("path", rawPath);
  if (mime) url.searchParams.set("mime", mime);
  return new NextRequest(url, range ? { headers: { range } } : undefined);
}

// 64 distinguishable bytes, so a byte range can be checked against the exact
// slice it asked for rather than against a length.
const AUDIO = Buffer.from(Array.from({ length: 64 }, (_, i) => i));

describe("/setup-api/chat/media", () => {
  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalOpenclawHome = process.env.OPENCLAW_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-media-"));
    mediaDir = path.join(tmpHome, ".openclaw", "media", "tool-image-generation");
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, "cat.png"), PNG);
    // The route roots on OPENCLAW_HOME, read at module load — set it before
    // importing. (HOME too, so nothing else falls back to the real one.)
    process.env.HOME = tmpHome;
    process.env.OPENCLAW_HOME = path.join(tmpHome, ".openclaw");
    vi.resetModules();
    GET = (await import("@/app/setup-api/chat/media/route")).GET;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = originalOpenclawHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("serves a generated image from the harness media tree", async () => {
    const res = await GET(request(path.join(mediaDir, "cat.png")));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    // Per-conversation content must never reach a shared cache.
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it("rejects a request with no path", async () => {
    expect((await GET(request(null))).status).toBe(400);
  });

  it("rejects a relative path", async () => {
    expect((await GET(request("cat.png"))).status).toBe(400);
  });

  it("refuses a file outside the media tree", async () => {
    const secret = path.join(tmpHome, ".openclaw", "openclaw.json");
    fs.writeFileSync(secret, "{}");
    // .json is not an allowed type, so this is refused on the type gate...
    expect((await GET(request(secret))).status).toBe(415);
    // ...and a same-extension file outside the tree is refused on containment.
    const outside = path.join(tmpHome, "elsewhere.png");
    fs.writeFileSync(outside, PNG);
    expect((await GET(request(outside))).status).toBe(404);
  });

  it("refuses a sibling directory that merely shares the root's prefix", async () => {
    const sibling = path.join(tmpHome, ".openclaw", "media-backup");
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, "cat.png"), PNG);
    expect((await GET(request(path.join(sibling, "cat.png")))).status).toBe(404);
  });

  it("refuses a traversal that climbs back out of the tree", async () => {
    const outside = path.join(tmpHome, "escape.png");
    fs.writeFileSync(outside, PNG);
    const traversal = path.join(mediaDir, "..", "..", "..", "escape.png");
    expect((await GET(request(traversal))).status).toBe(404);
  });

  it("refuses a symlink inside the tree pointing at a secret (CWE-59)", async () => {
    const secret = path.join(tmpHome, "stolen.png");
    fs.writeFileSync(secret, PNG);
    fs.symlinkSync(secret, path.join(mediaDir, "link.png"));
    expect((await GET(request(path.join(mediaDir, "link.png")))).status).toBe(404);
  });

  it("follows a symlinked root rather than rejecting it", async () => {
    // A shared-identity install moves ~/.openclaw and leaves a link behind;
    // the resolved file must still be recognised as inside the tree.
    const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-real-"));
    const realMedia = path.join(realHome, "media", "tool-image-generation");
    fs.mkdirSync(realMedia, { recursive: true });
    fs.writeFileSync(path.join(realMedia, "cat.png"), PNG);
    fs.rmSync(path.join(tmpHome, ".openclaw"), { recursive: true, force: true });
    fs.symlinkSync(realHome, path.join(tmpHome, ".openclaw"));
    vi.resetModules();
    const freshGET = (await import("@/app/setup-api/chat/media/route")).GET;
    // The harness uses the logical ~/.openclaw path in its message, not the
    // resolved target. The old test passed only the latter and missed the real
    // 404 on every shared-identity device.
    const logical = path.join(tmpHome, ".openclaw", "media", "tool-image-generation", "cat.png");
    const res = await freshGET(request(logical));
    expect(res.status).toBe(200);
    fs.rmSync(realHome, { recursive: true, force: true });
  });

  it("refuses a type it will not serve, including svg", async () => {
    for (const name of ["notes.txt", "doc.pdf", "vector.svg"]) {
      fs.writeFileSync(path.join(mediaDir, name), "x");
      expect((await GET(request(path.join(mediaDir, name)))).status).toBe(415);
    }
  });

  it("refuses a directory that happens to be named like an image", async () => {
    const dir = path.join(mediaDir, "trap.png");
    fs.mkdirSync(dir);
    expect((await GET(request(dir))).status).toBe(404);
  });

  it("404s a file that does not exist", async () => {
    expect((await GET(request(path.join(mediaDir, "missing.png")))).status).toBe(404);
  });

  it("refuses an oversized file rather than buffering it", async () => {
    const big = path.join(mediaDir, "big.png");
    fs.writeFileSync(big, Buffer.alloc(26 * 1024 * 1024));
    expect((await GET(request(big))).status).toBe(413);
  });

  it("serves each allowed type under its own content type", async () => {
    const cases: [string, string][] = [
      ["a.jpg", "image/jpeg"],
      ["a.jpeg", "image/jpeg"],
      ["a.gif", "image/gif"],
      ["a.webp", "image/webp"],
      ["a.bmp", "image/bmp"],
      ["a.avif", "image/avif"],
    ];
    for (const [name, type] of cases) {
      fs.writeFileSync(path.join(mediaDir, name), PNG);
      const res = await GET(request(path.join(mediaDir, name)));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe(type);
    }
  });

  it("matches the extension case-insensitively", async () => {
    fs.writeFileSync(path.join(mediaDir, "SHOUT.PNG"), PNG);
    const res = await GET(request(path.join(mediaDir, "SHOUT.PNG")));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  // ── Spoken replies ────────────────────────────────────────────────────────
  //
  // This route is the only way the chat can reach a generated file, so an
  // audio type it refuses is a spoken reply the user cannot play. The on-device
  // TTS provider writes .wav; the rest are here so changing provider does not
  // turn every answer into a 415.

  it("serves the audio types a spoken reply can arrive as", async () => {
    const cases: [string, string][] = [
      ["v.wav", "audio/wav"],
      ["v.mp3", "audio/mpeg"],
      ["v.ogg", "audio/ogg"],
      ["v.oga", "audio/ogg"],
      ["v.opus", "audio/ogg"],
      ["v.m4a", "audio/mp4"],
      ["v.aac", "audio/aac"],
      ["v.flac", "audio/flac"],
      ["v.weba", "audio/webm"],
    ];
    for (const [name, type] of cases) {
      fs.writeFileSync(path.join(mediaDir, name), AUDIO);
      const res = await GET(request(path.join(mediaDir, name)));
      expect(res.status, name).toBe(200);
      expect(res.headers.get("Content-Type"), name).toBe(type);
    }
  });

  it("tells the player it may ask for byte ranges", async () => {
    // An <audio> element learns this from the FIRST, whole-file response and
    // only seeks afterwards. Without the header the file plays and the
    // scrubber does not move, which is not "native controls".
    fs.writeFileSync(path.join(mediaDir, "v.wav"), AUDIO);
    const res = await GET(request(path.join(mediaDir, "v.wav")));
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
  });

  it("answers a seek with the bytes it asked for", async () => {
    fs.writeFileSync(path.join(mediaDir, "v.wav"), AUDIO);
    const res = await GET(request(path.join(mediaDir, "v.wav"), "bytes=8-15"));
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 8-15/64");
    expect(res.headers.get("Content-Length")).toBe("8");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(AUDIO.subarray(8, 16));
  });

  it("reads an open-ended range to the end of the file", async () => {
    fs.writeFileSync(path.join(mediaDir, "v.wav"), AUDIO);
    const res = await GET(request(path.join(mediaDir, "v.wav"), "bytes=60-"));
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 60-63/64");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(AUDIO.subarray(60));
  });

  it("reads a suffix range from the end", async () => {
    // How a player finds the metadata trailer some containers keep last.
    fs.writeFileSync(path.join(mediaDir, "v.wav"), AUDIO);
    const res = await GET(request(path.join(mediaDir, "v.wav"), "bytes=-4"));
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 60-63/64");
  });

  it("clamps a range that runs past the end", async () => {
    fs.writeFileSync(path.join(mediaDir, "v.wav"), AUDIO);
    const res = await GET(request(path.join(mediaDir, "v.wav"), "bytes=32-9999"));
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 32-63/64");
  });

  it("serves the whole file for a range it does not implement", async () => {
    // Multi-range and anything malformed. Answering the whole file is a legal
    // reply to any range request; a 416 would break playback over a header we
    // simply chose not to support.
    fs.writeFileSync(path.join(mediaDir, "v.wav"), AUDIO);
    for (const header of ["bytes=0-1,4-5", "items=0-1", "bytes=abc-def", "bytes=-", "bytes=99-100"]) {
      const res = await GET(request(path.join(mediaDir, "v.wav"), header));
      expect(res.status, header).toBe(200);
      expect(res.headers.get("Content-Length"), header).toBe("64");
    }
  });

  it("does not answer a suffix range against an empty file", async () => {
    // `bytes=-4` on a zero-byte file has no last four bytes. Answered as a
    // range it produces `Content-Range: bytes 0--1/0`, which is not a range;
    // the whole (empty) file is the honest reply.
    fs.writeFileSync(path.join(mediaDir, "empty.wav"), Buffer.alloc(0));
    const res = await GET(request(path.join(mediaDir, "empty.wav"), "bytes=-4"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Range")).toBeNull();
    expect(res.headers.get("Content-Length")).toBe("0");
  });

  it("serves a .webm recording as audio", async () => {
    // The only .webm this tree holds is audio: MediaRecorder's own output, and
    // what a provider returning Opus-in-WebM would write. Refused as an
    // unsupported type, a spoken reply in that container is a player pointed
    // at a 415.
    fs.writeFileSync(path.join(mediaDir, "v.webm"), AUDIO);
    const res = await GET(request(path.join(mediaDir, "v.webm")));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/webm");
  });

  it("serves extensionless structured audio under an allowlisted MIME hint", async () => {
    const voice = path.join(mediaDir, "voice");
    fs.writeFileSync(voice, AUDIO);
    const res = await GET(request(voice, undefined, "audio/webm; codecs=opus"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/webm");
  });

  it("does not let a MIME hint override a named unsupported type", async () => {
    for (const name of ["secret.json", "document.pdf", "vector.svg"]) {
      const source = path.join(mediaDir, name);
      fs.writeFileSync(source, AUDIO);
      expect((await GET(request(source, undefined, "audio/wav"))).status, name).toBe(415);
    }
  });

  it("still refuses a type it does not serve", async () => {
    fs.writeFileSync(path.join(mediaDir, "clip.mp4"), AUDIO);
    const res = await GET(request(path.join(mediaDir, "clip.mp4")));
    expect(res.status).toBe(415);
  });

  it("applies the range only after the containment checks", async () => {
    // A Range header must not become a way to read a file the route would
    // otherwise refuse.
    const outside = path.join(tmpHome, "secret.wav");
    fs.writeFileSync(outside, AUDIO);
    const res = await GET(request(outside, "bytes=0-7"));
    expect(res.status).toBe(404);
  });
});
