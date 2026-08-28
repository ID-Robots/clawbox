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
