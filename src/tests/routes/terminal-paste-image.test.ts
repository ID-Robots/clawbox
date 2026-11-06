/**
 * POST /setup-api/terminal/paste-image: a picture pasted into the Terminal is
 * saved on the box and answered as a path. The owner's Terminal only (another
 * user's shell could not read the owner's file), same-origin, one folder, one
 * size cap — and nothing about the file is the caller's to choose.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const auth = vi.hoisted(() => ({
  requireSession: vi.fn(),
  sessionIdentity: vi.fn(),
  ownerOnlyResponse: vi.fn(),
}));
vi.mock("@/lib/route-auth", () => auth);

import { POST } from "@/app/setup-api/terminal/paste-image/route";
import { TERMINAL_PASTE_MAX_BYTES, isSafePastedPath } from "@/lib/terminal-paste";

const ORIGIN = "http://clawbox.local";
const URL_ = `${ORIGIN}/setup-api/terminal/paste-image`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2]);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-terminal-paste-route-"));
const dir = path.join(home, ".cache", "clawbox", "terminal-paste");
const previousHome = process.env.CLAWBOX_HOME;

function post(body: Uint8Array | null, headers: Record<string, string> = {}, url = URL_) {
  return POST(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "image/png", origin: ORIGIN, ...headers },
      body: body as BodyInit | null,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireSession.mockResolvedValue(null);
  auth.sessionIdentity.mockResolvedValue({ username: "clawbox", isOwner: true });
  auth.ownerOnlyResponse.mockImplementation(() => NextResponse.json({ error: "Only the box owner can do this.", code: "owner_only" }, { status: 403 }));
  process.env.CLAWBOX_HOME = home;
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.CLAWBOX_HOME;
  else process.env.CLAWBOX_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("who may paste", () => {
  it("answers with the session gate's refusal and writes nothing", async () => {
    auth.requireSession.mockResolvedValue(NextResponse.json({ error: "Authentication required" }, { status: 401 }));
    expect((await post(PNG)).status).toBe(401);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("answers another ClawBox user owner_only and writes nothing: their shell could not read the file", async () => {
    auth.sessionIdentity.mockResolvedValue({ username: "alice", isOwner: false });
    const res = await post(PNG);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "owner_only" });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses another site's page", async () => {
    const res = await post(PNG, { origin: "http://evil.example" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe("saving a pasted picture", () => {
  it("answers the absolute path of a file that holds exactly the bytes sent", async () => {
    const res = await post(PNG);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, format: "png", size: PNG.byteLength });
    expect(path.dirname(body.path)).toBe(dir);
    expect(body.name).toMatch(/^paste-\d{8}-\d{6}-[0-9a-f]{8}\.png$/);
    expect(path.basename(body.path)).toBe(body.name);
    expect(new Uint8Array(fs.readFileSync(body.path))).toEqual(PNG);
    // What the Terminal will type at the owner's prompt.
    expect(isSafePastedPath(body.path)).toBe(true);
  });

  it("keeps the picture and its folder the owner's alone", async () => {
    const body = await (await post(PNG)).json();
    expect(fs.statSync(body.path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it.each([
    ["png", PNG], ["jpg", JPG], ["gif", GIF], ["webp", WEBP],
  ] as const)("takes the extension from the bytes: %s", async (format, bytes) => {
    // The browser's claim is deliberately wrong.
    const res = await post(bytes, { "content-type": "text/plain" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.format).toBe(format);
    expect(body.path.endsWith(`.${format}`)).toBe(true);
  });

  it("lets the caller choose nothing about where or under what name", async () => {
    const res = await post(PNG, {}, `${URL_}?name=..%2F..%2Fevil.sh&dir=%2Fetc&path=%2Ftmp%2Fx.png`);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(path.dirname(body.path)).toBe(dir);
    expect(fs.readdirSync(dir)).toEqual([body.name]);
  });

  it("gives two pastes in the same second two files", async () => {
    const a = await (await post(PNG)).json();
    const b = await (await post(JPG)).json();
    expect(a.path).not.toBe(b.path);
    expect(fs.readdirSync(dir).sort()).toEqual([a.name, b.name].sort());
  });
});

describe("what it refuses", () => {
  it("something that is not a picture, whatever it claims to be", async () => {
    const res = await post(new TextEncoder().encode("#!/bin/sh\nrm -rf ~\n"), { "content-type": "image/png" });
    expect(res.status).toBe(415);
    expect((await res.json()).code).toBe("not_an_image");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("an empty body", async () => {
    const none = await post(null);
    expect(none.status).toBe(400);
    expect((await none.json()).code).toBe("empty");
    const zero = await post(new Uint8Array());
    expect(zero.status).toBe(400);
    expect((await zero.json()).code).toBe("empty");
  });

  it("a picture past the cap, by its declared length, before reading it", async () => {
    const res = await post(PNG, { "content-length": String(TERMINAL_PASTE_MAX_BYTES + 1) });
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("too_large");
  });

  it("a picture past the cap that declared nothing", async () => {
    const big = new Uint8Array(TERMINAL_PASTE_MAX_BYTES + 1);
    big.set(PNG);
    const res = await post(big);
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("too_large");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("a body that arrived shorter than it said", async () => {
    const res = await post(PNG, { "content-length": String(PNG.byteLength + 50) });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("incomplete");
  });

  it("a folder that has been replaced by a link to somewhere else", async () => {
    const elsewhere = path.join(home, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.symlinkSync(elsewhere, dir);
    const res = await post(PNG);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("unsafe_folder");
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });
});
