/**
 * src/lib/tar-gz.ts — the archive format the ClawBox Store moves. What it
 * writes must round-trip, and what it reads must never reach outside the
 * folder it is unpacked into: a link, a device, an absolute path or a `..`
 * refuses the WHOLE package.
 */
import { describe, expect, it } from "vitest";
import crypto from "crypto";
import zlib from "zlib";
import { packTarGz, readTarGz, safeEntryPath, TarError, type TarEntry } from "@/lib/tar-gz";

const LIMITS = { maxBytes: 10 * 1024 * 1024, maxEntries: 1000 };

function file(path: string, body: string, mode = 0o644): TarEntry {
  return { path, type: "file", mode, mtime: 1_700_000_000, data: Buffer.from(body) };
}

/** Rewrite the first header of a packed archive: its name and type, with a fresh checksum. */
async function forged(name: string, type: string): Promise<Buffer> {
  const tar = zlib.gunzipSync(await packTarGz([file("placeholder", "x")], { maxBytes: 1e6 }));
  const header = tar.subarray(0, 512);
  header.fill(0, 0, 100);
  header.write(name, 0, 100, "utf8");
  header.write(type, 156, 1, "ascii");
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return zlib.gzipSync(tar);
}

async function refusal(gz: Buffer): Promise<TarError> {
  try {
    readTarGz(gz, LIMITS);
  } catch (err) {
    expect(err).toBeInstanceOf(TarError);
    return err as TarError;
  }
  throw new Error("the archive was accepted");
}

describe("packTarGz / readTarGz", () => {
  it("round-trips files, folders, the executable bit, long and non-ASCII paths", async () => {
    const long = `deep/${"x".repeat(120)}/${"y".repeat(90)}.txt`;
    const entries: TarEntry[] = [
      file("clawbox.json", '{"name":"A"}'),
      { path: "src", type: "dir", mode: 0o755, mtime: 1_700_000_000 },
      file("src/run.sh", "#!/bin/sh\necho hi\n", 0o755),
      file(long, "long"),
      file("ünïcode/файл.txt", "ok"),
      file(`p/${"z".repeat(300)}`, ""),
    ];
    const back = readTarGz(await packTarGz(entries, { maxBytes: 1e6 }), LIMITS);
    expect(back.map((e) => e.path)).toEqual(entries.map((e) => e.path));
    expect(back.find((e) => e.path === "src")?.type).toBe("dir");
    expect(back.find((e) => e.path === "src/run.sh")?.mode).toBe(0o755);
    expect(back.find((e) => e.path === "clawbox.json")?.mode).toBe(0o644);
    expect(back.find((e) => e.path === long)?.data?.toString()).toBe("long");
    expect(back.find((e) => e.path === "ünïcode/файл.txt")?.data?.toString()).toBe("ok");
  });

  it("stops packing past the compressed cap", async () => {
    // Random bytes do not compress, so 64 KiB of them cannot fit in 16 KiB.
    const noise = crypto.randomBytes(64 * 1024);
    await expect(packTarGz([{ path: "noise.bin", type: "file", mode: 0o644, mtime: 0, data: noise }], { maxBytes: 16 * 1024 }))
      .rejects.toMatchObject({ reason: "too_large" });
  });

  it.each([
    ["a symbolic link", "2"],
    ["a hard link", "1"],
    ["a character device", "3"],
    ["a named pipe", "6"],
  ])("refuses %s", async (_what, type) => {
    expect((await refusal(await forged("evil", type))).reason).toBe("unsafe_entry");
  });

  it.each(["../escape.txt", "/etc/passwd", "a/../../escape.txt", "a\\b.txt"])("refuses the path %s", async (name) => {
    expect((await refusal(await forged(name, "0"))).reason).toBe("unsafe_entry");
  });

  it("refuses what is not a gzip'd tar", async () => {
    expect((await refusal(Buffer.from("not an archive"))).reason).toBe("invalid");
    const bad = zlib.gunzipSync(await packTarGz([file("a.txt", "a")], { maxBytes: 1e6 }));
    bad[148] = 0x37; // a checksum that no longer adds up
    expect((await refusal(zlib.gzipSync(bad))).reason).toBe("invalid");
  });

  it("stops unpacking past the size and entry caps", async () => {
    const big = await packTarGz([file("zeros.bin", "\0".repeat(2 * 1024 * 1024))], { maxBytes: 1e6 });
    expect(() => readTarGz(big, { maxBytes: 1024 * 1024, maxEntries: 10 })).toThrow(expect.objectContaining({ reason: "too_large" }));
    const many = await packTarGz(Array.from({ length: 20 }, (_, i) => file(`f${i}.txt`, "x")), { maxBytes: 1e6 });
    expect(() => readTarGz(many, { maxBytes: 1e6, maxEntries: 10 })).toThrow(expect.objectContaining({ reason: "too_large" }));
  });
});

describe("safeEntryPath", () => {
  it("normalises ./ and empty segments, and names the root as null", () => {
    expect(safeEntryPath("./src//app.js")).toBe("src/app.js");
    expect(safeEntryPath("./")).toBeNull();
  });
});
