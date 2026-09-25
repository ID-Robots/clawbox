/**
 * The streaming ZIP writer behind the run-history exports (TASK-1178).
 *
 * Read back with a reader written from the format (tests/helpers/unzip), and
 * — where the box has it — with Info-ZIP's own `unzip -t`, so "it round-trips
 * through our reader" cannot hide a file only our reader accepts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { crc32, zipEntryName, zipResponseStream, zipStream, type ZipSource } from "@/lib/zip-writer";
import { readAllStream, unzip } from "@/tests/helpers/unzip";

// `unzip -t` is a real process: both ceilings, per test-timeout-hygiene.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-writer-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function collect(sources: ZipSource[], options?: { forceZip64?: boolean }): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of zipStream(sources, options)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function fileSource(name: string, content: Buffer | string): Extract<ZipSource, { file: string }> {
  const file = path.join(dir, name.replace(/\//g, "_"));
  fs.writeFileSync(file, content);
  const stat = fs.statSync(file);
  return { name, file, size: stat.size, mtimeMs: stat.mtimeMs };
}

function hasUnzip(): boolean {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("zip writer", () => {
  it("round-trips text (deflated), pictures (stored), empty files and in-memory entries", async () => {
    const text = "hello transcript\n".repeat(5000);
    const png = crypto.randomBytes(40_000);
    const zip = await collect([
      fileSource("run-aaaaaaaa/transcript.jsonl", text),
      fileSource("run-aaaaaaaa/evidence/shot.png", png),
      fileSource("run-aaaaaaaa/empty.txt", ""),
      { name: "manifest.json", data: Buffer.from('{"ok":true}'), mtimeMs: Date.now() },
    ]);
    const entries = unzip(zip);
    expect(entries.map((e) => e.name)).toEqual([
      "run-aaaaaaaa/transcript.jsonl",
      "run-aaaaaaaa/evidence/shot.png",
      "run-aaaaaaaa/empty.txt",
      "manifest.json",
    ]);
    expect(entries[0].method).toBe(8);
    expect(entries[0].data.toString()).toBe(text);
    // Text shrinks; the archive is far smaller than what went in.
    expect(zip.length).toBeLessThan(text.length / 5 + png.length + 2000);
    expect(entries[1].method).toBe(0);
    expect(entries[1].data.equals(png)).toBe(true);
    expect(entries[2].data.length).toBe(0);
    expect(JSON.parse(entries[3].data.toString())).toEqual({ ok: true });

    if (hasUnzip()) {
      const out = path.join(dir, "out.zip");
      fs.writeFileSync(out, zip);
      expect(execFileSync("unzip", ["-t", out], { encoding: "utf-8" })).toMatch(/No errors detected/);
    }
  });

  it("writes ZIP64 records when asked, and they still read back", async () => {
    const zip = await collect([fileSource("big.log", "x".repeat(10_000)), fileSource("pic.png", crypto.randomBytes(500))], { forceZip64: true });
    const entries = unzip(zip);
    expect(entries.every((e) => e.zip64Local)).toBe(true);
    expect(entries[0].data.toString()).toBe("x".repeat(10_000));
    if (hasUnzip()) {
      const out = path.join(dir, "out64.zip");
      fs.writeFileSync(out, zip);
      expect(execFileSync("unzip", ["-t", out], { encoding: "utf-8" })).toMatch(/No errors detected/);
    }
  });

  it("switches the end record to ZIP64 past 65 535 entries", async () => {
    const many: ZipSource[] = Array.from({ length: 65_540 }, (_, i) => ({ name: `f/${i}.txt`, data: Buffer.alloc(0), mtimeMs: 0 }));
    const zip = await collect(many);
    const entries = unzip(zip);
    expect(entries).toHaveLength(65_540);
    expect(entries[65_539].name).toBe("f/65539.txt");
  });

  it("skips unsafe names, duplicate names, links and files that vanished", async () => {
    const real = fileSource("real.txt", "real");
    const target = path.join(dir, "secret.txt");
    fs.writeFileSync(target, "not for the zip");
    const link = path.join(dir, "link.txt");
    fs.symlinkSync(target, link);
    const zip = await collect([
      real,
      { ...real, name: "real.txt" },
      { name: "../escape.txt", data: Buffer.from("no"), mtimeMs: 0 },
      { name: "/abs.txt", data: Buffer.from("no"), mtimeMs: 0 },
      { name: "a/./b.txt", data: Buffer.from("no"), mtimeMs: 0 },
      { name: "link.txt", file: link, size: 15, mtimeMs: 0 },
      { name: "gone.txt", file: path.join(dir, "gone.txt"), size: 4, mtimeMs: 0 },
    ]);
    expect(unzip(zip).map((e) => e.name)).toEqual(["real.txt"]);
  });

  it("reads no more than the size the walk saw", async () => {
    const src = fileSource("grows.txt", "12345");
    fs.appendFileSync(src.file, "67890");
    const [entry] = unzip(await collect([src]));
    expect(entry.data.toString()).toBe("12345");
  });

  it("streams through a web ReadableStream", async () => {
    const zip = await readAllStream(zipResponseStream([fileSource("a.txt", "abc")]));
    expect(unzip(zip)[0].data.toString()).toBe("abc");
  });

  it("names and checksums the way the format wants", () => {
    expect(zipEntryName("a\\b/c.txt")).toBe("a/b/c.txt");
    expect(zipEntryName("a//b")).toBeNull();
    expect(zipEntryName("..")).toBeNull();
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.from("6789"), crc32(Buffer.from("12345")))).toBe(0xcbf43926);
  });
});
