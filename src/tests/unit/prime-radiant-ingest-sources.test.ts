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
    write("g.rtf");
    const scan = await scanFolders([docs]);
    expect(scan.files.map((f) => path.relative(docs, f.abs)).sort()).toEqual(["a.md", "d.docx", "f.odt", "g.rtf", "sub/b.txt", "sub/c.PDF"]);
    expect(scan.files.find((f) => f.abs.endsWith("c.PDF"))?.ext).toBe(".pdf");
    expect(scan.unsupported).toBe(1);
    expect(scan.excluded).toBe(3);
    expect(scan.truncated).toBe(false);
    expect([...INGEST_EXTENSIONS]).toEqual([".txt", ".md", ".pdf", ".docx", ".odt", ".rtf"]);
  });

  it("leaves out worktrees, scratch and spike folders, and archives of agent runs by default", async () => {
    write("notes/a.md");
    write("notes/worktrees/run-1/a.md");
    write("checkout-2/README.md");
    fs.writeFileSync(path.join(docs, "checkout-2", ".git"), "gitdir: /somewhere/else/.git/worktrees/checkout-2\n");
    write("main-repo/doc.md");
    fs.mkdirSync(path.join(docs, "main-repo", ".git"));
    write("widget-spikes/round-1/cards.md");
    write("Scratch/tmp-notes.md");
    write("data/coding-agent-artifacts/run-x/report.md");
    write("coding-runs/2026/report.md");
    write("vendor/lib/README.md");
    write("search_cache/x.md");
    const scan = await scanFolders([docs]);
    expect(scan.files.map((f) => path.relative(docs, f.abs)).sort()).toEqual(["main-repo/doc.md", "notes/a.md"]);
    expect(scan.excluded).toBe(8);
  });

  it("uses the exclude list it is given instead of the defaults", async () => {
    write("a.md");
    write("private/b.md");
    write("Private-2024/c.md");
    write("node_modules/pkg/readme.md");
    const scan = await scanFolders([docs], { exclude: ["private*"] });
    expect(scan.files.map((f) => path.relative(docs, f.abs)).sort()).toEqual(["a.md", "node_modules/pkg/readme.md"]);
    expect(scan.excluded).toBe(2);
    // ClawBox's own output stays out whatever the list says.
    const own = process.env.PRIME_RADIANT_DIR!;
    fs.mkdirSync(path.join(own, "vault"), { recursive: true });
    fs.writeFileSync(path.join(own, "vault", "page.md"), "page");
    expect((await scanFolders([path.dirname(own)], { exclude: [] })).files.some((f) => f.abs.includes("vault"))).toBe(false);
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

  it("hands the files back in path order, whatever order the filesystem lists them in", async () => {
    // Forty names: the directory's own listing order (hash order on ext4) is
    // all but certain to differ from the sorted one somewhere.
    const names: string[] = [];
    for (let i = 0; i < 40; i++) names.push(`doc-${(i * 7919) % 1000}.md`, `sub-${i % 3}/item-${i}.md`);
    for (const rel of names) write(rel);
    const scan = await scanFolders([docs]);
    const got = scan.files.map((f) => path.relative(docs, f.abs));
    expect(got).toEqual([...got].sort((a, b) => (path.join(docs, a) < path.join(docs, b) ? -1 : 1)));
    expect(got).toHaveLength(names.length);
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
