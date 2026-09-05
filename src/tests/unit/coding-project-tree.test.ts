/**
 * The project explorer's walk (src/lib/coding-project-tree.ts): every path
 * stays inside the project, however it is spelled or linked, and what is
 * inside is listed folders-first with `.git` left out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("@/lib/file-guard", () => ({
  // The real guard names ClawBox's own data/ tree; here a folder called
  // `secrets` stands in for it so the refusal is observable in a temp dir.
  isProtectedFilePath: (abs: string) => abs.split(path.sep).includes("secrets"),
}));

import { listProjectDir, MAX_TREE_FILE_BYTES, readProjectFile, resolveInsideProject } from "@/lib/coding-project-tree";

let root: string;
let project: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "project-tree-"));
  project = path.join(root, "project");
  fs.mkdirSync(path.join(project, "src", "lib"), { recursive: true });
  fs.mkdirSync(path.join(project, ".git", "objects"), { recursive: true });
  fs.mkdirSync(path.join(project, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(project, "README.md"), "# hi\n");
  fs.writeFileSync(path.join(project, "src", "app.js"), "console.log(1)\n");
  fs.writeFileSync(path.join(project, "src", "lib", "util.js"), "export {}\n");
  fs.writeFileSync(path.join(project, ".env"), "SECRET=1\n");
  fs.writeFileSync(path.join(project, "secrets", "token"), "t\n");
  fs.writeFileSync(path.join(project, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  fs.writeFileSync(path.join(root, "outside.txt"), "not yours\n");
  fs.symlinkSync(path.join(root, "outside.txt"), path.join(project, "escape.txt"));
  fs.symlinkSync(root, path.join(project, "up"));
  // A link to a folder INSIDE the project: containment would pass, and it
  // is still not followed — the walk opens folders without following links.
  fs.symlinkSync(path.join(project, "src"), path.join(project, "alias"));
  fs.symlinkSync(path.join(project, "README.md"), path.join(project, "readme-link.md"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("listing", () => {
  it("lists the project root folders-first, without .git, links or protected folders", async () => {
    const out = await listProjectDir(project, "");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.path).toBe("");
    // localeCompare, the Files app's order: punctuation and case fold, so
    // `.env` and `logo.png` come before `README.md`.
    expect(out.entries.map((e) => `${e.type}:${e.name}`)).toEqual([
      "directory:src",
      "file:.env",
      "file:logo.png",
      "file:README.md",
    ]);
    const readme = out.entries.find((e) => e.name === "README.md");
    expect(readme?.size).toBe(5);
    expect(readme?.modified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.truncated).toBe(false);
  });

  it("lists a folder inside, named the way the page asked", async () => {
    const out = await listProjectDir(project, "src/lib");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.path).toBe("src/lib");
    expect(out.entries.map((e) => e.name)).toEqual(["util.js"]);
  });

  it("stops reading a folder past the cap and says so", async () => {
    const { MAX_TREE_ENTRIES } = await import("@/lib/coding-project-tree");
    const big = path.join(project, "generated");
    fs.mkdirSync(big);
    for (let i = 0; i < MAX_TREE_ENTRIES + 5; i++) fs.writeFileSync(path.join(big, `f${String(i).padStart(5, "0")}.txt`), "x");
    const out = await listProjectDir(project, "generated");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.entries).toHaveLength(MAX_TREE_ENTRIES);
    expect(out.truncated).toBe(true);
  });

  it("answers 404 alike for .git, a climb, an absolute path, a link that leaves, a file, and nothing there", async () => {
    for (const bad of [".git", ".git/objects", "../", "..", "/etc", "up", "up/outside.txt", "README.md", "nope", "secrets", "alias"]) {
      const out = await listProjectDir(project, bad);
      expect(out, bad).toEqual({ ok: false, status: 404 });
    }
  });
});

describe("reading a file", () => {
  it("reads a text file with its size", async () => {
    const out = await readProjectFile(project, "src/app.js");
    expect(out).toMatchObject({ ok: true, path: "src/app.js", content: "console.log(1)\n", size: 15, truncated: false, binary: false });
  });

  it("flags a binary file and carries no content for it", async () => {
    const out = await readProjectFile(project, "logo.png");
    expect(out).toMatchObject({ ok: true, binary: true, content: "" });
  });

  it("cuts a file larger than the cap and says so", async () => {
    fs.writeFileSync(path.join(project, "big.txt"), "x".repeat(MAX_TREE_FILE_BYTES + 100));
    const out = await readProjectFile(project, "big.txt");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBe(MAX_TREE_FILE_BYTES);
    expect(out.size).toBe(MAX_TREE_FILE_BYTES + 100);
  });

  it("refuses the project root, a folder, a link out, a protected file, and a climb", async () => {
    for (const bad of ["", ".", "src", "escape.txt", "readme-link.md", "up/outside.txt", "secrets/token", "../outside.txt", "/etc/passwd"]) {
      const out = await readProjectFile(project, bad);
      expect(out.ok, bad).toBe(false);
    }
  });
});

describe("resolving", () => {
  it("resolves the root and a folder inside to real paths", async () => {
    const r = await resolveInsideProject(project, "");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.abs).toBe(fs.realpathSync(project));
    const s = await resolveInsideProject(project, "./src/../src/lib");
    expect(s).toMatchObject({ ok: true, rel: "src/lib" });
  });

  it("refuses a project folder that is not there", async () => {
    expect(await resolveInsideProject(path.join(root, "missing"), "")).toEqual({ ok: false, status: 404 });
  });
});
