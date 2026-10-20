/**
 * Staging dropped documents: ids and names rebuilt from an alphabet, one
 * exclusive write per file, the size cap metered as the body arrives, a body
 * cut short refused, and the batch limits.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES_PER_BATCH,
  UPLOAD_BATCH_TTL_MS,
  batchDir,
  pruneStaleBatches,
  safeBatchId,
  safeUploadName,
  stageFiles,
  stageUpload,
  stagedBatch,
  uploadsRoot,
} from "@/lib/prime-radiant/ingest-upload";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-upload-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;

function body(...chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(typeof ch === "string" ? new TextEncoder().encode(ch) : ch);
      c.close();
    },
  });
}

beforeEach(() => {
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("safeBatchId", () => {
  it("accepts 16 hex characters only, rebuilt lowercase", () => {
    expect(safeBatchId("0123456789ABCDEF")).toBe("0123456789abcdef");
    for (const bad of ["../../etc/passwd", "0123456789abcde", "0123456789abcdeg", "0123456789abcde/", 42, null]) {
      expect(safeBatchId(bad)).toBeNull();
    }
  });
});

describe("safeUploadName", () => {
  it("keeps the leaf, rebuilds unsafe characters and lowercases the extension", () => {
    expect(safeUploadName("Acme Catalogue.PDF")).toEqual({ name: "Acme Catalogue.pdf", ext: ".pdf" });
    expect(safeUploadName("../../etc/notes.md")).toEqual({ name: "notes.md", ext: ".md" });
    expect(safeUploadName("C:\\Users\\x\\plan.docx")).toEqual({ name: "plan.docx", ext: ".docx" });
    expect(safeUploadName("rép;ort$.txt")).toEqual({ name: "rép_ort_.txt", ext: ".txt" });
    // The owner's own name, in any script: the page's source shows it.
    expect(safeUploadName("Ценоразпис 2026.PDF")).toEqual({ name: "Ценоразпис 2026.pdf", ext: ".pdf" });
    expect(safeUploadName("Re\u0301sume\u0301.md")?.name).toBe("Résumé.md");
    // Never a control or a direction-override character.
    expect(safeUploadName("a\u0007b\u202Ec.md")?.name).toBe("a_b_c.md");
    // Within the file system's name limit in bytes, not only in characters.
    const wide = safeUploadName(`${"価".repeat(119)}.md`)!.name;
    expect(Buffer.byteLength(wide)).toBeLessThanOrEqual(200);
    expect(wide.endsWith(".md")).toBe(true);
    expect(safeUploadName("...hidden.md")).toEqual({ name: "hidden.md", ext: ".md" });
    expect(safeUploadName("$$$.md")?.name).toBe("___.md");
    expect(safeUploadName(`${"a".repeat(500)}.md`)?.name.length).toBeLessThanOrEqual(120);
  });

  it("refuses names without an ingestible extension", () => {
    for (const bad of ["photo.png", "noext", ".md", "archive.md.zip", "", 7]) expect(safeUploadName(bad)).toBeNull();
  });
});

describe("stageUpload", () => {
  it("starts a batch, writes the file 0600, and adds more under the same batch without clobbering", async () => {
    const first = await stageUpload(body("Acme ", "Widgets"), "catalogue.md", null, 12);
    expect(first).toMatchObject({ ok: true, name: "catalogue.md", bytes: 12 });
    if (!first.ok) throw new Error("expected ok");
    const file = path.join(batchDir(first.batch), "catalogue.md");
    expect(fs.readFileSync(file, "utf8")).toBe("Acme Widgets");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(batchDir(first.batch)).mode & 0o777).toBe(0o700);

    const second = await stageUpload(body("other"), "catalogue.md", first.batch, null);
    expect(second).toMatchObject({ ok: true, batch: first.batch, name: "catalogue (2).md" });
    expect(fs.readFileSync(file, "utf8")).toBe("Acme Widgets");
    expect(await stagedBatch(first.batch)).toBe(batchDir(first.batch));
  });

  it("refuses a bad name, an unknown batch and an empty body", async () => {
    expect(await stageUpload(body("x"), "x.exe", null, null)).toMatchObject({ ok: false, code: "invalid_name", status: 400 });
    expect(await stageUpload(body("x"), "x.md", "0123456789abcdef", null)).toMatchObject({ ok: false, code: "unknown_batch", status: 404 });
    expect(await stageUpload(body("x"), "x.md", "../escape", null)).toMatchObject({ ok: false, code: "unknown_batch" });
    expect(await stageUpload(null, "x.md", null, null)).toMatchObject({ ok: false, code: "empty" });
    const empty = await stageUpload(body(), "x.md", null, 0);
    expect(empty).toMatchObject({ ok: false, code: "empty" });
  });

  it("refuses an oversize body by its declared length before reading, and by metering when undeclared", async () => {
    expect(await stageUpload(body("x"), "x.md", null, MAX_UPLOAD_FILE_BYTES + 1)).toMatchObject({ ok: false, code: "too_large", status: 413 });
    const first = await stageUpload(body("seed"), "seed.md", null, null);
    if (!first.ok) throw new Error("expected ok");
    const big = new Uint8Array(1024 * 1024);
    const chunks = Array.from({ length: 10 }, () => big);
    const res = await stageUpload(body(...chunks), "big.md", first.batch, null);
    expect(res).toMatchObject({ ok: false, code: "too_large", status: 413 });
    expect(fs.readdirSync(batchDir(first.batch))).toEqual(["seed.md"]);
  });

  it("refuses a body shorter than its declared length (cut short on the way in)", async () => {
    const res = await stageUpload(body("only part"), "x.md", null, 5000);
    expect(res).toMatchObject({ ok: false, code: "too_large" });
  });

  it("refuses a full batch", async () => {
    const first = await stageUpload(body("x"), "f0.md", null, null);
    if (!first.ok) throw new Error("expected ok");
    for (let i = 1; i < MAX_UPLOAD_FILES_PER_BATCH; i++) fs.writeFileSync(path.join(batchDir(first.batch), `f${i}.md`), "x");
    expect(await stageUpload(body("x"), "more.md", first.batch, null)).toMatchObject({ ok: false, code: "batch_full", status: 409 });
  });

  it("does not write through a symlink planted in the batch", async () => {
    const first = await stageUpload(body("x"), "a.md", null, null);
    if (!first.ok) throw new Error("expected ok");
    const target = path.join(base, `target-${n}.md`);
    fs.writeFileSync(target, "original");
    fs.symlinkSync(target, path.join(batchDir(first.batch), "b.md"));
    const res = await stageUpload(body("new"), "b.md", first.batch, null);
    expect(res).toMatchObject({ ok: true, name: "b (2).md" });
    expect(fs.readFileSync(target, "utf8")).toBe("original");
  });
});

describe("a refused file", () => {
  const batches = () => (fs.existsSync(uploadsRoot()) ? fs.readdirSync(uploadsRoot()) : []);

  it("takes away the batch it was the first file of, and leaves a batch it joined", async () => {
    expect(await stageUpload(body(), "x.md", null, null)).toMatchObject({ ok: false, code: "empty" });
    expect(await stageUpload(body("only part"), "x.md", null, 5000)).toMatchObject({ ok: false, code: "too_large" });
    expect(await stageUpload(body(...Array.from({ length: 10 }, () => new Uint8Array(1024 * 1024))), "big.md", null, null)).toMatchObject({ ok: false, code: "too_large" });
    expect(batches()).toEqual([]);
    const first = await stageUpload(body("seed"), "seed.md", null, null);
    if (!first.ok) throw new Error("expected ok");
    expect(await stageUpload(body(), "y.md", first.batch, null)).toMatchObject({ ok: false, code: "empty" });
    expect(batches()).toEqual([first.batch]);
    expect(fs.readdirSync(batchDir(first.batch))).toEqual(["seed.md"]);
  });

  it.skipIf(!fs.existsSync("/proc/self/fd"))("closes the file stageFiles opened, also when it is refused before being read", async () => {
    const dir = path.join(base, `named-${n}`);
    fs.mkdirSync(dir, { recursive: true });
    // Bigger than one stream buffer: a small file is read to its end, and closed, whether or not anyone asks.
    const png = path.join(dir, "photo.png");
    fs.writeFileSync(png, Buffer.alloc(256 * 1024));
    const open = () => fs.readdirSync("/proc/self/fd").length;
    const before = open();
    for (let i = 0; i < 40; i++) {
      expect(await stageFiles([{ path: png, bytes: 256 * 1024 }])).toMatchObject({ ok: false, code: "invalid_name", index: 0 });
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(open() - before).toBeLessThan(5);
    expect(batches()).toEqual([]);
  });
});

describe("batches", () => {
  it("stagedBatch answers null for an empty or missing batch", async () => {
    expect(await stagedBatch("0123456789abcdef")).toBeNull();
    fs.mkdirSync(batchDir("0123456789abcdef"), { recursive: true });
    expect(await stagedBatch("0123456789abcdef")).toBeNull();
    expect(await stagedBatch("nope")).toBeNull();
  });

  it("prunes batches older than the TTL and leaves others", async () => {
    const old = batchDir("aaaaaaaaaaaaaaaa");
    const fresh = batchDir("bbbbbbbbbbbbbbbb");
    fs.mkdirSync(old, { recursive: true });
    fs.mkdirSync(fresh, { recursive: true });
    const past = new Date(Date.now() - UPLOAD_BATCH_TTL_MS - 60_000);
    fs.utimesSync(old, past, past);
    await pruneStaleBatches();
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
