/**
 * GET /setup-api/apps/icon/[appId] — TASK-1014 / CodeQL alert 405
 * (js/file-system-race).
 *
 * The local branch used to `stat(path)` for the ETag and then `readFile(path)`
 * for the body: two lookups of the same NAME. The file under an id CHANGES —
 * that is exactly why this route is `no-cache` with a validator rather than
 * `immutable`; an app's generated icon is removed with the app and a different
 * app can take the id. A write landing between the two calls served the OLD
 * file's size and mtime as the ETag with the NEW file's bytes as the body, and
 * the browser cached those bytes under that validator: every later conditional
 * request then answers 304 and the wrong picture stays on the desktop.
 *
 * It reads through one descriptor now — `open`, `fstat`, `readFile(handle)` —
 * so the validator and the body describe the same inode. The invariant that
 * pins it: the SIZE encoded in the ETag is the length of the body served with
 * it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// config-store is deliberately NOT mocked. `DATA_DIR` is resolved from
// CLAWBOX_ROOT when the module is evaluated, and `importOriginal` inside a
// factory hands back a CACHED original — so a spread-mock pinned DATA_DIR to
// whichever tmp root happened to load first and every later test read a
// directory its own afterEach had already deleted. The real module, re-evaluated
// by `vi.resetModules()` against this test's root, is what makes the icon path
// line up. `isInstalled` then reads a config.json that is not there and answers
// false, which is what a box browsing the store does anyway.
let GET: (req: Request, ctx: { params: Promise<{ appId: string }> }) => Promise<Response>;
let root: string;

const APP_ID = "notes";
const iconsDir = () => path.join(root, "data", "icons");
const iconPath = (id = APP_ID) => path.join(iconsDir(), `${id}.png`);

/** A PNG of a given size; only the length and the bytes matter to the route. */
function writeIcon(bytes: number, fill: string, id = APP_ID): Buffer {
  const body = Buffer.alloc(bytes, fill);
  fs.mkdirSync(iconsDir(), { recursive: true });
  fs.writeFileSync(iconPath(id), body);
  return body;
}

const get = (id: string, headers: Record<string, string> = {}) =>
  GET(new Request(`http://localhost/setup-api/apps/icon/${id}`, { headers }), {
    params: Promise.resolve({ appId: id }),
  });

/** The size half of `"<size hex>-<mtime hex>"`. */
function etagSize(etag: string): number {
  return parseInt(etag.replace(/^"/, "").split("-")[0], 16);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-icon-"));
  process.env.CLAWBOX_ROOT = root;
  // Nothing in this suite may reach clawbox.com; the store proxy is the
  // fallback for an icon that is not on disk.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.resetModules();
  GET = (await import("@/app/setup-api/apps/icon/[appId]/route")).GET;
});

afterEach(() => {
  delete process.env.CLAWBOX_ROOT;
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("serving a cached icon", () => {
  it("serves the bytes with a validator that describes them", async () => {
    const body = writeIcon(64, "a");
    const res = await get(APP_ID);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("public, no-cache");
    const served = Buffer.from(await res.arrayBuffer());
    expect(served.equals(body)).toBe(true);
    // The invariant the single descriptor buys: the ETag's size IS the body's.
    expect(etagSize(res.headers.get("ETag")!)).toBe(served.byteLength);
  });

  it("answers 304 to a matching validator without a body", async () => {
    writeIcon(64, "a");
    const first = await get(APP_ID);
    const etag = first.headers.get("ETag")!;

    const second = await get(APP_ID, { "if-none-match": etag });
    expect(second.status).toBe(304);
    expect(second.headers.get("ETag")).toBe(etag);
    expect((await second.arrayBuffer()).byteLength).toBe(0);
  });

  it("gives a REPLACED icon a new validator, and that validator matches the new bytes", async () => {
    // The failure the rewrite removes: an id whose picture changed serving the
    // previous size and mtime over the new bytes, which a browser then keeps.
    writeIcon(64, "a");
    const before = await get(APP_ID);
    const beforeTag = before.headers.get("ETag")!;
    expect(etagSize(beforeTag)).toBe(64);

    const replacement = writeIcon(128, "b");
    fs.utimesSync(iconPath(), 2_000_000, 2_000_000);

    const after = await get(APP_ID);
    const served = Buffer.from(await after.arrayBuffer());
    const afterTag = after.headers.get("ETag")!;

    expect(served.equals(replacement)).toBe(true);
    expect(afterTag).not.toBe(beforeTag);
    expect(etagSize(afterTag)).toBe(served.byteLength);
    // The old validator must no longer satisfy the new file.
    expect((await get(APP_ID, { "if-none-match": beforeTag })).status).toBe(200);
  });

  it("keeps the validator honest across a run of different sizes", async () => {
    for (const size of [1, 17, 300, 4096]) {
      writeIcon(size, "c");
      fs.utimesSync(iconPath(), 1_000_000 + size, 1_000_000 + size);
      const res = await get(APP_ID);
      const served = Buffer.from(await res.arrayBuffer());
      expect(served.byteLength).toBe(size);
      expect(etagSize(res.headers.get("ETag")!)).toBe(size);
    }
  });

  it("leaves no descriptor behind per request", async () => {
    writeIcon(64, "a");
    const before = fs.readdirSync("/proc/self/fd").length;
    for (let i = 0; i < 150; i++) await get(APP_ID);
    // …including the branch where the file is not there and the open throws.
    for (let i = 0; i < 150; i++) await get("absent");
    const after = fs.readdirSync("/proc/self/fd").length;
    expect(after).toBeLessThanOrEqual(before + 5);
  });
});

describe("the app id that names the file", () => {
  it.each([
    ["a parent traversal", "../../config"],
    ["a separator", "a/b"],
    ["a character outside the alphabet", "app$evil"],
    ["an empty id", ""],
  ])("refuses %s with a 400 and touches no file", async (_label, bad) => {
    const res = await get(bad);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid appId");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("serves an id that uses the whole alphabet", async () => {
    const id = "My-App_2";
    const body = writeIcon(32, "d", id);
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
  });
});

describe("falling through to the store", () => {
  it("proxies an icon this box has no copy of", async () => {
    const remote = Buffer.alloc(16, "r");
    vi.mocked(fetch).mockResolvedValue(new Response(remote, { status: 200 }));

    const res = await get(APP_ID);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(remote)).toBe(true);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "https://clawbox.com/store/icons/notes.png",
      expect.anything(),
    );
  });

  it("answers 404 when the store has none either", async () => {
    const res = await get(APP_ID);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Icon not found");
  });

  it("prefers the local copy and never asks the store for it", async () => {
    writeIcon(64, "a");
    await get(APP_ID);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
