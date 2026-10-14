/**
 * Finding and reading ingest documents: the walk's exclude list (never
 * ClawBox's own output), the one-handle read with its hash, redaction and
 * capping of the text, and extraction from a private copy.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INGEST_EXTENSIONS,
  extractText,
  isOwnOutput,
  prepareText,
  readFileOnce,
  scanFolders,
  sourceLabel,
} from "@/lib/prime-radiant/ingest-sources";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-sources-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;
let docs: string;

function write(rel: string, text: string | Buffer = "Acme Widgets Ltd sells blue widgets.") {
  const abs = path.join(docs, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}

beforeEach(() => {
  const root = path.join(base, `case-${++n}`);
  docs = path.join(root, "docs");
  fs.mkdirSync(docs, { recursive: true });
  process.env.PRIME_RADIANT_DIR = path.join(root, "prime-radiant");
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("scanFolders", () => {
  it("finds the supported kinds, counts the rest, and skips dot-entries and dependency trees", async () => {
    write("a.md");
    write("sub/b.txt");
    write("sub/c.PDF");
    write("d.docx");
    write("e.png");
    write("f.odt");
    write(".hidden/g.md");
    write("node_modules/pkg/readme.md");
    write("deep/__pycache__/x.txt");
    write("project/dist/out.md");
    const scan = await scanFolders([docs]);
    expect(scan.files.map((f) => path.relative(docs, f.abs)).sort()).toEqual(["a.md", "d.docx", "sub/b.txt", "sub/c.PDF"]);
    expect(scan.files.find((f) => f.abs.endsWith("c.PDF"))?.ext).toBe(".pdf");
    expect(scan.unsupported).toBe(2);
    expect(scan.truncated).toBe(false);
    expect([...INGEST_EXTENSIONS]).toEqual([".txt", ".md", ".pdf", ".docx"]);
  });

  it("never walks into Prime Radiant's own folder (the vault would ingest itself)", async () => {
    write("a.md");
    const own = process.env.PRIME_RADIANT_DIR!;
    fs.mkdirSync(path.join(own, "vault", "entities"), { recursive: true });
    fs.writeFileSync(path.join(own, "vault", "entities", "acme.md"), "page");
    const parent = path.dirname(own);
    const scan = await scanFolders([parent]);
    expect(scan.files.map((f) => path.basename(f.abs))).toEqual(["a.md"]);
    expect(isOwnOutput(path.join(own, "vault"))).toBe(true);
    expect(isOwnOutput(docs)).toBe(false);
  });

  it("does not follow a symlinked folder or file, and lists a file once across overlapping folders", async () => {
    write("a.md");
    const outside = path.join(base, `outside-${n}`);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.md"), "x");
    fs.symlinkSync(outside, path.join(docs, "link"));
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(docs, "file-link.md"));
    write("sub/b.md");
    const scan = await scanFolders([docs, path.join(docs, "sub")]);
    expect(scan.files.map((f) => path.relative(docs, f.abs)).sort()).toEqual(["a.md", "sub/b.md"]);
  });

  it("stops at the file cap with a note", async () => {
    for (let i = 0; i < 5; i++) write(`f${i}.md`);
    const scan = await scanFolders([docs], { maxFiles: 3 });
    expect(scan.files).toHaveLength(3);
    expect(scan.truncated).toBe(true);
    expect(scan.notes.join(" ")).toMatch(/first 3 documents/);
  });

  it("notes a folder it could not read", async () => {
    const scan = await scanFolders([path.join(docs, "missing")]);
    expect(scan.files).toEqual([]);
    expect(scan.notes.join(" ")).toMatch(/could not be read/);
  });

  it("labels files with the caller's labeller (uploads)", async () => {
    write("a.md");
    const scan = await scanFolders([docs], { labelOf: (abs) => `upload/${path.basename(abs)}` });
    expect(scan.files[0].label).toBe("upload/a.md");
  });
});

describe("sourceLabel", () => {
  it("folds the home folder and redacts secrets in a name", () => {
    const home = os.homedir();
    expect(sourceLabel(path.join(home, "Documents", "acme.pdf"))).toBe("~/Documents/acme.pdf");
    expect(sourceLabel("/srv/share/orders@example.com/list.md")).toBe("/srv/share/[REDACTED:EMAIL]/list.md");
  });
});

describe("readFileOnce", () => {
  it("answers the bytes and their SHA-256 from one handle", async () => {
    const abs = write("a.md", "hello");
    const r = await readFileOnce(abs);
    expect(r).toMatchObject({ ok: true, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" });
    expect(r.ok && r.data.toString()).toBe("hello");
  });

  it("refuses a symlink, a folder, a missing file and one over the cap", async () => {
    const abs = write("a.md", "hello");
    const link = path.join(docs, "link.md");
    fs.symlinkSync(abs, link);
    expect(await readFileOnce(link)).toEqual({ ok: false, reason: "unreadable" });
    expect(await readFileOnce(docs)).toEqual({ ok: false, reason: "not-a-file" });
    expect(await readFileOnce(path.join(docs, "nope.md"))).toEqual({ ok: false, reason: "unreadable" });
    expect(await readFileOnce(abs, 3)).toEqual({ ok: false, reason: "too-large", bytes: 5 });
  });
});

describe("prepareText", () => {
  it("strips control characters, collapses blank runs, redacts and caps", () => {
    const card = "4111 1111 1111 1111";
    const out = prepareText(`Line one\u0000\r\n\n\n\n\nOrder paid with ${card}. Contact sales@example.com`, 1000);
    expect(out.text).toBe("Line one\n\nOrder paid with [REDACTED:CARD]. Contact [REDACTED:EMAIL]");
    expect(out.truncated).toBe(false);
    const long = prepareText("word ".repeat(100), 20);
    expect(long).toEqual({ text: "word word word word ", truncated: true });
  });
});

describe("extractText", () => {
  it("decodes text documents directly and never runs an extractor for them", async () => {
    const extractor = vi.fn();
    expect(await extractText(Buffer.from("plain"), ".md", path.join(docs, "scratch"), extractor)).toBe("plain");
    expect(extractor).not.toHaveBeenCalled();
  });

  it("extracts other kinds from a private copy of the bytes, and cleans up", async () => {
    const scratch = path.join(docs, "scratch");
    const extractor = vi.fn(async (input: string, out: string) => {
      expect(fs.readFileSync(input, "utf8")).toBe("%PDF fake");
      expect(fs.statSync(input).mode & 0o777).toBe(0o600);
      fs.writeFileSync(out, "extracted text");
      return true;
    });
    expect(await extractText(Buffer.from("%PDF fake"), ".pdf", scratch, extractor)).toBe("extracted text");
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it("answers null when the extractor fails", async () => {
    expect(await extractText(Buffer.from("x"), ".docx", path.join(docs, "scratch"), async () => false)).toBeNull();
    expect(
      await extractText(Buffer.from("x"), ".docx", path.join(docs, "scratch"), async () => {
        throw new Error("boom");
      }),
    ).toBeNull();
  });
});
