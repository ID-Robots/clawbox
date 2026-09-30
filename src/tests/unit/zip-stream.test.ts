/**
 * A folder, downloaded as one ZIP (src/lib/zip-stream.ts).
 *
 * The archive is read back here with a small reader of its own — central
 * directory first, the way every unzipper finds its entries — and inflated
 * entry by entry, CRC checked, so a header written one byte off fails here and
 * not on the owner's laptop. Where the box has python3, its `zipfile` reads
 * the same bytes as a second, independent implementation.
 *
 * What goes IN is the Files API's rule: a credential file, a link into a
 * credential store, a dependency tree and a linked directory stay out.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { Readable } from "stream";

// python3 is a real process, and so is the 8 MiB archive the cancel case
// reads — both ceilings, per test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const TEST_ROOT = fs.realpathSync(os.tmpdir()) + `/clawbox-zip-tests-${process.pid}-${Date.now()}`;
const PROJ = path.join(TEST_ROOT, "proj");

type Zip = typeof import("@/lib/zip-stream");
let zip: Zip;

interface ReadEntry { name: string; data: Buffer; mode: number; external: number; flags: number; method: number; crc: number }

/** Parse a whole ZIP from its central directory; inflate and CRC-check every entry. */
function readZip(buf: Buffer): Map<string, ReadEntry> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z64 = Number(buf.readBigUInt64LE(eocd - 20 + 8));
    expect(buf.readUInt32LE(z64)).toBe(0x06064b50);
    count = Number(buf.readBigUInt64LE(z64 + 32));
    cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
  }
  const out = new Map<string, ReadEntry>();
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let csize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    let offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    if (extra.length >= 4 && extra.readUInt16LE(0) === 1) {
      let q = 4;
      if (size === 0xffffffff) { size = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (csize === 0xffffffff) { csize = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (offset === 0xffffffff) { offset = Number(extra.readBigUInt64LE(q)); q += 8; }
    }
    expect(buf.readUInt32LE(offset)).toBe(0x04034b50);
    const lName = buf.readUInt16LE(offset + 26);
    const lExtra = buf.readUInt16LE(offset + 28);
    expect(buf.subarray(offset + 30, offset + 30 + lName).toString("utf8")).toBe(name);
    const start = offset + 30 + lName + lExtra;
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    expect(data.length).toBe(size);
    expect(zip.crc32(data) >>> 0).toBe(crc >>> 0);
    out.set(name, { name, data, mode: (external >>> 16) & 0o7777, external, flags, method, crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

const hasPython = (() => {
  try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
})();

const random = Buffer.alloc(300 * 1024);
for (let i = 0; i < random.length; i += 1) random[i] = (i * 2654435761) >>> 24 ^ (i & 0xff);

beforeAll(async () => {
  process.env.FILES_ROOT = TEST_ROOT;
  process.env.CLAWBOX_ROOT = path.join(TEST_ROOT, "clawbox");
  fs.mkdirSync(path.join(PROJ, "src"), { recursive: true });
  fs.mkdirSync(path.join(PROJ, "empty"));
  fs.mkdirSync(path.join(PROJ, ".git"));
  fs.mkdirSync(path.join(PROJ, "node_modules", "left-pad"), { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, ".ssh"));
  fs.writeFileSync(path.join(TEST_ROOT, ".ssh", "id_ed25519"), "PRIVATE KEY");
  fs.writeFileSync(path.join(PROJ, "README.md"), "# Project\n".repeat(200));
  fs.writeFileSync(path.join(PROJ, "src", "index.ts"), "export const answer = 42;\n");
  fs.writeFileSync(path.join(PROJ, "run.sh"), "#!/bin/sh\necho hi\n");
  fs.chmodSync(path.join(PROJ, "run.sh"), 0o755);
  fs.writeFileSync(path.join(PROJ, "Grüße ñ.txt"), "unicode name\n");
  fs.writeFileSync(path.join(PROJ, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(PROJ, ".netrc"), "machine x login y password z");
  fs.writeFileSync(path.join(PROJ, "node_modules", "left-pad", "index.js"), "module.exports = 1;");
  fs.writeFileSync(path.join(PROJ, "photo.jpg"), random);
  fs.writeFileSync(path.join(PROJ, "zero.bin"), "");
  fs.symlinkSync("README.md", path.join(PROJ, "readme-link.md"));
  fs.symlinkSync("src", path.join(PROJ, "src-link"));
  fs.symlinkSync(path.join(TEST_ROOT, ".ssh", "id_ed25519"), path.join(PROJ, "key-link"));
  fs.symlinkSync(path.join(PROJ, "nowhere"), path.join(PROJ, "dangling"));
  vi.resetModules();
  zip = await import("@/lib/zip-stream");
});

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  delete process.env.FILES_ROOT;
  delete process.env.CLAWBOX_ROOT;
});

describe("zipFolderStream — what a downloaded project folder holds", () => {
  it("writes a ZIP whose every entry inflates to the file on disk, under the folder's own name", async () => {
    const buf = await collect(zip.zipFolderStream(PROJ, "proj"));
    const entries = readZip(buf);
    expect([...entries.keys()].sort()).toEqual([
      "proj/",
      "proj/.git/",
      "proj/.git/HEAD",
      "proj/Grüße ñ.txt",
      "proj/README.md",
      "proj/empty/",
      "proj/photo.jpg",
      "proj/readme-link.md",
      "proj/run.sh",
      "proj/src/",
      "proj/src/index.ts",
      "proj/zero.bin",
    ].sort());
    expect(entries.get("proj/README.md")!.data.toString()).toBe("# Project\n".repeat(200));
    expect(entries.get("proj/src/index.ts")!.data.toString()).toBe("export const answer = 42;\n");
    expect(entries.get("proj/photo.jpg")!.data.equals(random)).toBe(true);
    expect(entries.get("proj/zero.bin")!.data.length).toBe(0);
    // A symlinked file is followed, the way the single-file download follows it.
    expect(entries.get("proj/readme-link.md")!.data.toString()).toBe("# Project\n".repeat(200));
  });

  it("leaves out credential files, links into a credential store, dependency trees and linked folders", async () => {
    const names = [...readZip(await collect(zip.zipFolderStream(PROJ, "proj"))).keys()];
    expect(names.some((n) => n.includes(".netrc"))).toBe(false);
    expect(names.some((n) => n.includes("key-link"))).toBe(false);
    expect(names.some((n) => n.includes("node_modules"))).toBe(false);
    expect(names.some((n) => n.includes("src-link"))).toBe(false);
    expect(names.some((n) => n.includes("dangling"))).toBe(false);
    expect(names.join("\n")).not.toContain("PRIVATE");
  });

  it("keeps the unix mode (an executable stays executable), marks folders, and flags names as UTF-8", async () => {
    const entries = readZip(await collect(zip.zipFolderStream(PROJ, "proj")));
    expect(entries.get("proj/run.sh")!.mode & 0o777).toBe(0o755);
    const dir = entries.get("proj/src/")!;
    expect(dir.external & 0x10).toBe(0x10);
    expect(dir.method).toBe(0);
    for (const e of entries.values()) expect(e.flags & 0x0800).toBe(0x0800);
    // Files carry the data-descriptor flag: nothing about them is known up front.
    expect(entries.get("proj/README.md")!.flags & 0x0008).toBe(0x0008);
    expect(entries.get("proj/README.md")!.method).toBe(8);
  });

  it.skipIf(!hasPython)("is read by python's zipfile, an unrelated implementation, with every CRC good", async () => {
    const file = path.join(TEST_ROOT, "check.zip");
    fs.writeFileSync(file, await collect(zip.zipFolderStream(PROJ, "proj")));
    const out = execFileSync("python3", [
      "-c",
      "import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nbad = z.testzip()\nprint('BAD' if bad else 'OK', len(z.namelist()), z.read('proj/src/index.ts').decode().strip())",
      file,
    ]).toString().trim();
    expect(out).toBe("OK 12 export const answer = 42;");
  });

  it("stops with an error past the entry cap rather than finishing a partial archive", async () => {
    const stream = zip.zipFolderStream(PROJ, "proj", { maxEntries: 3 });
    await expect(collect(stream)).rejects.toThrow(/more than 3 entries/);
  });

  it.skipIf(!fs.existsSync("/proc/self/fd"))("closes the file it was reading when the download is cancelled part-way", async () => {
    const big = path.join(TEST_ROOT, "big");
    fs.mkdirSync(big, { recursive: true });
    const blob = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < blob.length; i += 1) blob[i] = (i * 7919) & 0xff;
    fs.writeFileSync(path.join(big, "blob.bin"), blob);
    const before = fs.readdirSync("/proc/self/fd").length;
    const stream = zip.zipFolderStream(big, "big");
    await new Promise<void>((resolve) => {
      let seen = 0;
      stream.on("data", () => { if (++seen === 3) { stream.destroy(); resolve(); } });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.readdirSync("/proc/self/fd").length).toBeLessThanOrEqual(before);
  });
});

describe("summarizeFolderForZip — asked before a download starts", () => {
  it("counts what the archive would hold, by the same rule", async () => {
    const summary = await zip.summarizeFolderForZip(PROJ);
    expect(summary).toMatchObject({ entries: 12, files: 8, tooMany: false });
    expect(summary.bytes).toBe(
      2000 + 26 + 18 + "unicode name\n".length + 21 + random.length + 0 + 2000,
    );
  });

  it("says tooMany past its limit, and stops counting there", async () => {
    expect(await zip.summarizeFolderForZip(PROJ, 4)).toMatchObject({ entries: 4, tooMany: true, limit: 4 });
  });
});

describe("the ZIP64 records — only where a size or an offset needs them", () => {
  const base = {
    name: Buffer.from("p/big.bin"), kind: "file" as const, method: 8, flags: 0x0808, crc: 1,
    compressedSize: 10, size: 10, offset: 0, time: 0, date: 33, mode: 0o100644, zip64Local: false,
  };

  it("keeps a small entry classic: no extra field, version 2.0", () => {
    const h = zip.centralDirectoryHeader(base);
    expect(h.readUInt16LE(6)).toBe(20);
    expect(h.readUInt16LE(30)).toBe(0);
    expect(zip.localFileHeader(base).readUInt16LE(28)).toBe(0);
    expect(zip.dataDescriptor(base).length).toBe(16);
  });

  it("moves an offset past 4 GiB into the extra field, and only the offset", () => {
    const h = zip.centralDirectoryHeader({ ...base, offset: 5 * 2 ** 30 });
    expect(h.readUInt32LE(42)).toBe(0xffffffff);
    expect(h.readUInt32LE(20)).toBe(10);
    const extraLen = h.readUInt16LE(30);
    expect(extraLen).toBe(12);
    const extra = h.subarray(46 + base.name.length);
    expect(extra.readUInt16LE(0)).toBe(1);
    expect(Number(extra.readBigUInt64LE(4))).toBe(5 * 2 ** 30);
  });

  it("writes a big file's sizes as ZIP64 in the local header, the descriptor and the central record alike", () => {
    const big = { ...base, zip64Local: true, size: 6 * 2 ** 30, compressedSize: 6 * 2 ** 30 + 99 };
    const local = zip.localFileHeader(big);
    expect(local.readUInt32LE(18)).toBe(0xffffffff);
    expect(local.readUInt16LE(28)).toBe(20);
    const dd = zip.dataDescriptor(big);
    expect(dd.length).toBe(24);
    expect(Number(dd.readBigUInt64LE(16))).toBe(6 * 2 ** 30);
    const central = zip.centralDirectoryHeader(big);
    expect(central.readUInt16LE(6)).toBe(45);
    const extra = central.subarray(46 + base.name.length);
    expect(Number(extra.readBigUInt64LE(4))).toBe(6 * 2 ** 30);
    expect(Number(extra.readBigUInt64LE(12))).toBe(6 * 2 ** 30 + 99);
  });

  it("closes with the classic end record alone, and with the ZIP64 record and locator past 65,535 entries", () => {
    expect(zip.endOfCentralDirectory(3, 100, 1000).length).toBe(22);
    const end = zip.endOfCentralDirectory(70_000, 5_000_000, 6 * 2 ** 30);
    expect(end.length).toBe(56 + 20 + 22);
    expect(end.readUInt32LE(0)).toBe(0x06064b50);
    expect(Number(end.readBigUInt64LE(32))).toBe(70_000);
    expect(end.readUInt32LE(56)).toBe(0x07064b50);
    expect(Number(end.readBigUInt64LE(56 + 8))).toBe(6 * 2 ** 30 + 5_000_000);
    const classic = end.subarray(76);
    expect(classic.readUInt16LE(10)).toBe(0xffff);
    expect(classic.readUInt32LE(16)).toBe(0xffffffff);
  });

  it("dates a file from before 1980 as 1980-01-01, the format's first day", () => {
    expect(zip.dosDateTime(new Date(0))).toEqual({ time: 0, date: (1 << 5) | 1 });
    const d = zip.dosDateTime(new Date(2026, 8, 28, 13, 45, 30));
    expect(d.date).toBe(((2026 - 1980) << 9) | (9 << 5) | 28);
    expect(d.time).toBe((13 << 11) | (45 << 5) | 15);
  });

  it("computes the standard CRC-32", () => {
    expect(zip.crc32(Buffer.from("123456789")) >>> 0).toBe(0xcbf43926);
  });
});
