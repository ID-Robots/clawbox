/**
 * The run evidence store (src/lib/coding-agent-artifacts.ts).
 *
 * The property that matters most: artifactFilePath() is the whole gate the
 * serving route relies on, so a traversal name, a dotfile or a symlink a run
 * planted must all resolve to null — the folder's own files and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

type Lib = typeof import("@/lib/coding-agent-artifacts");

let lib: Lib;
let base: string;
let root: string;
let restore: () => void;

const RUN_ID = "run-abc12345";

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-artifacts-"));
  root = path.join(base, "clawbox");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.HOME = base;
  process.env.CLAWBOX_ROOT = root;
  vi.resetModules();
  lib = await import("@/lib/coding-agent-artifacts");
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("listing", () => {
  it("answers [] for a run that never saved anything", () => {
    expect(lib.listArtifacts(RUN_ID)).toEqual([]);
  });

  it("lists regular files with their kind, oldest first, and skips what a run must not smuggle in", () => {
    const dir = lib.ensureArtifactsDir(RUN_ID);
    fs.writeFileSync(path.join(dir, "shot-001.png"), "png");
    fs.writeFileSync(path.join(dir, "tests.txt"), "1 passed");
    fs.writeFileSync(path.join(dir, ".hidden"), "no");
    fs.writeFileSync(path.join(dir, "weird$name"), "no");
    fs.mkdirSync(path.join(dir, "subdir"));
    const listed = lib.listArtifacts(RUN_ID);
    expect(listed.map((a) => a.name).sort()).toEqual(["shot-001.png", "tests.txt"]);
    expect(listed.find((a) => a.name === "shot-001.png")?.kind).toBe("image");
    expect(listed.find((a) => a.name === "tests.txt")?.kind).toBe("text");
  });

  it("refuses a malformed run id instead of touching disk", () => {
    expect(lib.listArtifacts("../../etc")).toEqual([]);
    expect(() => lib.artifactsDir("run-UPPER!!!")).toThrow();
  });

  it("keeps the NEWEST entries when a run archived more than the cap, report.md among them", () => {
    // A run that took 99 screenshots (run-yuyqta4t) writes its report last.
    // A cap that kept the oldest would drop the one file the owner opens
    // first, and every screenshot of the finished work.
    const dir = lib.ensureArtifactsDir(RUN_ID);
    const epoch = Math.floor(Date.now() / 1000) - 10_000;
    const total = lib.MAX_ARTIFACTS + 10;
    for (let i = 1; i <= total; i++) {
      const file = path.join(dir, `shot-${String(i).padStart(3, "0")}.png`);
      fs.writeFileSync(file, "png");
      fs.utimesSync(file, epoch + i, epoch + i);
    }
    expect(lib.writeRunReport(RUN_ID, "## Done")).toBe(true);

    const names = lib.listArtifacts(RUN_ID).map((a) => a.name);
    expect(names).toHaveLength(lib.MAX_ARTIFACTS);
    expect(names.at(-1)).toBe(lib.REPORT_FILE);
    expect(names[0]).toBe(`shot-${String(total - lib.MAX_ARTIFACTS + 2).padStart(3, "0")}.png`);
    expect(names).not.toContain("shot-001.png");
    expect(names).toContain(`shot-${String(total).padStart(3, "0")}.png`);
    // Dropped from the list, never from disk.
    expect(fs.existsSync(path.join(dir, "shot-001.png"))).toBe(true);
  });
});

describe("serving gate", () => {
  it("resolves a real file", () => {
    const dir = lib.ensureArtifactsDir(RUN_ID);
    fs.writeFileSync(path.join(dir, "shot-001.png"), "png");
    expect(lib.artifactFilePath(RUN_ID, "shot-001.png")).toBe(fs.realpathSync(path.join(dir, "shot-001.png")));
  });

  it("refuses traversal names, dotfiles and unknown files", () => {
    lib.ensureArtifactsDir(RUN_ID);
    expect(lib.artifactFilePath(RUN_ID, "../config.json")).toBeNull();
    expect(lib.artifactFilePath(RUN_ID, "a/b.png")).toBeNull();
    expect(lib.artifactFilePath(RUN_ID, ".mcp-token")).toBeNull();
    expect(lib.artifactFilePath(RUN_ID, "missing.png")).toBeNull();
    expect(lib.artifactFilePath("run-!!", "shot-001.png")).toBeNull();
  });

  it("refuses a symlink a run planted to reach outside its folder", () => {
    const dir = lib.ensureArtifactsDir(RUN_ID);
    const secret = path.join(root, "data", "config.json");
    fs.writeFileSync(secret, "{}");
    fs.symlinkSync(secret, path.join(dir, "innocent.txt"));
    expect(lib.artifactFilePath(RUN_ID, "innocent.txt")).toBeNull();
  });
});

describe("removal", () => {
  it("deletes the folder and never throws on one that is not there", () => {
    const dir = lib.ensureArtifactsDir(RUN_ID);
    fs.writeFileSync(path.join(dir, "shot-001.png"), "png");
    lib.removeArtifacts(RUN_ID);
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => lib.removeArtifacts(RUN_ID)).not.toThrow();
    expect(() => lib.removeArtifacts("not-a-run-id")).not.toThrow();
  });
});

describe("the report file", () => {
  it("classifies markdown as its own kind, still served as plain text", () => {
    // The kind is what lets the app open it RENDERED; the route's answer for
    // it must stay text/plain, or an agent-written file could run as HTML.
    expect(lib.artifactKind("report.md")).toBe("markdown");
    expect(lib.artifactKind("NOTES.MD")).toBe("markdown");
    expect(lib.artifactKind("tests.txt")).toBe("text");
    expect(lib.artifactMimeType("report.md")).toBeNull();
  });

  it("classifies a clip as audio and serves it with a real audio type", () => {
    // A run can record its own narration now; the app plays it in place, and
    // a WAV served as text/plain is a file nobody can hear.
    expect(lib.artifactKind("intro.wav")).toBe("audio");
    expect(lib.artifactKind("NARRATION.WAV")).toBe("audio");
    expect(lib.artifactMimeType("intro.wav")).toBe("audio/wav");
    expect(lib.artifactMimeType("theme.mp3")).toBe("audio/mpeg");
    // Everything outside the two inline tables still comes back as text.
    expect(lib.artifactKind("build.log")).toBe("text");
    expect(lib.artifactMimeType("page.html")).toBeNull();
  });

  it("writes the report once, in one piece, and never over one that is there", () => {
    expect(lib.writeRunReport(RUN_ID, "  \n")).toBe(false);
    expect(lib.writeRunReport(RUN_ID, "## Done\n")).toBe(true);
    const dir = lib.artifactsDir(RUN_ID);
    const report = path.join(dir, lib.REPORT_FILE);
    expect(fs.readdirSync(dir)).toEqual([lib.REPORT_FILE]);
    expect(fs.readFileSync(report, "utf-8")).toBe("## Done\n");
    // Owner-readable at least; the folder's own mode is what guards it.
    expect(fs.statSync(report).mode & 0o600).toBe(0o600);
    expect(lib.writeRunReport(RUN_ID, "something else")).toBe(false);
    expect(fs.readFileSync(report, "utf-8")).toBe("## Done\n");
    expect(lib.listArtifacts(RUN_ID)).toMatchObject([{ name: lib.REPORT_FILE, kind: "markdown" }]);
  });

  it("answers false with one warning instead of throwing", () => {
    // The evidence root is a plain file, so nothing under it can be made.
    fs.mkdirSync(path.dirname(lib.artifactsRoot()), { recursive: true });
    fs.writeFileSync(lib.artifactsRoot(), "not a folder");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(lib.writeRunReport(RUN_ID, "## Done")).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(lib.writeRunReport("../etc", "## Done")).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
