/**
 * The team's git plumbing against a REAL repository in a temp folder: the
 * team branch, a worker's worktree and branch, the merge home, a conflict
 * aborted rather than guessed at, and the worktree's removal.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { addWorkerWorktree, changedFiles, ensureTeamBranch, mergeWorkerBranch, removeWorktree, teamBranchName, workerBranchName } from "@/lib/coding-team-worktree";

let dir: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } }).trim();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-wt-"));
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.email", "t@x");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>Hello</h1>\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a coding team's git plumbing", () => {
  it("forks the team branch from the checkout, gives a worker a worktree on its own branch, and merges it home", async () => {
    const team = await ensureTeamBranch(dir, "team-abc");
    expect(team).toEqual({ ok: true, branch: teamBranchName("team-abc"), base: "master" });
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("clawbox/team-abc");
    // .clawbox/ is kept out of git status without touching the project's .gitignore.
    expect(fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8")).toContain("/.clawbox/");

    const wt = await addWorkerWorktree(dir, "team-abc", "t1", 1);
    expect(wt).toMatchObject({ ok: true, path: path.join(dir, ".clawbox", "worktrees", "t1-1"), branch: workerBranchName("team-abc", "t1", 1) });
    if (!wt.ok) return;
    expect(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("clawbox/team-abc-t1-1");
    fs.writeFileSync(path.join(wt.path, "app.js"), "console.log(1)\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-q", "-m", "Coding agent: wire app.js");
    expect(await changedFiles(dir, wt.branch)).toEqual(["app.js"]);
    expect(git(dir, "status", "--porcelain")).toBe("");

    const merged = await mergeWorkerBranch(dir, wt.branch, "Coding team team-abc: t1");
    expect(merged).toEqual({ ok: true, merged: true });
    expect(fs.existsSync(path.join(dir, "app.js"))).toBe(true);
    expect(git(dir, "log", "-1", "--format=%s")).toBe("Coding team team-abc: t1");
    await removeWorktree(dir, wt.path);
    expect(fs.existsSync(wt.path)).toBe(false);
    // The branch stays as history.
    expect(git(dir, "branch", "--list", "clawbox/team-abc-t1-1")).toContain("t1-1");
  });

  it("reports a branch that added nothing, and aborts a conflict instead of guessing", async () => {
    await ensureTeamBranch(dir, "team-abc");
    const idle = await addWorkerWorktree(dir, "team-abc", "t1", 1);
    if (!idle.ok) throw new Error(idle.detail);
    expect(await mergeWorkerBranch(dir, idle.branch, "m")).toEqual({ ok: true, merged: false });
    await removeWorktree(dir, idle.path);

    // Two workers change the same line: the second one's merge conflicts.
    const a = await addWorkerWorktree(dir, "team-abc", "t2", 1);
    const b = await addWorkerWorktree(dir, "team-abc", "t3", 1);
    if (!a.ok || !b.ok) throw new Error("worktrees");
    fs.writeFileSync(path.join(a.path, "index.html"), "<h1>From A</h1>\n");
    git(a.path, "commit", "-q", "-am", "A");
    fs.writeFileSync(path.join(b.path, "index.html"), "<h1>From B</h1>\n");
    git(b.path, "commit", "-q", "-am", "B");
    expect(await mergeWorkerBranch(dir, a.branch, "A home")).toEqual({ ok: true, merged: true });
    const clash = await mergeWorkerBranch(dir, b.branch, "B home");
    expect(clash).toMatchObject({ ok: false, conflict: true });
    if (clash.ok) return;
    expect(clash.detail).toMatch(/CONFLICT/);
    // Aborted: the checkout is clean and still says A.
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(fs.readFileSync(path.join(dir, "index.html"), "utf8")).toBe("<h1>From A</h1>\n");
    await removeWorktree(dir, a.path);
    await removeWorktree(dir, b.path);
  });

  it("makes the first commit on a repository that has none, so the fork is a fork", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "team-wt-empty-"));
    try {
      git(empty, "init", "-q", "-b", "main");
      git(empty, "config", "user.email", "t@x");
      git(empty, "config", "user.name", "t");
      const team = await ensureTeamBranch(empty, "team-x");
      expect(team).toEqual({ ok: true, branch: "clawbox/team-x", base: "main" });
      expect(git(empty, "branch", "--list", "main")).toContain("main");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("refuses a folder that is not a repository", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "team-wt-plain-"));
    try {
      expect(await ensureTeamBranch(plain, "team-x")).toMatchObject({ ok: false });
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
