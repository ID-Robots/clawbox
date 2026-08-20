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

function request(rawPath: string | null): NextRequest {
  const url = new URL("http://localhost/setup-api/chat/media");
  if (rawPath !== null) url.searchParams.set("path", rawPath);
  return new NextRequest(url);
}

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
    const res = await freshGET(request(path.join(realMedia, "cat.png")));
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
});
