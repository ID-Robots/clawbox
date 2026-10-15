/**
 * Finding and reading ingest documents: the walk's exclude list (never
 * ClawBox's own output), code projects found during the walk (never the
 * folder the owner picked), boilerplate and temporary files by name, the
 * preview of what a job would read, the one-handle read with its hash,
 * redaction and capping of the text, and extraction from a private copy.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INGEST_EXTENSIONS,
  MAX_JOB_FILES,
  codeProjectIn,
  extractText,
  isOwnOutput,
  prepareText,
  previewFolders,
  readFileOnce,
  scanFolders,
  sourceLabel,
} from "@/lib/prime-radiant/ingest-sources";
import { MAX_DOCUMENT_BYTES } from "@/lib/memory-extract";

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

  it("leaves out worktrees, repositories, scratch and spike folders, and archives of agent runs by default", async () => {
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
    expect(scan.files.map((f) => path.relative(docs, f.abs)).sort()).toEqual(["notes/a.md"]);
    expect(scan.excluded).toBe(8);
    // A repository found during the walk is a code project (its own reason).
    expect(scan.skips.codeProject).toBe(1);
    expect(scan.codeProjects).toEqual([path.join(docs, "main-repo")]);
  });

  it("leaves out logs, test data, examples, snap and flatpak folders by default", async () => {
    write("keep/a.md");
    for (const dir of ["snap", "flatpak", "logs", "log", "fixtures", "__fixtures__", "test", "tests", "__tests__", "e2e", "examples", "Trash"]) {
      write(`keep/${dir}/x.md`);
    }
    const scan = await scanFolders([docs]);
    expect(scan.files.map((f) => path.relative(docs, f.abs))).toEqual(["keep/a.md"]);
    expect(scan.skips.excludedFolder).toBe(12);
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

describe("code projects", () => {
  const manifests = ["package.json", "Cargo.toml", "pyproject.toml", "setup.py", "go.mod", "CMakeLists.txt", "pom.xml", "build.gradle", "Gemfile", "composer.json", "Widgets.csproj", "Widgets.sln"];

  it("skips a folder found during the walk that holds a manifest, a .git folder, or a Makefile next to source", async () => {
    write("notes/plan.md");
    for (const [i, m] of manifests.entries()) {
      write(`p${i}/${m}`, "x");
      write(`p${i}/README.md`);
      write(`p${i}/docs/guide.md`);
    }
    write("repo/README.md");
    fs.mkdirSync(path.join(docs, "repo", ".git"));
    write("cproj/Makefile", "all:\n\tcc main.c\n");
    write("cproj/main.c", "int main(void) { return 0; }");
    write("cproj/NOTES.md");
    const scan = await scanFolders([docs]);
    expect(scan.files.map((f) => path.relative(docs, f.abs))).toEqual(["notes/plan.md"]);
    expect(scan.skips.codeProject).toBe(manifests.length + 2);
    expect(scan.excluded).toBe(0);
  });

  it("keeps a folder whose Makefile builds no code, and a notes vault kept in git", async () => {
    write("thesis/Makefile", "all:\n\tlatexmk thesis.tex\n");
    write("thesis/thesis.tex", "\\documentclass{article}");
    write("thesis/outline.md");
    write("vault/journal.md");
    fs.mkdirSync(path.join(docs, "vault", ".git"));
    fs.mkdirSync(path.join(docs, "vault", ".obsidian"));
    const scan = await scanFolders([docs]);
    expect(scan.files.map((f) => path.relative(docs, f.abs)).sort()).toEqual(["thesis/outline.md", "vault/journal.md"]);
    expect(scan.skips.codeProject).toBe(0);
  });

  it("reads a project the owner picked explicitly, but not the projects inside it", async () => {
    const project = path.join(docs, "Projects", "foo");
    write("Projects/foo/package.json", "{}");
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    write("Projects/foo/docs/design.md");
    write("Projects/foo/notes.txt");
    write("Projects/foo/packages/bar/package.json", "{}");
    write("Projects/foo/packages/bar/README.md");
    // Walking the parent leaves foo out; picking foo itself reads its documents.
    expect((await scanFolders([path.join(docs, "Projects")])).files).toEqual([]);
    const picked = await scanFolders([project]);
    expect(picked.files.map((f) => path.relative(project, f.abs))).toEqual(["docs/design.md", "notes.txt"]);
    expect(picked.skips.codeProject).toBe(1);
    // A home folder and a project inside it, both picked: the project is read once, from its own pick.
    const both = await scanFolders([docs, project]);
    expect(both.files.map((f) => path.relative(docs, f.abs))).toEqual(["Projects/foo/docs/design.md", "Projects/foo/notes.txt"]);
  });

  it("reads code projects when told not to skip them", async () => {
    write("app/package.json", "{}");
    write("app/docs/guide.md");
    const scan = await scanFolders([docs], { skipCodeProjects: false });
    expect(scan.files.map((f) => path.relative(docs, f.abs))).toEqual(["app/docs/guide.md"]);
    expect(scan.skips.codeProject).toBe(0);
  });

  it("finds a marker past the first entries of a big folder, and never follows a symlinked .git", async () => {
    const big = path.join(docs, "big");
    fs.mkdirSync(big);
    for (let i = 0; i < 2100; i++) fs.writeFileSync(path.join(big, `f${String(i).padStart(4, "0")}.dat`), "");
    expect(await codeProjectIn(big)).toBeNull();
    fs.writeFileSync(path.join(big, "go.mod"), "module x");
    expect(await codeProjectIn(big)).toBe("go.mod");
    const linked = path.join(docs, "linked");
    fs.mkdirSync(path.join(docs, "real-git"), { recursive: true });
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(docs, "real-git"), path.join(linked, ".git"));
    expect(await codeProjectIn(linked)).toBeNull();
    expect(await codeProjectIn(path.join(docs, "missing"))).toBeNull();
  });
});

describe("files left out by name", () => {
  it("counts boilerplate and temporary files apart from documents and other kinds", async () => {
    // At the top of the picked folder, which is never judged a project (a CMakeLists.txt deeper down makes its folder one).
    for (const name of ["LICENSE.md", "license.txt", "COPYING.txt", "NOTICE.md", "AUTHORS.txt", "CHANGELOG.md", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "SECURITY.md",
      "requirements-dev.txt", "CMakeLists.txt", "robots.txt", "llms-full.txt", "yarn.lock.txt"]) {
      write(name, "boilerplate");
    }
    for (const name of ["~$budget.docx", "notes.md~", "draft.tmp", "old.bak", "file.swp", "movie.part", "report.pdf.crdownload"]) write(`t/${name}`, "temp");
    write("keep/Notice.md");
    write("keep/security-checklist.md");
    write("keep/License agreement.pdf");
    write("keep/README.md");
    write("other/photo.png");
    const scan = await scanFolders([docs]);
    expect(scan.files.map((f) => path.relative(docs, f.abs)).sort()).toEqual([
      "keep/License agreement.pdf", "keep/Notice.md", "keep/README.md", "keep/security-checklist.md",
    ]);
    expect(scan.skips).toMatchObject({ boilerplate: 14, temp: 7, unsupported: 1 });
  });

  it("keeps every file of a drop, whatever its name", async () => {
    write("LICENSE.md");
    write("~$x.docx");
    const scan = await scanFolders([docs], { skipByName: false });
    expect(scan.files.map((f) => path.basename(f.abs)).sort()).toEqual(["LICENSE.md", "~$x.docx"]);
  });
});

describe("previewFolders", () => {
  it("counts what a job would read, what it leaves out and why, and where the documents are", async () => {
    for (let i = 0; i < 3; i++) write(`Documents/Work/memo-${i}.md`, "A memo about the Acme budget for next year and who signs it off.");
    write("Documents/letter.docx", "docx bytes");
    write("Downloads/manual.pdf", "pdf bytes");
    write("notes.txt", "A note at the top of the home folder about the dentist appointment next week.");
    write("Projects/site/package.json", "{}");
    write("Projects/site/README.md");
    write("LICENSE.txt", "MIT");
    write("Downloads/~$draft.docx", "lock");
    write("logs/app.md", "x");
    write("Documents/server.txt", Array.from({ length: 30 }, (_, i) => `2026-10-14 08:00:${String(i).padStart(2, "0")} INFO request ${i} served in 12ms`).join("\n"));
    const big = write("Downloads/huge.pdf", "");
    fs.truncateSync(big, MAX_DOCUMENT_BYTES + 1);
    write("Pictures/cat.jpg", "jpg");
    const preview = await previewFolders([docs]);
    expect(preview.documents).toBe(6);
    expect(preview.skips).toEqual({
      codeProject: 1, excludedFolder: 1, boilerplate: 1, temp: 1, machineText: 1, tooLarge: 1, unsupported: 1,
    });
    expect(preview.topFolders).toEqual([
      { label: sourceLabel(path.join(docs, "Documents")), documents: 4 },
      { label: sourceLabel(docs), documents: 1 },
      { label: sourceLabel(path.join(docs, "Downloads")), documents: 1 },
    ]);
    expect(preview.codeProjects).toEqual([sourceLabel(path.join(docs, "Projects", "site"))]);
    expect(preview).toMatchObject({ truncated: false, limit: MAX_JOB_FILES, notes: [] });
  });

  it("follows the same settings as the job, and says when there is more than one job reads", async () => {
    write("app/package.json", "{}");
    write("app/a.md");
    write("drafts/b.md");
    for (let i = 0; i < 4; i++) write(`c${i}.md`);
    const preview = await previewFolders([docs], { exclude: ["drafts"], skipCodeProjects: false });
    expect(preview).toMatchObject({ documents: 5, truncated: false });
    expect(preview.skips).toMatchObject({ codeProject: 0, excludedFolder: 1 });
    expect(await previewFolders([docs], { maxFiles: 3 })).toMatchObject({ documents: 3, truncated: true, limit: 3, notes: [] });
  });

  it("names a folder it could not read like a source", async () => {
    const preview = await previewFolders([path.join(docs, "missing")]);
    expect(preview.documents).toBe(0);
    expect(preview.notes.join(" ")).toContain(`${sourceLabel(path.join(docs, "missing"))} could not be read.`);
  });
});

describe("sourceLabel", () => {
  it("folds the home folder and redacts secrets in a name", () => {
    const home = os.homedir();
    expect(sourceLabel(path.join(home, "Documents", "acme.pdf"))).toBe("~/Documents/acme.pdf");
    expect(sourceLabel("/srv/share/orders@example.com/list.md")).toMatch(/^\/srv\/share\/\[REDACTED:EMAIL\]\/list\.md#[0-9a-f]{12}$/);
  });

  it("keeps two paths apart that read alike once redacted, the same way every time", () => {
    const a = sourceLabel("/srv/share/orders@example.com/list.md");
    const b = sourceLabel("/srv/share/billing@example.com/list.md");
    expect(a).not.toBe(b);
    expect(sourceLabel("/srv/share/orders@example.com/list.md")).toBe(a);
    expect(a).not.toContain("example.com");
    // A path redaction did not touch carries no suffix.
    expect(sourceLabel("/srv/share/list.md")).toBe("/srv/share/list.md");
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
