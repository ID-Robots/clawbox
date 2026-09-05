/**
 * The project page's workspace (src/lib/coding-git.ts: gitChanges, gitLog,
 * gitFileDiff) against real repositories in a temp folder.
 *
 * Two things are pinned above all: a ref from the URL never reaches git as
 * anything but a sha or HEAD (a "ref" is where `--output=` would go), and a
 * file name never climbs out of the project. The rest is the page's contract:
 * what a run in flight has changed, what a finished run's commit changed, and
 * the diff of one file in either.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { gitChanges, gitFileDiff, gitLog, isSafeGitRef, safeProjectRelativePath } from "@/lib/coding-git";

let root: string;
let repo: string;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf-8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", HOME: root },
  }).trim();
}

function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
}

function write(rel: string, text: string): void {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-git-changes-"));
  repo = path.join(root, "project");
  makeRepo(repo);
  write("a.txt", "one\ntwo\nthree\n");
  write("b.txt", "gone soon\n");
  write("src/app.js", "console.log(1)\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "first");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the working tree", () => {
  it("lists what a run in flight has changed, with line counts, untracked files included", async () => {
    write("a.txt", "one\nTWO\nthree\nfour\n");
    fs.rmSync(path.join(repo, "b.txt"));
    write("src/new.js", "a\nb\nc\n");
    write("bin.dat", "\0\0\0binary");

    const out = await gitChanges(repo);
    expect(out.available).toBe(true);
    expect(out.truncated).toBe(false);
    expect(out.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["a.txt", "modified", 2, 1],
      ["b.txt", "deleted", 0, 1],
      // Untracked: counted by hand so the list can say +3 the way it does
      // for a tracked file; a binary one carries no count.
      ["bin.dat", "untracked", null, 0],
      ["src/new.js", "untracked", 3, 0],
    ]);
    expect(out.additions).toBe(5);
    expect(out.deletions).toBe(2);
  });

  it("is empty — and available — for a clean tree", async () => {
    const out = await gitChanges(repo);
    expect(out).toEqual({ files: [], additions: 0, deletions: 0, truncated: false, available: true });
  });

  it("reads a fresh `git init` with nothing committed as everything added", async () => {
    const fresh = path.join(root, "fresh");
    makeRepo(fresh);
    fs.writeFileSync(path.join(fresh, "index.html"), "<p>hi</p>\n<p>there</p>\n");
    const out = await gitChanges(fresh);
    expect(out.available).toBe(true);
    expect(out.files).toEqual([{ path: "index.html", status: "untracked", additions: 2, deletions: 0 }]);
    const diff = await gitFileDiff(fresh, "index.html");
    expect(diff?.diff).toContain("+<p>hi</p>");
  });

  it("says a folder with no repository has nothing to show, rather than a clean tree", async () => {
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, "x.txt"), "x\n");
    const out = await gitChanges(plain);
    expect(out.available).toBe(false);
    expect(out.files).toEqual([]);
    expect(await gitLog(plain)).toEqual([]);
  });
});

describe("one file's diff", () => {
  it("diffs a modified file against HEAD, without colour", async () => {
    write("a.txt", "one\nTWO\nthree\n");
    const out = await gitFileDiff(repo, "a.txt");
    expect(out).toMatchObject({ path: "a.txt", truncated: false, binary: false });
    expect(out?.diff).toContain("--- a/a.txt");
    expect(out?.diff).toContain("-two");
    expect(out?.diff).toContain("+TWO");
    expect(out?.diff).not.toMatch(/\x1b\[/);
  });

  it("shows an untracked file as wholly added", async () => {
    write("src/new.js", "a\nb\n");
    const out = await gitFileDiff(repo, "src/new.js");
    expect(out?.diff).toContain("+a");
    expect(out?.diff).toContain("+b");
    expect(out?.diff).toContain("/dev/null");
  });

  it("shows a deleted file as wholly removed", async () => {
    fs.rmSync(path.join(repo, "b.txt"));
    const out = await gitFileDiff(repo, "b.txt");
    expect(out?.diff).toContain("-gone soon");
  });

  it("flags a binary file instead of dumping it", async () => {
    write("bin.dat", "\0\0\0binary");
    const out = await gitFileDiff(repo, "bin.dat");
    expect(out?.binary).toBe(true);
  });

  it("answers null for an unchanged file and for one that is not there", async () => {
    // Unchanged: git prints nothing against HEAD, and there is no untracked
    // file of that name to show — an empty diff, not a refusal.
    const same = await gitFileDiff(repo, "a.txt");
    expect(same?.diff).toBe("");
    expect(await gitFileDiff(repo, "nope.txt")).toBeNull();
  });

  it("cuts a very long diff and says so", async () => {
    write("big.txt", Array.from({ length: 30_000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n") + "\n");
    const out = await gitFileDiff(repo, "big.txt");
    expect(out?.truncated).toBe(true);
    expect(out?.diff.length).toBeLessThanOrEqual(200_000);
  });
});

describe("a finished run's commit", () => {
  it("lists the commits newest first, and one commit's own changes with a diff per file", async () => {
    write("a.txt", "one\nTWO\nthree\n");
    write("c.txt", "new\n");
    fs.rmSync(path.join(repo, "b.txt"));
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "run abc123: the second");

    const log = await gitLog(repo);
    expect(log.map((c) => c.subject)).toEqual(["run abc123: the second", "first"]);
    expect(log[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(log[0].date).toBeGreaterThan(1_600_000_000_000);

    const out = await gitChanges(repo, log[0].sha);
    expect(out.available).toBe(true);
    expect(out.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["a.txt", "modified", 1, 1],
      ["b.txt", "deleted", 0, 1],
      ["c.txt", "added", 1, 0],
    ]);

    const diff = await gitFileDiff(repo, "a.txt", log[0].sha);
    expect(diff?.diff).toContain("-two");
    expect(diff?.diff).toContain("+TWO");
    // The working tree is clean now — the run committed — so the tree view
    // shows nothing while the commit view shows the work. That is the point.
    expect((await gitChanges(repo)).files).toEqual([]);
  });

  it("shows the root commit's changes too", async () => {
    const [first] = (await gitLog(repo)).slice(-1);
    const out = await gitChanges(repo, first.sha);
    expect(out.files.map((f) => f.path)).toEqual(["a.txt", "b.txt", "src/app.js"]);
    expect(out.files.every((f) => f.status === "added")).toBe(true);
  });

  it("accepts HEAD and a short sha, the two spellings the page sends", async () => {
    const sha = git(repo, "rev-parse", "--short", "HEAD");
    expect((await gitChanges(repo, "HEAD")).available).toBe(true);
    expect((await gitChanges(repo, sha)).available).toBe(true);
  });
});

describe("what never reaches git", () => {
  it("refuses a ref that is not a sha or HEAD — an argv option, a branch name, a range", async () => {
    const trap = path.join(root, "written-by-git");
    // (An EMPTY ref is not a bad one: it is the working tree, which is what
    // the route passes when the page asked for no commit.)
    for (const bad of [`--output=${trap}`, "main", "HEAD~1", "HEAD..main", "-p", "abc"]) {
      expect(isSafeGitRef(bad)).toBe(false);
      expect((await gitChanges(repo, bad)).available).toBe(false);
      expect(await gitFileDiff(repo, "a.txt", bad)).toBeNull();
    }
    expect(fs.existsSync(trap)).toBe(false);
  });

  it("refuses a file path that climbs out of the project, or is absolute", async () => {
    for (const bad of ["../outside.txt", "src/../../x", "/etc/passwd", "", "a\0b"]) {
      expect(safeProjectRelativePath(bad)).toBeNull();
      expect(await gitFileDiff(repo, bad)).toBeNull();
    }
    // And folds a spelling git would print differently to the one it prints.
    expect(safeProjectRelativePath("./src//app.js")).toBe("src/app.js");
  });
});
