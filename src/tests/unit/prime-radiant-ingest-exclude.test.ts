/**
 * The rules an ingest leaves files and folders out by, pure: boilerplate and
 * temporary files by name, the markers of a code project, and the skip
 * counts as they are read back from storage.
 */
import { describe, expect, it } from "vitest";
import {
  PROJECT_MANIFESTS,
  SKIP_REASONS,
  codeProjectMarker,
  emptySkipCounts,
  fileSkipReason,
  readSkipCounts,
} from "@/lib/prime-radiant/ingest-exclude";

const file = (name: string) => ({ name, dir: false });
const dir = (name: string) => ({ name, dir: true });

describe("fileSkipReason", () => {
  it("leaves out repository boilerplate kept as text or markdown", () => {
    for (const name of [
      "LICENSE.md", "LICENSE.txt", "license.txt", "LICENCE.md", "LICENSE-MIT.txt", "License_Apache.md",
      "COPYING.txt", "copying.md", "NOTICE.txt", "NOTICE.md", "AUTHORS.md", "AUTHORS.txt",
      "CHANGELOG.md", "changelog.txt", "CHANGELOG-2025.md", "CODE_OF_CONDUCT.md", "code-of-conduct.md",
      "CONTRIBUTING.md", "CONTRIBUTING.zh-CN.md", "SECURITY.md",
      "requirements.txt", "requirements-dev.txt", "requirements_test.txt", "CMakeLists.txt",
      "robots.txt", "llms.txt", "llms-full.txt", "poetry.lock.txt",
    ]) {
      expect(fileSkipReason(name), name).toBe("boilerplate");
    }
  });

  it("keeps the owner's documents that only look alike", () => {
    for (const name of [
      "Notice.md", "notice.txt", "security-checklist.md", "Authors I like.md", "licenses-for-the-shop.md",
      "License agreement.pdf", "LICENSE.docx", "CHANGELOG.pdf", "README.md", "readme.txt", "robots-notes.txt",
      "requirements.md", "my requirements.docx", "Changes.md", "History.md", "notes.md", "lockfile.md",
    ]) {
      expect(fileSkipReason(name), name).toBeNull();
    }
  });

  it("leaves out temporary and partial files of any kind", () => {
    for (const name of ["~$Budget.docx", "~$notes.odt", "notes.md~", "report.docx~", ".#notes.md", "draft.tmp", "old.BAK", ".notes.md.swp", "movie.part", "report.pdf.crdownload"]) {
      expect(fileSkipReason(name), name).toBe("temp");
    }
    for (const name of ["~notes.md", "tmp-notes.md", "backup-plan.md", "partner.md", "parts.txt"]) expect(fileSkipReason(name), name).toBeNull();
  });
});

describe("codeProjectMarker", () => {
  it("names the manifest that makes a folder a project", () => {
    for (const m of [...PROJECT_MANIFESTS, "Widgets.csproj", "Widgets.sln", "App.CSPROJ"]) {
      expect(codeProjectMarker([file("README.md"), file(m)]), m).toBe(m);
    }
  });

  it("calls a folder with a .git FOLDER a project, but not a notes vault kept in git", () => {
    expect(codeProjectMarker([dir(".git"), file("notes.md")])).toBe(".git");
    expect(codeProjectMarker([file(".git"), file("notes.md")])).toBeNull();
    expect(codeProjectMarker([dir(".git"), dir(".obsidian"), file("journal.md")])).toBeNull();
    expect(codeProjectMarker([dir(".git"), dir(".obsidian"), file("package.json")])).toBe("package.json");
  });

  it("calls a Makefile a project only next to source files", () => {
    expect(codeProjectMarker([file("Makefile"), file("main.c")])).toBe("Makefile");
    expect(codeProjectMarker([file("main.py"), file("makefile")])).toBe("makefile");
    expect(codeProjectMarker([file("GNUmakefile"), file("tool.go")])).toBe("GNUmakefile");
    expect(codeProjectMarker([file("Makefile"), file("thesis.tex"), file("refs.bib")])).toBeNull();
    expect(codeProjectMarker([file("main.c"), file("notes.md")])).toBeNull();
    // A folder named like a manifest is no manifest.
    expect(codeProjectMarker([dir("package.json"), dir("Makefile"), file("x.c")])).toBeNull();
  });

  it("finds nothing in an ordinary folder of documents", () => {
    expect(codeProjectMarker([file("taxes-2025.pdf"), file("letter.docx"), dir("Photos"), file("package-tracking.md")])).toBeNull();
    expect(codeProjectMarker([])).toBeNull();
  });
});

describe("skip counts", () => {
  it("start at zero for every reason and read back only whole, known counts", () => {
    expect(Object.keys(emptySkipCounts()).sort()).toEqual([...SKIP_REASONS].sort());
    expect(readSkipCounts({ codeProject: 3, temp: 1.5, boilerplate: -1, unsupported: "7", other: 9 })).toEqual({ ...emptySkipCounts(), codeProject: 3 });
    expect(readSkipCounts(null)).toEqual(emptySkipCounts());
    expect(readSkipCounts([1, 2])).toEqual(emptySkipCounts());
  });
});
