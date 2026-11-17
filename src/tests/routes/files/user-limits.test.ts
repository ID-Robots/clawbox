import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TASK-2446 — the Files API holds a signed-in user other than the owner to
 * the owner's upload size limit (both upload kinds) and, for a write into
 * their own home on an organisation box, to their home quota: an upload past
 * either is refused with a code and the numbers, before a byte is read when
 * the body declares its size, and nothing of it is left on the disk. The
 * owner and the agent's bearer are never limited.
 */

const ROOT = path.join(fs.realpathSync(os.tmpdir()), `clawbox-files-limits-${process.pid}-${Date.now()}`);
const OWNER = path.join(ROOT, "owner");
const IVAN = path.join(ROOT, "home", "ivan");
const DATA = path.join(ROOT, "clawbox-data", "data");
const KB = 1024;
const MB = 1024 * 1024;

const who = vi.hoisted(() => ({ current: null as null | { username: string; isOwner: boolean } }));
const org = vi.hoisted(() => ({ mode: true as boolean | null }));

vi.mock("@/lib/owner-session", () => ({
  personSession: vi.fn(async () => who.current),
  hasPersonSession: vi.fn(async () => who.current !== null),
  hasOwnerSession: vi.fn(async () => who.current?.isOwner === true),
}));
vi.mock("@/lib/org-mode-server", () => ({
  readOrgModeStrict: vi.fn(async () => org.mode),
  readOrgMode: vi.fn(async () => org.mode === true),
}));
vi.mock("@/lib/clawbox-users", () => ({
  userHomeDir: vi.fn(async (name: string) => (name === "ivan" ? IVAN : null)),
  grantHomeAccess: vi.fn(async () => "ok" as const),
}));

type Handler = (req: NextRequest, ctx?: unknown) => Promise<Response>;
let post: Handler;
let put: Handler;
let one: { DELETE: Handler };
let resetCaches: () => void;
let resetUsage: () => void;

const url = (p: string) => new URL(`http://localhost${p}`);

/** The owner's limits for everyone else, as data/config.json holds them. */
function setLimits(limits: Record<string, number> | undefined) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "config.json"), JSON.stringify(limits ? { user_limits: limits } : {}));
}

function putFile(dir: string, name: string, bytes: number, { declare = true }: { declare?: boolean } = {}) {
  const body = Buffer.alloc(bytes, 0x61);
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
  if (declare) headers["Content-Length"] = String(bytes);
  // Undeclared: a streamed body, as a chunked upload arrives — only the meter can stop it.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < body.length; i += 64 * KB) controller.enqueue(new Uint8Array(body.subarray(i, i + 64 * KB)));
      controller.close();
    },
  });
  return put(new NextRequest(url(`/setup-api/files?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`), {
    method: "PUT",
    headers,
    body: declare ? body : stream,
    // Node's fetch needs to be told a stream body is half-duplex.
    ...(declare ? {} : { duplex: "half" }),
  } as RequestInit as ConstructorParameters<typeof NextRequest>[1]));
}

function multipart(dir: string, name: string, bytes: number) {
  const boundary = "----b" + Date.now();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.alloc(bytes, 0x62),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return post(new NextRequest(url(`/setup-api/files?dir=${encodeURIComponent(dir)}`), {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  }));
}

/** A multipart upload that declares its length, as a browser's does. */
function multipartDeclared(dir: string, name: string, bytes: number) {
  const boundary = "----b" + Date.now();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.alloc(bytes, 0x62),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return post(new NextRequest(url(`/setup-api/files?dir=${encodeURIComponent(dir)}`), {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(body.length) },
    body,
  }));
}

beforeAll(async () => {
  for (const dir of [OWNER, IVAN]) fs.mkdirSync(dir, { recursive: true });
  process.env.FILES_ROOT = OWNER;
  process.env.CLAWBOX_ROOT = path.join(ROOT, "clawbox-data");
  vi.resetModules();
  ({ POST: post, PUT: put } = await import("@/app/setup-api/files/route"));
  one = await import("@/app/setup-api/files/[...path]/route") as unknown as typeof one;
  ({ resetFilesScopeCachesForTests: resetCaches } = await import("@/lib/files-scope-server"));
  ({ resetHomeUsageForTests: resetUsage } = await import("@/lib/home-usage"));
});

beforeEach(() => {
  who.current = { username: "ivan", isOwner: false };
  org.mode = true;
  setLimits({ uploadMaxMb: 1, homeQuotaMb: 3 });
  for (const dir of [IVAN, OWNER, path.join(OWNER, "Shared")]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  resetCaches();
  resetUsage();
});

afterAll(() => {
  delete process.env.FILES_ROOT;
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("the upload size limit", () => {
  it("refuses a declared upload over the limit before reading it, naming the limit", async () => {
    const res = await putFile("Home", "big.bin", MB + 1);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe("upload_too_large");
    expect(body.limitBytes).toBe(MB);
    expect(body.error).toContain("1 MB upload limit");
    expect(fs.existsSync(path.join(IVAN, "big.bin"))).toBe(false);
  });

  it("cuts off an undeclared (streamed) upload at the limit and leaves nothing behind", async () => {
    const res = await putFile("Home", "streamed.bin", 2 * MB, { declare: false });
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("upload_too_large");
    expect(fs.existsSync(path.join(IVAN, "streamed.bin"))).toBe(false);
  });

  it("accepts a file exactly at the limit", async () => {
    const res = await putFile("Home", "exact.bin", MB);
    expect(res.status).toBe(200);
    expect(fs.statSync(path.join(IVAN, "exact.bin")).size).toBe(MB);
  });

  it("holds a multipart upload to the limit too", async () => {
    const res = await multipart("Home", "form.bin", MB + 10 * KB);
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("upload_too_large");
    expect(fs.existsSync(path.join(IVAN, "form.bin"))).toBe(false);
    expect((await multipart("Home", "small.bin", 10 * KB)).status).toBe(200);
  });

  it("binds a home box's users in the owner's folders as well", async () => {
    org.mode = false;
    const res = await putFile("", "big.bin", 2 * MB);
    expect(res.status).toBe(413);
    expect(fs.existsSync(path.join(OWNER, "big.bin"))).toBe(false);
  });

  it("never limits the owner or the agent's bearer", async () => {
    who.current = { username: "owner", isOwner: true };
    expect((await putFile("", "owner.bin", 2 * MB)).status).toBe(200);
    who.current = null;
    expect((await putFile("", "agent.bin", 2 * MB, { declare: false })).status).toBe(200);
  });

  it("applies the default (100 MB) when the owner set nothing, and none at 0", async () => {
    setLimits(undefined);
    expect((await putFile("Home", "two.bin", 2 * MB)).status).toBe(200);
    setLimits({ uploadMaxMb: 0, homeQuotaMb: 0 });
    expect((await putFile("Home", "three.bin", 3 * MB)).status).toBe(200);
  });
});

describe("the home quota", () => {
  it("refuses an upload that would take the home past its quota, with what it holds", async () => {
    fs.writeFileSync(path.join(IVAN, "old.bin"), Buffer.alloc(Math.round(2.5 * MB)));
    const res = await putFile("Home", "more.bin", 900 * KB);
    expect(res.status).toBe(507);
    const body = await res.json();
    expect(body.code).toBe("quota_exceeded");
    expect(body.quotaBytes).toBe(3 * MB);
    expect(body.usedBytes).toBe(Math.round(2.5 * MB));
    expect(fs.existsSync(path.join(IVAN, "more.bin"))).toBe(false);
    // What still fits does.
    expect((await putFile("Home", "fits.bin", 400 * KB)).status).toBe(200);
  });

  it("counts what this process wrote since it last measured, upload after upload", async () => {
    for (const n of [1, 2, 3]) expect((await putFile("Home", `f${n}.bin`, 900 * KB)).status, `upload ${n}`).toBe(200);
    const fourth = await putFile("Home", "f4.bin", 900 * KB, { declare: false });
    expect(fourth.status).toBe(507);
    expect((await fourth.json()).code).toBe("quota_exceeded");
  });

  it("gives back the room of a file an upload replaces", async () => {
    fs.writeFileSync(path.join(IVAN, "same.bin"), Buffer.alloc(Math.round(2.8 * MB)));
    expect((await putFile("Home", "same.bin", 900 * KB)).status).toBe(200);
    expect(fs.statSync(path.join(IVAN, "same.bin")).size).toBe(900 * KB);
  });

  it("measures again after a delete, so deleting makes room", async () => {
    fs.writeFileSync(path.join(IVAN, "old.bin"), Buffer.alloc(Math.round(2.9 * MB)));
    expect((await putFile("Home", "x.bin", 500 * KB)).status).toBe(507);
    const del = await one.DELETE(new NextRequest(url("/setup-api/files/Home/old.bin"), { method: "DELETE" }), { params: Promise.resolve({ path: ["Home", "old.bin"] }) });
    expect(del.status).toBe(200);
    expect((await putFile("Home", "x.bin", 500 * KB)).status).toBe(200);
  });

  it("does not count writes into Shared against the home", async () => {
    fs.writeFileSync(path.join(IVAN, "old.bin"), Buffer.alloc(Math.round(2.9 * MB)));
    expect((await putFile("Shared", "minutes.bin", 900 * KB)).status).toBe(200);
  });

  it("refuses a move from Shared into Home past the quota, and allows one that fits", async () => {
    fs.writeFileSync(path.join(IVAN, "old.bin"), Buffer.alloc(Math.round(2.5 * MB)));
    fs.mkdirSync(path.join(OWNER, "Shared", "pack"), { recursive: true });
    fs.writeFileSync(path.join(OWNER, "Shared", "pack", "a.bin"), Buffer.alloc(800 * KB));
    fs.writeFileSync(path.join(OWNER, "Shared", "small.bin"), Buffer.alloc(100 * KB));
    const move = (paths: string[]) => post(new NextRequest(url("/setup-api/files?dir=Home"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "move", paths }),
    }));
    const refused = await move(["Shared/pack"]);
    expect(refused.status).toBe(507);
    expect((await refused.json()).code).toBe("quota_exceeded");
    expect(fs.existsSync(path.join(OWNER, "Shared", "pack", "a.bin"))).toBe(true);
    const moved = await move(["Shared/small.bin"]);
    expect(moved.status).toBe(200);
    expect(fs.existsSync(path.join(IVAN, "small.bin"))).toBe(true);
  });

  it("gives back the room of a file a multipart upload replaces", async () => {
    fs.writeFileSync(path.join(IVAN, "same.bin"), Buffer.alloc(Math.round(2.8 * MB)));
    expect((await multipart("Home", "same.bin", 900 * KB)).status).toBe(200);
    expect(fs.statSync(path.join(IVAN, "same.bin")).size).toBe(900 * KB);
    // Counted once, net of what it replaced: room is left for another 900 KB.
    expect((await multipart("Home", "next.bin", 900 * KB)).status).toBe(200);
  });

  it("holds a multipart upload to the quota on the part's own bytes", async () => {
    fs.writeFileSync(path.join(IVAN, "old.bin"), Buffer.alloc(Math.round(2.5 * MB)));
    const res = await multipart("Home", "more.bin", 900 * KB);
    expect(res.status).toBe(507);
    expect((await res.json()).code).toBe("quota_exceeded");
    expect(fs.existsSync(path.join(IVAN, "more.bin"))).toBe(false);
  });

  it("names whichever bound is lower when a declared upload is past both", async () => {
    // 1 MB upload limit, but only ~0.5 MB of quota left: the quota is the one to deal with.
    fs.writeFileSync(path.join(IVAN, "old.bin"), Buffer.alloc(Math.round(2.5 * MB)));
    const quota = await putFile("Home", "x.bin", 2 * MB);
    expect(quota.status).toBe(507);
    expect((await quota.json()).code).toBe("quota_exceeded");
    // Plenty of quota: the upload limit is.
    fs.rmSync(path.join(IVAN, "old.bin"));
    resetUsage();
    setLimits({ uploadMaxMb: 1, homeQuotaMb: 100 });
    const limit = await putFile("Home", "x.bin", 2 * MB);
    expect(limit.status).toBe(413);
    expect((await limit.json()).code).toBe("upload_too_large");
  });

  it("refuses a declared multipart overwrite past the quota before it opens — the file it would replace is kept", async () => {
    fs.writeFileSync(path.join(IVAN, "keep.bin"), Buffer.alloc(500 * KB, 0x6b));
    fs.writeFileSync(path.join(IVAN, "old.bin"), Buffer.alloc(Math.round(2.4 * MB)));
    // keep.bin gives back 500 KB, but 900 KB still does not fit.
    const res = await multipartDeclared("Home", "keep.bin", 900 * KB);
    expect(res.status).toBe(507);
    expect((await res.json()).code).toBe("quota_exceeded");
    const kept = fs.readFileSync(path.join(IVAN, "keep.bin"));
    expect(kept.length).toBe(500 * KB);
    expect(kept[0]).toBe(0x6b);
  });

  it("holds each move's bytes until it has run, so two moves checked at once cannot share the same room", async () => {
    // Asked of the check itself: two requests through the route at once meet
    // vitest's uneven handling of a mocked module's concurrent imports.
    // Room for one 600 KB move (about 800 KB left of the 3 MB quota), not two.
    fs.writeFileSync(path.join(IVAN, "old.bin"), Buffer.alloc(Math.round(2.2 * MB)));
    fs.writeFileSync(path.join(OWNER, "Shared", "one.bin"), Buffer.alloc(600 * KB));
    fs.writeFileSync(path.join(OWNER, "Shared", "two.bin"), Buffer.alloc(600 * KB));
    const { moveQuotaCheck } = await import("@/lib/user-upload-guard");
    const { fenceFor, memberRoots } = await import("@/lib/files-scope");
    const roots = memberRoots(IVAN, OWNER);
    if (!roots.ok) throw new Error("no member roots");
    const fence = fenceFor({ kind: "member", username: "ivan", roots: roots.roots });
    const check = (name: string) => moveQuotaCheck({ limitedUser: "ivan", fence, destAbs: IVAN, sources: [path.join(OWNER, "Shared", name)] });
    const [a, b] = await Promise.all([check("one.bin"), check("two.bin")]);
    const outcomes = [a, b].map((r) => (r && "refusal" in r ? r.refusal.body.code : r && "hold" in r ? "held" : "none")).sort();
    expect(outcomes).toEqual(["held", "quota_exceeded"]);
    for (const r of [a, b]) if (r && "hold" in r) r.hold.done();
  });

  it("does not apply to the owner, nor without a quota", async () => {
    fs.writeFileSync(path.join(IVAN, "old.bin"), Buffer.alloc(Math.round(2.9 * MB)));
    setLimits({ uploadMaxMb: 1, homeQuotaMb: 0 });
    expect((await putFile("Home", "free.bin", 900 * KB)).status).toBe(200);
  });
});
