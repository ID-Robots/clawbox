/**
 * /setup-api/screenshots (TASK-1475): the Screenshot app's list, save and
 * delete. Owner-only, same-origin for writes, one folder, one size cap.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const auth = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/route-auth", () => auth);

import { DELETE, GET, POST } from "@/app/setup-api/screenshots/route";
import { MAX_SCREENSHOT_BYTES } from "@/lib/screenshot/files";

const ORIGIN = "http://clawbox.local";
const URL_ = `${ORIGIN}/setup-api/screenshots`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-screenshots-route-"));
const dir = path.join(root, "Screenshots");
const previousRoot = process.env.FILES_ROOT;

function post(name: string | null, body: Uint8Array | null, headers: Record<string, string> = {}) {
  const url = name === null ? URL_ : `${URL_}?name=${encodeURIComponent(name)}`;
  return POST(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "image/png", origin: ORIGIN, ...headers },
      body: body as BodyInit | null,
    }),
  );
}

function del(name: string, headers: Record<string, string> = {}) {
  return DELETE(new Request(`${URL_}?name=${encodeURIComponent(name)}`, { method: "DELETE", headers: { origin: ORIGIN, ...headers } }));
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireSession.mockResolvedValue(null);
  process.env.FILES_ROOT = root;
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
});

afterAll(() => {
  if (previousRoot === undefined) delete process.env.FILES_ROOT;
  else process.env.FILES_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("auth", () => {
  it("answers every method with the session gate's refusal", async () => {
    auth.requireSession.mockResolvedValue(NextResponse.json({ error: "Authentication required" }, { status: 401 }));
    expect((await GET(new Request(URL_))).status).toBe(401);
    expect((await post("a.png", PNG)).status).toBe(401);
    expect((await del("a.png")).status).toBe(401);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("is owner-only: it never opts in to other users", async () => {
    await GET(new Request(URL_));
    await post("a.png", PNG);
    await del("a.png");
    for (const call of auth.requireSession.mock.calls) expect(call[1]).toBeUndefined();
  });

  it("refuses a cross-origin write", async () => {
    const saved = await post("a.png", PNG, { origin: "http://evil.example" });
    expect(saved.status).toBe(403);
    expect((await saved.json()).code).toBe("cross_origin");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "keep.png"), PNG);
    expect((await del("keep.png", { origin: "http://evil.example" })).status).toBe(403);
    expect(fs.readdirSync(dir)).toEqual(["keep.png"]);
  });
});

describe("GET", () => {
  it("lists nothing before the first save", async () => {
    const response = await GET(new Request(URL_));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ dir: "Screenshots", maxBytes: MAX_SCREENSHOT_BYTES, files: [] });
  });

  it("lists what was saved, newest first", async () => {
    await post("first.png", PNG);
    await post("second.jpg", JPG, { "content-type": "image/jpeg" });
    fs.utimesSync(path.join(dir, "first.png"), new Date(1_000_000), new Date(1_000_000));
    const body = await (await GET(new Request(URL_))).json();
    expect(body.files.map((f: { name: string }) => f.name)).toEqual(["second.jpg", "first.png"]);
  });
});

describe("POST", () => {
  it("saves a PNG into the Screenshots folder and says where", async () => {
    const response = await post("Screenshot_2026-10-10_14-05-07.png", PNG);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      name: "Screenshot_2026-10-10_14-05-07.png",
      path: "Screenshots/Screenshot_2026-10-10_14-05-07.png",
      size: PNG.byteLength,
    });
    expect(fs.readFileSync(path.join(dir, body.name))).toEqual(Buffer.from(PNG));
  });

  it("saves a JPEG", async () => {
    const response = await post("shot.jpg", JPG, { "content-type": "image/jpeg" });
    expect(response.status).toBe(201);
    expect(fs.existsSync(path.join(dir, "shot.jpg"))).toBe(true);
  });

  it("keeps both when the name is taken", async () => {
    await post("shot.png", PNG);
    const body = await (await post("shot.png", PNG)).json();
    expect(body.name).toBe("shot-2.png");
    expect(fs.readdirSync(dir).sort()).toEqual(["shot-2.png", "shot.png"]);
  });

  it("refuses every name that is not a plain file in the folder", async () => {
    for (const name of ["../escape.png", "../../etc/cron.d/x.png", "sub/x.png", "/tmp/x.png", ".x.png", "x.html", "x.png\u0000.html", ""]) {
      const response = await post(name, PNG);
      expect(response.status, JSON.stringify(name)).toBe(400);
      expect((await response.json()).code).toBe("invalid_name");
    }
    expect((await post(null, PNG)).status).toBe(400);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("refuses a body that is not the image it claims to be", async () => {
    const html = await post("page.png", new TextEncoder().encode("<html><script>alert(1)</script>"));
    expect(html.status).toBe(415);
    expect((await html.json()).code).toBe("not_an_image");
    const mismatch = await post("shot.png", JPG);
    expect(mismatch.status).toBe(415);
    expect((await mismatch.json()).code).toBe("type_mismatch");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses an empty body", async () => {
    expect((await post("a.png", null)).status).toBe(400);
    expect((await post("a.png", new Uint8Array())).status).toBe(400);
  });

  it("refuses a body over the cap by its declared length, before reading it", async () => {
    const response = await post("big.png", PNG, { "content-length": String(MAX_SCREENSHOT_BYTES + 1) });
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("too_large");
  });

  it("refuses a body over the cap however it was declared", async () => {
    const big = new Uint8Array(MAX_SCREENSHOT_BYTES + 1024);
    big.set(PNG);
    // Chunked, with no Content-Length to believe: only the meter can stop it.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = 1024 * 1024;
        for (let offset = 0; offset < big.byteLength; offset += chunk) controller.enqueue(big.subarray(offset, offset + chunk));
        controller.close();
      },
    });
    const response = await POST(
      new Request(`${URL_}?name=big.png`, {
        method: "POST",
        headers: { "content-type": "image/png", origin: ORIGIN },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("too_large");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses a body that arrived shorter than it was declared", async () => {
    const response = await post("cut.png", PNG, { "content-length": String(PNG.byteLength + 500) });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("incomplete");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("accepts an image exactly at the cap", async () => {
    const full = new Uint8Array(MAX_SCREENSHOT_BYTES);
    full.set(PNG);
    const response = await post("full.png", full);
    expect(response.status).toBe(201);
    expect(fs.statSync(path.join(dir, "full.png")).size).toBe(MAX_SCREENSHOT_BYTES);
  });
});

describe("DELETE", () => {
  it("removes one screenshot", async () => {
    await post("a.png", PNG);
    await post("b.png", PNG);
    const response = await del("a.png");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(fs.readdirSync(dir)).toEqual(["b.png"]);
  });

  it("answers 404 for one that is not there", async () => {
    const response = await del("ghost.png");
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("not_found");
  });

  it("cannot be pointed outside the folder", async () => {
    const outside = path.join(root, "outside.png");
    fs.writeFileSync(outside, PNG);
    fs.mkdirSync(dir);
    for (const name of ["../outside.png", "/outside.png", "Screenshots/../outside.png", ""]) {
      const response = await del(name);
      expect(response.status, JSON.stringify(name)).toBe(400);
    }
    expect(fs.existsSync(outside)).toBe(true);
  });
});
