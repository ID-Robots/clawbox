/**
 * Per-run git history (src/lib/coding-git.ts).
 *
 * The test that matters is the refusal. Code projects live under
 * `data/code-projects/` INSIDE the ClawBox OS checkout, so
 * `git rev-parse --show-toplevel` from one of them answers the product's own
 * repository. A naive `git add -A && git commit` there would stage against
 * ClawBox itself and land whatever else was staged. Everything below exists to
 * pin that this cannot happen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { buildCommitMessage, commitRunWork } from "@/lib/coding-git";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let root: string;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf-8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", HOME: root },
  }).trim();
}

/** A repository with an identity, so commits work without a global config. */
function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-git-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("refusing to touch a repository that is not the run's own", () => {
  it("REFUSES a folder an enclosing repository tracks", async () => {
    // The exact shape of the hazard: a folder inside a repo that is NOT
    // ignored. Committing here would land in the outer tree.
    const outer = path.join(root, "outer");
    makeRepo(outer);
    fs.writeFileSync(path.join(outer, "owned.txt"), "the outer repo's own file\n");
    git(outer, "add", "-A");
    git(outer, "commit", "--quiet", "-m", "outer");

    const inner = path.join(outer, "sub", "project");
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, "index.html"), "<p>run output</p>\n");

    const out = await commitRunWork({ directory: inner, runId: "run-aaaa1111", task: "t", summary: null });
    expect(out.committed).toBe(false);
    if (out.committed) return;
    expect(out.reason).toBe("foreign_repo");

    // And the outer repository is untouched: one commit, nothing staged.
    expect(git(outer, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(outer, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(fs.existsSync(path.join(inner, ".git"))).toBe(false);
  });

  it("gives a folder its OWN repository when the outer one ignores it", async () => {
    // How every code project looks: data/ is gitignored by ClawBox, so a
    // private history inside it is invisible to the outer tree.
    const outer = path.join(root, "clawbox");
    makeRepo(outer);
    fs.writeFileSync(path.join(outer, ".gitignore"), "data/\n");
    git(outer, "add", "-A");
    git(outer, "commit", "--quiet", "-m", "outer");

    const project = path.join(outer, "data", "code-projects", "site");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "index.html"), "<p>hi</p>\n");

    const out = await commitRunWork({ directory: project, runId: "run-bbbb2222", task: "build a site", summary: "did it" });
    expect(out.committed).toBe(true);
    if (!out.committed) return;
    expect(out.initialized).toBe(true);

    // Its own repo, its own single commit...
    expect(git(project, "rev-parse", "--show-toplevel")).toBe(fs.realpathSync(project));
    expect(git(project, "rev-list", "--count", "HEAD")).toBe("1");
    // ...and the outer repository still has exactly what it had.
    expect(git(outer, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(outer, "status", "--porcelain", "--untracked-files=no")).toBe("");
  });
});

describe("recording a run's work", () => {
  it("initialises a plain folder and commits what changed", async () => {
    const dir = path.join(root, "projects", "app");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "app.js"), "console.log(1);\n");

    const out = await commitRunWork({ directory: dir, runId: "run-cccc3333", task: "make an app", summary: "made it" });
    expect(out.committed).toBe(true);
    if (!out.committed) return;
    expect(out.initialized).toBe(true);
    expect(out.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(git(dir, "show", "--name-only", "--format=", "HEAD")).toContain("app.js");
  });

  it("commits into a repository the folder already owns, without re-initialising", async () => {
    const dir = path.join(root, "existing");
    makeRepo(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "first");

    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    const out = await commitRunWork({ directory: dir, runId: "run-dddd4444", task: "change it", summary: null });
    expect(out.committed).toBe(true);
    if (!out.committed) return;
    expect(out.initialized).toBe(false);
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("2");
    // The owner's identity on the existing repo is left alone.
    expect(git(dir, "config", "user.email")).toBe("test@example.com");
  });

  it("says there was nothing to record rather than making an empty commit", async () => {
    const dir = path.join(root, "clean");
    makeRepo(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "first");

    const out = await commitRunWork({ directory: dir, runId: "run-eeee5555", task: "no-op", summary: null });
    expect(out.committed).toBe(false);
    if (out.committed) return;
    expect(out.reason).toBe("no_changes");
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("never pushes — a commit is local and reversible", async () => {
    const dir = path.join(root, "noremote");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "x.txt"), "x\n");
    await commitRunWork({ directory: dir, runId: "run-ffff6666", task: "t", summary: null });
    // No remote was invented on the owner's behalf.
    expect(git(dir, "remote")).toBe("");
  });
});

describe("the commit message", () => {
  it("carries the task, the summary and the run id", () => {
    const msg = buildCommitMessage({ runId: "run-k3x9q2ab", task: "Add a dark mode toggle\nand keep it accessible", summary: "Edited two files." });
    expect(msg.split("\n")[0]).toBe("Coding agent: Add a dark mode toggle");
    expect(msg).toContain("Edited two files.");
    expect(msg).toContain("Run: run-k3x9q2ab");
  });

  it("stays bounded however long the model was", () => {
    const msg = buildCommitMessage({ runId: "run-k3x9q2ab", task: "x".repeat(500), summary: "y".repeat(5000) });
    expect(msg.length).toBeLessThanOrEqual(900);
    expect(msg.split("\n")[0].length).toBeLessThanOrEqual(90);
  });
});

describe("the project page's git block", () => {
  it("answers nothing-yet for a fresh init, never an error", async () => {
    const dir = path.join(root, "fresh");
    makeRepo(dir);
    const { gitInfo } = await import("@/lib/coding-git");
    expect(await gitInfo(dir)).toEqual({ branch: null, commits: 0, remote: null, lastCommit: null });
  });

  it("reads the branch and the newest commit off ONE git log", async () => {
    const dir = path.join(root, "app");
    makeRepo(dir);
    fs.writeFileSync(path.join(dir, "index.html"), "<p>hi</p>\n");
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "first, with a comma");
    git(dir, "remote", "add", "origin", "https://github.com/owner/app.git");
    const { gitInfo, lastCommit } = await import("@/lib/coding-git");
    const info = await gitInfo(dir);
    expect(info.branch).toBe(git(dir, "rev-parse", "--abbrev-ref", "HEAD"));
    expect(info.commits).toBe(1);
    expect(info.remote).toBe("https://github.com/owner/app.git");
    expect(info.lastCommit?.subject).toBe("first, with a comma");
    expect(info.lastCommit).toEqual(await lastCommit(dir));

    // Detached: what `rev-parse --abbrev-ref HEAD` always answered for it.
    git(dir, "checkout", "--quiet", "--detach");
    expect((await gitInfo(dir)).branch).toBe("HEAD");
  });
});
