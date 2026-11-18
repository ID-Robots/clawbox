import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TASK-2446 — an upload that replaces a file never writes over it in place:
 * it goes to a temporary file beside it (src/lib/upload-temp.ts) and is
 * renamed over the destination only once the whole body was accepted. So an
 * overwrite refused part-way (the upload limit or the quota, on a body that
 * did not declare its size), failed by an error or abandoned by the client
 * leaves the old file exactly as it was, and no temporary file behind; a
 * successful one replaces it whole, with its permission bits, and the
 * temporary file never shows in a listing or a search. Both upload kinds,
 * for a member of staff and for the owner.
 */

const ROOT = path.join(fs.realpathSync(os.tmpdir()), `clawbox-files-replace-${process.pid}-${Date.now()}`);
const OWNER = path.join(ROOT, "owner");
const IVAN = path.join(ROOT, "home", "ivan");
const DATA = path.join(ROOT, "clawbox-data", "data");
const KB = 1024;
const MB = 1024 * 1024;
const OLD = "the old contents, which must survive";
const TEMP_RE = /^\.clawbox-upload-[0-9a-f]{16}\.part$/;

const who = vi.hoisted(() => ({ current: null as null | { username: string; isOwner: boolean } }));

vi.mock("@/lib/owner-session", () => ({
  personSession: vi.fn(async () => who.current),
  hasPersonSession: vi.fn(async () => who.current !== null),
  hasOwnerSession: vi.fn(async () => who.current?.isOwner === true),
}));
vi.mock("@/lib/org-mode-server", () => ({
  readOrgModeStrict: vi.fn(async () => true),
  readOrgMode: vi.fn(async () => true),
}));
vi.mock("@/lib/clawbox-users", () => ({
  userHomeDir: vi.fn(async (name: string) => (name === "ivan" ? IVAN : null)),
  grantHomeAccess: vi.fn(async () => "ok" as const),
}));

type Handler = (req: NextRequest, ctx?: unknown) => Promise<Response>;
let list: Handler;
let post: Handler;
let put: Handler;
let resetCaches: () => void;
let resetUsage: () => void;

const url = (p: string) => new URL(`http://localhost${p}`);

/** A body that sends `bytes`, then either ends, errors (the client went away) or waits for `release`. */
function body(bytes: number, { fail = false, hold }: { fail?: boolean; hold?: Promise<void> } = {}) {
  const chunk = new Uint8Array(64 * KB).fill(0x6e);
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let sent = 0; sent < bytes; sent += chunk.length) {
        controller.enqueue(chunk.subarray(0, Math.min(chunk.length, bytes - sent)));
        if (hold && sent + chunk.length >= bytes / 2 && sent < bytes / 2) await hold;
      }
      if (fail) controller.error(new Error("the client went away"));
      else controller.close();
    },
  });
}

function putStream(dir: string, name: string, stream: ReadableStream<Uint8Array>) {
  return put(new NextRequest(url(`/setup-api/files?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`), {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: stream,
    duplex: "half",
  } as RequestInit as ConstructorParameters<typeof NextRequest>[1]));
}

/** A multipart upload sent as a stream, so it declares no length. */
function multipartStream(dir: string, name: string, bytes: number, { fail = false } = {}) {
  const boundary = "----b" + Date.now();
  const head = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const chunk = new Uint8Array(64 * KB).fill(0x6d);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(head);
      for (let sent = 0; sent < bytes; sent += chunk.length) controller.enqueue(chunk.subarray(0, Math.min(chunk.length, bytes - sent)));
      // Gone only once the part is being written: the file is open by then.
      if (fail) {
        await new Promise((r) => setTimeout(r, 100));
        controller.error(new Error("the client went away"));
      } else {
        controller.enqueue(tail);
        controller.close();
      }
    },
  });
  return post(new NextRequest(url(`/setup-api/files?dir=${encodeURIComponent(dir)}`), {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: stream,
    duplex: "half",
  } as RequestInit as ConstructorParameters<typeof NextRequest>[1]));
}

function setLimits(limits: Record<string, number>) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "config.json"), JSON.stringify({ user_limits: limits }));
}

const temps = (dir: string) => fs.readdirSync(dir).filter((n) => TEMP_RE.test(n));
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeAll(async () => {
  process.env.FILES_ROOT = OWNER;
  process.env.CLAWBOX_ROOT = path.join(ROOT, "clawbox-data");
  vi.resetModules();
  ({ GET: list, POST: post, PUT: put } = await import("@/app/setup-api/files/route"));
  ({ resetFilesScopeCachesForTests: resetCaches } = await import("@/lib/files-scope-server"));
  ({ resetHomeUsageForTests: resetUsage } = await import("@/lib/home-usage"));
});

beforeEach(() => {
  who.current = { username: "ivan", isOwner: false };
  setLimits({ uploadMaxMb: 1, homeQuotaMb: 3 });
  for (const dir of [IVAN, OWNER, path.join(OWNER, "Shared")]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(IVAN, "doc.txt"), OLD);
  fs.writeFileSync(path.join(OWNER, "doc.txt"), OLD);
  resetCaches();
  resetUsage();
});

afterAll(() => {
  delete process.env.FILES_ROOT;
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("an overwrite refused part-way keeps the old file", () => {
  it("a raw upload over the limit that never declared its size", async () => {
    const res = await putStream("Home", "doc.txt", body(2 * MB));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("upload_too_large");
    await settle();
    expect(fs.readFileSync(path.join(IVAN, "doc.txt"), "utf-8")).toBe(OLD);
    expect(temps(IVAN)).toEqual([]);
  });

  it("a raw upload past the quota that never declared its size", async () => {
    setLimits({ uploadMaxMb: 0, homeQuotaMb: 1 });
    const res = await putStream("Home", "doc.txt", body(Math.round(1.5 * MB)));
    expect(res.status).toBe(507);
    expect((await res.json()).code).toBe("quota_exceeded");
    await settle();
    expect(fs.readFileSync(path.join(IVAN, "doc.txt"), "utf-8")).toBe(OLD);
    expect(temps(IVAN)).toEqual([]);
  });

  it("a multipart upload over the limit that never declared its size", async () => {
    const res = await multipartStream("Home", "doc.txt", 2 * MB);
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("upload_too_large");
    await settle();
    expect(fs.readFileSync(path.join(IVAN, "doc.txt"), "utf-8")).toBe(OLD);
    expect(temps(IVAN)).toEqual([]);
  });
});

describe("an overwrite the client abandons keeps the old file", () => {
  it("a raw upload, for a member of staff and for the owner", async () => {
    for (const [as, dir, folder] of [[{ username: "ivan", isOwner: false }, "Home", IVAN], [{ username: "owner", isOwner: true }, "", OWNER]] as const) {
      who.current = as;
      const res = await putStream(dir, "doc.txt", body(300 * KB, { fail: true }));
      expect(res.status, as.username).toBeGreaterThanOrEqual(400);
      await settle();
      expect(fs.readFileSync(path.join(folder, "doc.txt"), "utf-8"), as.username).toBe(OLD);
      expect(temps(folder), as.username).toEqual([]);
    }
  });

  it("a multipart upload, for a member of staff and for the owner", async () => {
    for (const [as, dir, folder] of [[{ username: "ivan", isOwner: false }, "Home", IVAN], [{ username: "owner", isOwner: true }, "", OWNER]] as const) {
      who.current = as;
      const res = await multipartStream(dir, "doc.txt", 300 * KB, { fail: true });
      expect(res.status, as.username).toBeGreaterThanOrEqual(400);
      await settle();
      expect(fs.readFileSync(path.join(folder, "doc.txt"), "utf-8"), as.username).toBe(OLD);
      expect(temps(folder), as.username).toEqual([]);
    }
  });
});

describe("an overwrite that succeeds", () => {
  it("replaces the file whole only once the body has arrived, and leaves no temporary file", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => { release = r; });
    const pending = putStream("Home", "doc.txt", body(400 * KB, { hold }));
    // Half-way: the destination still holds the old file; the new bytes are in a
    // temporary file beside it, which no listing or search shows.
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.readFileSync(path.join(IVAN, "doc.txt"), "utf-8")).toBe(OLD);
    expect(temps(IVAN)).toHaveLength(1);
    const shown = await (await list(new NextRequest(url("/setup-api/files?dir=Home")))).json();
    expect(shown.files.map((f: { name: string }) => f.name).some((n: string) => TEMP_RE.test(n))).toBe(false);
    const found = await (await list(new NextRequest(url("/setup-api/files?dir=Home&search=clawbox-upload&hidden=1")))).json();
    expect(found.files).toEqual([]);
    release();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(fs.statSync(path.join(IVAN, "doc.txt")).size).toBe(400 * KB);
    expect(temps(IVAN)).toEqual([]);
  });

  it("keeps the replaced file's permission bits, for both upload kinds", async () => {
    who.current = { username: "owner", isOwner: true };
    fs.chmodSync(path.join(OWNER, "doc.txt"), 0o640);
    expect((await putStream("", "doc.txt", body(10 * KB))).status).toBe(200);
    expect(fs.statSync(path.join(OWNER, "doc.txt")).mode & 0o777).toBe(0o640);
    fs.chmodSync(path.join(OWNER, "doc.txt"), 0o600);
    expect((await multipartStream("", "doc.txt", 20 * KB)).status).toBe(200);
    expect(fs.statSync(path.join(OWNER, "doc.txt")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(OWNER, "doc.txt")).size).toBe(20 * KB);
    expect(temps(OWNER)).toEqual([]);
  });

  it("counts the replacement once against the quota, net of what it replaced", async () => {
    setLimits({ uploadMaxMb: 0, homeQuotaMb: 2 });
    fs.writeFileSync(path.join(IVAN, "doc.txt"), Buffer.alloc(Math.round(1.5 * MB)));
    // 1.5 MB replaced by 1.5 MB: fits, because the old file gives its room back.
    expect((await putStream("Home", "doc.txt", body(Math.round(1.5 * MB)))).status).toBe(200);
    // And the home now holds 1.5 MB, not 3: another 400 KB still fits.
    expect((await putStream("Home", "more.bin", body(400 * KB))).status).toBe(200);
    expect(temps(IVAN)).toEqual([]);
  });
});

describe("a write error", () => {
  it("leaves the old file and no temporary file when the rename cannot happen", async () => {
    who.current = { username: "owner", isOwner: true };
    // A folder of that name: the body is accepted, the rename over it fails.
    fs.mkdirSync(path.join(OWNER, "taken"));
    fs.writeFileSync(path.join(OWNER, "taken", "inside.txt"), OLD);
    const res = await putStream("", "taken", body(10 * KB));
    expect(res.status).toBe(500);
    expect(fs.readFileSync(path.join(OWNER, "taken", "inside.txt"), "utf-8")).toBe(OLD);
    expect(temps(OWNER)).toEqual([]);
  });
});
