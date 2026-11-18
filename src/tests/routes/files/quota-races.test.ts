import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TASK-2663 — a member's home quota holds when writes into the home race
 * each other. TASK-2446 checked a write while its bytes arrived, against the
 * home as it was when the write began, so two races got past it:
 *
 * A. Two overwrites of one file at once: each was measured against the file
 *    it saw at its start. When the first landed a smaller file, the second
 *    kept the credit for the old one and could land past the quota.
 * B. A move from Shared into the home measured its sources, then moved them:
 *    something another person moved or renamed into a measured source in
 *    between was carried in unmeasured.
 *
 * Now every write into a limited home lands under the home's lock, checked
 * against what the home holds at that moment and what the landing really
 * replaces; and a move measures again a source that something landed in while
 * it was measured. Route-level only (the Files handlers, real files on disk),
 * so these tests read the same against the code before the fix.
 */

const ROOT = path.join(fs.realpathSync(os.tmpdir()), `clawbox-quota-races-${process.pid}-${Date.now()}`);
const OWNER = path.join(ROOT, "owner");
const SHARED = path.join(OWNER, "Shared");
const IVAN = path.join(ROOT, "home", "ivan");
const DATA = path.join(ROOT, "clawbox-data", "data");
const KB = 1024;
const MB = 1024 * 1024;
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

// A window inside a move's measurement of a folder it would carry: what runs
// here runs after the move has started measuring and before it moves.
const measureWindow = vi.hoisted(() => ({ folder: "", during: null as null | (() => Promise<void>) }));
// Every last check before a write lands (`QuotaWrite.admits`, where the code
// has one): what it was asked and what it answered.
const commitChecks = vi.hoisted(() => [] as Array<{ landed: number; replaced: number; admitted: boolean }>);
vi.mock("@/lib/home-usage", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/home-usage")>();
  return {
    ...real,
    openQuotaWrite: async (...args: Parameters<typeof real.openQuotaWrite>) => {
      const write = await real.openQuotaWrite(...args);
      const admits = (write as { admits?: (landed: number, replaced: number) => boolean } | null)?.admits;
      if (write && typeof admits === "function") {
        write.admits = (landed: number, replaced: number) => {
          const admitted = admits.call(write, landed, replaced);
          commitChecks.push({ landed, replaced, admitted });
          return admitted;
        };
      }
      return write;
    },
    measureHomeUsage: async (dir: string, opts?: Parameters<typeof real.measureHomeUsage>[1]) => {
      const usage = await real.measureHomeUsage(dir, opts);
      if (measureWindow.during && path.resolve(dir) === measureWindow.folder) {
        const run = measureWindow.during;
        measureWindow.during = null;
        await run();
      }
      return usage;
    },
  };
});

type Handler = (req: NextRequest, ctx?: unknown) => Promise<Response>;
let post: Handler;
let put: Handler;
let rename: (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
let resetCaches: () => void;
let resetUsage: () => void;
let measure: (dir: string) => Promise<{ bytes: number } | null>;
let figure: (home: string) => Promise<{ bytes: number } | null>;

const url = (p: string) => new URL(`http://localhost${p}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `ready()` holds (a barrier, not a guess at timing); fail the test if it never does. */
async function until(ready: () => boolean, what: string) {
  for (let i = 0; i < 500; i++) {
    if (ready()) return;
    await sleep(10);
  }
  throw new Error(`never happened: ${what}`);
}

/** A body of `bytes` of `fill`, sent in 64 KB chunks; it waits for `hold` once it has sent `holdAt` bytes. */
function body(bytes: number, { fill = 0x6e, hold, holdAt = bytes / 2 }: { fill?: number; hold?: Promise<void>; holdAt?: number } = {}) {
  const chunk = new Uint8Array(64 * KB).fill(fill);
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let held = false;
      for (let sent = 0; sent < bytes; sent += chunk.length) {
        if (hold && !held && sent >= holdAt) {
          held = true;
          await hold;
        }
        controller.enqueue(chunk.subarray(0, Math.min(chunk.length, bytes - sent)));
      }
      controller.close();
    },
  });
}

/**
 * Every request-body gate and every upload a test starts. Whatever a test
 * fails on — a barrier that never happens, an assertion before a gate is
 * opened — `afterEach` opens every gate and waits for every upload to settle,
 * so none is still writing when the next test resets the fixture.
 */
const inFlight = { gates: [] as Array<() => void>, uploads: [] as Array<Promise<unknown>> };
function tracked<T>(upload: Promise<T>): Promise<T> {
  inFlight.uploads.push(upload);
  return upload;
}

function putStream(dir: string, name: string, stream: ReadableStream<Uint8Array>) {
  return tracked(put(new NextRequest(url(`/setup-api/files?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`), {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: stream,
    duplex: "half",
  } as RequestInit as ConstructorParameters<typeof NextRequest>[1])));
}

/** A multipart upload sent as a stream (no declared length) that waits for `hold` part-way. */
function multipartStream(dir: string, name: string, bytes: number, { fill = 0x6d, hold, holdAt = bytes / 2 }: { fill?: number; hold?: Promise<void>; holdAt?: number } = {}) {
  const boundary = "----race" + Date.now();
  const head = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const chunk = new Uint8Array(64 * KB).fill(fill);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(head);
      let held = false;
      for (let sent = 0; sent < bytes; sent += chunk.length) {
        if (hold && !held && sent >= holdAt) {
          held = true;
          await hold;
        }
        controller.enqueue(chunk.subarray(0, Math.min(chunk.length, bytes - sent)));
      }
      controller.enqueue(tail);
      controller.close();
    },
  });
  return tracked(post(new NextRequest(url(`/setup-api/files?dir=${encodeURIComponent(dir)}`), {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: stream,
    duplex: "half",
  } as RequestInit as ConstructorParameters<typeof NextRequest>[1])));
}

function moveInto(dir: string, paths: string[]) {
  return post(new NextRequest(url(`/setup-api/files?dir=${encodeURIComponent(dir)}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "move", paths }),
  }));
}

function renameTo(segments: string[], newName: string) {
  return rename(
    new NextRequest(url(`/setup-api/files/${segments.join("/")}`), { method: "PUT", body: JSON.stringify({ newName }) }),
    { params: Promise.resolve({ path: segments }) },
  );
}

/** A gate a held body waits at (opened at the latest after the test, see `inFlight`). */
function gate() {
  let open: () => void = () => {};
  const shut = new Promise<void>((r) => { open = r; });
  inFlight.gates.push(open);
  return { shut, open };
}

function setLimits(limits: Record<string, number>) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "config.json"), JSON.stringify({ user_limits: limits }));
}

const temps = (dir: string) => fs.readdirSync(dir).filter((n) => TEMP_RE.test(n));

/** The home as it is on disk, and the server's own figure for it — which must agree. */
async function homeNow() {
  return { onDisk: (await measure(IVAN))!.bytes, figure: (await figure(IVAN))?.bytes };
}

beforeAll(async () => {
  process.env.FILES_ROOT = OWNER;
  process.env.CLAWBOX_ROOT = path.join(ROOT, "clawbox-data");
  vi.resetModules();
  ({ POST: post, PUT: put } = await import("@/app/setup-api/files/route"));
  ({ PUT: rename } = await import("@/app/setup-api/files/[...path]/route"));
  ({ resetFilesScopeCachesForTests: resetCaches } = await import("@/lib/files-scope-server"));
  const usage = await import("@/lib/home-usage");
  resetUsage = usage.resetHomeUsageForTests;
  measure = (dir) => usage.measureHomeUsage(dir);
  figure = (home) => usage.homeUsage(home);
});

beforeEach(() => {
  who.current = { username: "ivan", isOwner: false };
  setLimits({ uploadMaxMb: 0, homeQuotaMb: 1 });
  measureWindow.during = null;
  for (const dir of [IVAN, OWNER, SHARED]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  resetCaches();
  resetUsage();
});

afterEach(async () => {
  for (const open of inFlight.gates.splice(0)) open();
  await Promise.allSettled(inFlight.uploads.splice(0));
  measureWindow.during = null;
});

afterAll(() => {
  delete process.env.FILES_ROOT;
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("A: two overwrites of one file at once", () => {
  // doc.txt holds the whole 1 MB quota. Overwrite A (128 KB) and overwrite B
  // (1.6 MB) both begin while it does, so each starts with 1 MB of credit.
  // A lands first; B then replaces A's 128 KB file, not the 1 MB one: landing
  // it would hold 1.6 MB of the 1 MB quota.
  for (const kind of ["raw", "multipart"] as const) {
    it(`refuses the second at its commit, against the file it really replaces, and keeps the first (${kind} upload)`, async () => {
      fs.writeFileSync(path.join(IVAN, "doc.txt"), Buffer.alloc(MB, 0x30));
      expect((await homeNow()).figure).toBe(MB);
      const a = gate();
      const b = gate();
      commitChecks.length = 0;
      const first = putStream("Home", "doc.txt", body(128 * KB, { fill: 0x41, hold: a.shut, holdAt: 64 * KB }));
      await until(() => temps(IVAN).length === 1, "the first overwrite staging its bytes");
      const second = kind === "raw"
        ? putStream("Home", "doc.txt", body(Math.round(1.6 * MB), { fill: 0x42, hold: b.shut, holdAt: 512 * KB }))
        : multipartStream("Home", "doc.txt", Math.round(1.6 * MB), { fill: 0x42, hold: b.shut, holdAt: 512 * KB });
      // Both are on their way, each begun while doc.txt still held 1 MB — so
      // each was metered with 1 MB of credit — before the first may land.
      await until(() => temps(IVAN).length === 2, "the second overwrite staging its bytes");
      a.open();
      const ra = await first;
      b.open();
      const rb = await second;
      const doc = fs.readFileSync(path.join(IVAN, "doc.txt"));
      const now = await homeNow();
      console.log(`[A ${kind}] first ${ra.status}, second ${rb.status}, doc.txt ${doc.length} bytes, home on disk ${now.onDisk} (figure ${now.figure}) of quota ${MB}`);
      expect(ra.status).toBe(200);
      expect(rb.status).toBe(507);
      expect(await rb.json()).toMatchObject({ code: "quota_exceeded", quotaBytes: MB });
      // The first overwrite's file stands, whole; nothing of the second is left.
      expect(doc.length).toBe(128 * KB);
      expect(doc.every((x) => x === 0x41)).toBe(true);
      expect(temps(IVAN)).toEqual([]);
      expect(now.onDisk).toBeLessThanOrEqual(MB);
      expect(now.figure).toBe(now.onDisk);
      // Refused at the last check before its rename — whole, against the
      // 128 KB file it would really have replaced — not by the body meter.
      expect(commitChecks).toContainEqual({ landed: Math.round(1.6 * MB), replaced: 128 * KB, admitted: false });
      expect(commitChecks).toContainEqual({ landed: 128 * KB, replaced: MB, admitted: true });
    });
  }

  it("lands both when both fit, in the order they finish", async () => {
    setLimits({ uploadMaxMb: 0, homeQuotaMb: 3 });
    fs.writeFileSync(path.join(IVAN, "doc.txt"), Buffer.alloc(MB, 0x30));
    const a = gate();
    const b = gate();
    const first = putStream("Home", "doc.txt", body(128 * KB, { fill: 0x41, hold: a.shut, holdAt: 64 * KB }));
    await until(() => temps(IVAN).length === 1, "the first overwrite staging its bytes");
    const second = putStream("Home", "doc.txt", body(Math.round(1.6 * MB), { fill: 0x42, hold: b.shut, holdAt: 512 * KB }));
    await until(() => temps(IVAN).length === 2, "the second overwrite staging its bytes");
    a.open();
    expect((await first).status).toBe(200);
    b.open();
    expect((await second).status).toBe(200);
    const doc = fs.readFileSync(path.join(IVAN, "doc.txt"));
    expect(doc.length).toBe(Math.round(1.6 * MB));
    expect(doc[0]).toBe(0x42);
    const now = await homeNow();
    expect(now.figure).toBe(now.onDisk);
  });
});

describe("B: a move into the home whose source changes while it is measured", () => {
  // Ivan moves Shared/pack (100 KB) into his home (1 MB quota). While the move
  // measures it, something lands in it that takes it past the quota.
  const pack = path.join(SHARED, "pack");
  beforeEach(() => {
    fs.mkdirSync(pack, { recursive: true });
    fs.writeFileSync(path.join(pack, "small.bin"), Buffer.alloc(100 * KB));
    fs.mkdirSync(path.join(SHARED, "big"), { recursive: true });
    fs.writeFileSync(path.join(SHARED, "big", "big.bin"), Buffer.alloc(2 * MB));
    measureWindow.folder = pack;
  });

  /** Ivan's move of Shared/pack into Home, with `meanwhile` run while it is measured, as the owner. */
  async function ivanMovesPack(meanwhile: () => Promise<Response[]>) {
    const others: number[] = [];
    measureWindow.during = async () => {
      who.current = { username: "owner", isOwner: true };
      try {
        for (const r of await meanwhile()) others.push(r.status);
      } finally {
        who.current = { username: "ivan", isOwner: false };
      }
    };
    const move = await moveInto("Home", ["Shared/pack"]);
    return { move, others };
  }

  it("measures it again when another person moves a folder into it, and refuses the move", async () => {
    const { move, others } = await ivanMovesPack(async () => [await moveInto("Shared/pack", ["Shared/big"])]);
    const now = await homeNow();
    console.log(`[B move] owner's move into Shared/pack ${others.join(",")}, Ivan's move ${move.status}, home on disk ${now.onDisk} of quota ${MB}`);
    expect(others).toEqual([200]);
    expect(move.status).toBe(507);
    expect(await move.json()).toMatchObject({ code: "quota_exceeded", quotaBytes: MB });
    // Nothing moved: Shared/pack still holds both, the home neither.
    expect(fs.existsSync(path.join(pack, "small.bin"))).toBe(true);
    expect(fs.existsSync(path.join(pack, "big", "big.bin"))).toBe(true);
    expect(fs.existsSync(path.join(IVAN, "pack"))).toBe(false);
    expect(now.onDisk).toBeLessThanOrEqual(MB);
  });

  it("measures it again when renames put another folder in its place, and refuses the move", async () => {
    const { move, others } = await ivanMovesPack(async () => [
      await renameTo(["Shared", "pack"], "pack-old"),
      await renameTo(["Shared", "big"], "pack"),
    ]);
    const now = await homeNow();
    console.log(`[B rename] owner's renames ${others.join(",")}, Ivan's move ${move.status}, home on disk ${now.onDisk} of quota ${MB}`);
    expect(others).toEqual([200, 200]);
    expect(move.status).toBe(507);
    expect(await move.json()).toMatchObject({ code: "quota_exceeded", quotaBytes: MB });
    expect(fs.existsSync(path.join(pack, "big.bin"))).toBe(true);
    expect(fs.existsSync(path.join(IVAN, "pack"))).toBe(false);
    expect(now.onDisk).toBeLessThanOrEqual(MB);
  });

  it("measures it again and moves it when what landed still fits", async () => {
    fs.writeFileSync(path.join(SHARED, "note.txt"), Buffer.alloc(10 * KB));
    const { move, others } = await ivanMovesPack(async () => [await moveInto("Shared/pack", ["Shared/note.txt"])]);
    expect(others).toEqual([200]);
    expect(move.status).toBe(200);
    expect(fs.statSync(path.join(IVAN, "pack", "note.txt")).size).toBe(10 * KB);
    const now = await homeNow();
    expect(now.onDisk).toBe(110 * KB);
    expect(now.figure).toBe(now.onDisk);
  });
});

describe("B: a move whose source's folder is replaced while it is measured", () => {
  it("measures it again when renames put another folder where one on its path was, and refuses the move", async () => {
    // Ivan moves Shared/outer/pack (100 KB). While it is measured, the owner
    // renames Shared/outer away and another folder — whose pack holds 2 MB —
    // into its place: Shared/outer/pack is now a different, larger folder.
    const pack = path.join(SHARED, "outer", "pack");
    fs.mkdirSync(pack, { recursive: true });
    fs.writeFileSync(path.join(pack, "small.bin"), Buffer.alloc(100 * KB));
    fs.mkdirSync(path.join(SHARED, "other", "pack"), { recursive: true });
    fs.writeFileSync(path.join(SHARED, "other", "pack", "big.bin"), Buffer.alloc(2 * MB));
    const others: number[] = [];
    measureWindow.folder = pack;
    measureWindow.during = async () => {
      who.current = { username: "owner", isOwner: true };
      try {
        others.push((await renameTo(["Shared", "outer"], "outer-old")).status);
        others.push((await renameTo(["Shared", "other"], "outer")).status);
      } finally {
        who.current = { username: "ivan", isOwner: false };
      }
    };
    const move = await moveInto("Home", ["Shared/outer/pack"]);
    const now = await homeNow();
    console.log(`[B ancestor] owner's renames ${others.join(",")}, Ivan's move ${move.status}, home on disk ${now.onDisk} of quota ${MB}`);
    expect(others).toEqual([200, 200]);
    expect(move.status).toBe(507);
    expect(await move.json()).toMatchObject({ code: "quota_exceeded", quotaBytes: MB });
    expect(fs.existsSync(path.join(SHARED, "outer", "pack", "big.bin"))).toBe(true);
    expect(fs.existsSync(path.join(IVAN, "pack"))).toBe(false);
    expect(now.onDisk).toBeLessThanOrEqual(MB);
  });
});

describe("an upload and a move into one home at once", () => {
  it("lands only what fits: the upload that finished first, not the move measured beside it", async () => {
    // 1 MB quota. Ivan uploads new.bin (700 KB) and, while it is on its way,
    // moves Shared/pack (600 KB) into his home: the two do not fit together.
    const pack = path.join(SHARED, "pack");
    fs.mkdirSync(pack, { recursive: true });
    fs.writeFileSync(path.join(pack, "a.bin"), Buffer.alloc(600 * KB));
    const u = gate();
    const upload = putStream("Home", "new.bin", body(700 * KB, { fill: 0x55, hold: u.shut, holdAt: 256 * KB }));
    await sleep(100);
    // While the move measures Shared/pack, the upload's last bytes arrive.
    measureWindow.folder = pack;
    measureWindow.during = async () => {
      u.open();
      const sizeOf = (f: string) => { try { return fs.statSync(f).size; } catch { return -1; } };
      // Landed (before the fix), or whole in its temporary file, waiting to land.
      const whole = () => fs.existsSync(path.join(IVAN, "new.bin")) || temps(IVAN).some((t) => sizeOf(path.join(IVAN, t)) === 700 * KB);
      for (let i = 0; i < 200 && !whole(); i++) await sleep(10);
      await sleep(50);
    };
    const move = await moveInto("Home", ["Shared/pack"]);
    const up = await upload;
    const now = await homeNow();
    console.log(`[mixed] upload ${up.status}, move ${move.status}, home on disk ${now.onDisk} (figure ${now.figure}) of quota ${MB}`);
    expect(up.status).toBe(200);
    expect(move.status).toBe(507);
    expect(await move.json()).toMatchObject({ code: "quota_exceeded", quotaBytes: MB });
    expect(fs.statSync(path.join(IVAN, "new.bin")).size).toBe(700 * KB);
    expect(fs.existsSync(path.join(pack, "a.bin"))).toBe(true);
    expect(temps(IVAN)).toEqual([]);
    expect(now.onDisk).toBeLessThanOrEqual(MB);
    expect(now.figure).toBe(now.onDisk);
  });

  it("does not refuse an overwrite whose old file was deleted while it was on its way", async () => {
    // doc.txt holds the whole quota; while its 1 MB replacement is on its
    // way, Ivan deletes it in another window. The replacement still fits.
    fs.writeFileSync(path.join(IVAN, "doc.txt"), Buffer.alloc(MB, 0x30));
    expect((await homeNow()).figure).toBe(MB);
    const u = gate();
    const upload = putStream("Home", "doc.txt", body(MB, { fill: 0x44, hold: u.shut, holdAt: 256 * KB }));
    await sleep(100);
    const { DELETE } = await import("@/app/setup-api/files/[...path]/route");
    const del = await DELETE(new NextRequest(url("/setup-api/files/Home/doc.txt"), { method: "DELETE" }), { params: Promise.resolve({ path: ["Home", "doc.txt"] }) });
    expect(del.status).toBe(200);
    u.open();
    const up = await upload;
    const now = await homeNow();
    expect(up.status).toBe(200);
    expect(fs.readFileSync(path.join(IVAN, "doc.txt"))[0]).toBe(0x44);
    expect(now.onDisk).toBe(MB);
    expect(now.figure).toBe(now.onDisk);
    expect(temps(IVAN)).toEqual([]);
  });
});

describe("a quota switched on after uploads made without one", () => {
  it("counts them: the figure the owner's usage column read is not trusted after a landing", async () => {
    setLimits({ uploadMaxMb: 0, homeQuotaMb: 0 });
    // The owner's usage column reads Ivan's empty home.
    expect((await homeNow()).figure).toBe(0);
    expect((await putStream("Home", "first.bin", body(Math.round(1.5 * MB)))).status).toBe(200);
    // The owner sets a 2 MB quota at once: 900 KB more no longer fits.
    setLimits({ uploadMaxMb: 0, homeQuotaMb: 2 });
    const res = await putStream("Home", "second.bin", body(900 * KB));
    expect(res.status).toBe(507);
    expect(await res.json()).toMatchObject({ code: "quota_exceeded", usedBytes: Math.round(1.5 * MB) });
    expect(fs.existsSync(path.join(IVAN, "second.bin"))).toBe(false);
    expect((await homeNow()).onDisk).toBe(Math.round(1.5 * MB));
  });
});
