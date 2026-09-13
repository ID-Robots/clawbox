/**
 * A run's own git plumbing against a REAL repository in a temp folder: the
 * worktree and its branch, the shared node_modules link, the three folders
 * that keep the old in-place behaviour, the restore a resume needs, and the
 * sweep's two rules (old enough, and merged or gone).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  addRunWorktree,
  branchExists,
  branchIsMerged,
  commitsAhead,
  deleteRunBranch,
  linkSharedNodeModules,
  listRunWorktrees,
  removeRunWorktree,
  restoreRunWorktree,
  runWorktreePath,
  sweepRunWorktrees,
} from "@/lib/coding-run-worktree";

// Starts a real process (git): vitest's 5 s test and 10 s hook defaults are
// not enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let dir: string;
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
const PROTECTED = "/nowhere/clawbox-checkout";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-wt-"));
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

describe("a run's worktree", () => {
  it("forks the project's current branch into .clawbox/worktrees/<runId> and leaves the project checkout alone", async () => {
    const made = await addRunWorktree({ projectDir: dir, runId: "run-aaaabbbb", protectedRoot: PROTECTED });
    expect(made).toEqual({
      ok: true,
      path: runWorktreePath(dir, "run-aaaabbbb"),
      branch: "clawbox/run-aaaabbbb",
      base: "master",
    });
    if (!made.ok) return;
    expect(git(made.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("clawbox/run-aaaabbbb");
    // The project checkout has not moved off its own branch — the whole point.
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("master");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8")).toContain("/.clawbox/");
  });

  it("gives two runs of one project trees that cannot see each other's half-written files", async () => {
    const a = await addRunWorktree({ projectDir: dir, runId: "run-aaaaaaaa", protectedRoot: PROTECTED });
    const b = await addRunWorktree({ projectDir: dir, runId: "run-bbbbbbbb", protectedRoot: PROTECTED });
    if (!a.ok || !b.ok) throw new Error("both worktrees should have been made");
    fs.writeFileSync(path.join(a.path, "a.js"), "a\n");
    fs.writeFileSync(path.join(b.path, "b.js"), "b\n");
    expect(fs.existsSync(path.join(a.path, "b.js"))).toBe(false);
    expect(fs.existsSync(path.join(b.path, "a.js"))).toBe(false);
    git(a.path, "add", "-A");
    git(a.path, "commit", "-q", "-m", "run a");
    // B's commit carries B's file alone.
    git(b.path, "add", "-A");
    git(b.path, "commit", "-q", "-m", "run b");
    expect(git(dir, "show", "--name-only", "--format=", "clawbox/run-bbbbbbbb").trim()).toBe("b.js");
  });

  it("symlinks the project's node_modules into the worktree and never over one that is already there", async () => {
    fs.mkdirSync(path.join(dir, "node_modules", "left-pad"), { recursive: true });
    const made = await addRunWorktree({ projectDir: dir, runId: "run-nodemods", protectedRoot: PROTECTED });
    if (!made.ok) throw new Error(made.detail);
    const link = path.join(made.path, "node_modules");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(link, "left-pad"))).toBe(true);
    // A second call over an existing entry changes nothing.
    expect(linkSharedNodeModules(dir, made.path)).toBe(false);
  });

  it("keeps the old in-place behaviour for a folder that is not a repository, is not its root, or is ClawBox's own checkout", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "run-wt-plain-"));
    try {
      expect(await addRunWorktree({ projectDir: plain, runId: "run-plain000", protectedRoot: PROTECTED }))
        .toMatchObject({ ok: false, reason: "no_repository" });
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }

    const sub = path.join(dir, "packages", "app");
    fs.mkdirSync(sub, { recursive: true });
    expect(await addRunWorktree({ projectDir: sub, runId: "run-sub00000", protectedRoot: PROTECTED }))
      .toMatchObject({ ok: false, reason: "not_repository_root" });

    // The project IS the protected checkout: refused before anything is made.
    expect(await addRunWorktree({ projectDir: dir, runId: "run-guard000", protectedRoot: dir }))
      .toMatchObject({ ok: false, reason: "protected_checkout" });
    expect(fs.existsSync(path.join(dir, ".clawbox"))).toBe(false);
  });

  it("forks a repository with no commits at all", async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "run-wt-unborn-"));
    try {
      git(fresh, "init", "-q", "-b", "main");
      git(fresh, "config", "user.email", "t@x");
      git(fresh, "config", "user.name", "t");
      const made = await addRunWorktree({ projectDir: fresh, runId: "run-unborn00", protectedRoot: PROTECTED });
      expect(made).toMatchObject({ ok: true, base: "main", branch: "clawbox/run-unborn00" });
      // The base branch exists in its own right, so the fork is a fork.
      expect(git(fresh, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("counts what a run left on its branch, and calls a merged branch merged", async () => {
    const made = await addRunWorktree({ projectDir: dir, runId: "run-merge000", protectedRoot: PROTECTED });
    if (!made.ok) throw new Error(made.detail);
    expect(await commitsAhead(dir, made.branch, made.base)).toBe(0);
    expect(await branchIsMerged(dir, made.branch, made.base)).toBe(true);
    fs.writeFileSync(path.join(made.path, "app.js"), "console.log(1)\n");
    git(made.path, "add", "-A");
    git(made.path, "commit", "-q", "-m", "run work");
    expect(await commitsAhead(dir, made.branch, made.base)).toBe(1);
    expect(await branchIsMerged(dir, made.branch, made.base)).toBe(false);
    git(dir, "merge", "--no-ff", "--no-edit", made.branch);
    expect(await branchIsMerged(dir, made.branch, made.base)).toBe(true);
  });

  it("puts a removed worktree back for a resume, from the branch that survived it", async () => {
    const made = await addRunWorktree({ projectDir: dir, runId: "run-restore0", protectedRoot: PROTECTED });
    if (!made.ok) throw new Error(made.detail);
    fs.writeFileSync(path.join(made.path, "half.js"), "half\n");
    git(made.path, "add", "-A");
    git(made.path, "commit", "-q", "-m", "half the work");
    await removeRunWorktree(dir, made.path);
    expect(fs.existsSync(made.path)).toBe(false);
    expect(await restoreRunWorktree(dir, made.path, made.branch, made.base)).toBe(true);
    expect(fs.existsSync(path.join(made.path, "half.js"))).toBe(true);
    // Already there is still "usable".
    expect(await restoreRunWorktree(dir, made.path, made.branch, made.base)).toBe(true);
  });

  it("forks the branch again when a settle removed an empty one, so a resume is still possible", async () => {
    const made = await addRunWorktree({ projectDir: dir, runId: "run-emptyone", protectedRoot: PROTECTED });
    if (!made.ok) throw new Error(made.detail);
    await removeRunWorktree(dir, made.path);
    await deleteRunBranch(dir, made.branch);
    expect(await branchExists(dir, made.branch)).toBe(false);
    expect(await restoreRunWorktree(dir, made.path, made.branch, made.base)).toBe(true);
    expect(git(made.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(made.branch);
  });

  it("lists only the box's own worktrees, never the owner's", async () => {
    const made = await addRunWorktree({ projectDir: dir, runId: "run-listed00", protectedRoot: PROTECTED });
    if (!made.ok) throw new Error(made.detail);
    const theirs = path.join(os.tmpdir(), `owner-wt-${process.pid}`);
    git(dir, "worktree", "add", "-b", "their-branch", theirs, "master");
    try {
      const listed = await listRunWorktrees(dir);
      expect(listed).toEqual([{ path: made.path, branch: "clawbox/run-listed00" }]);
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", theirs], { cwd: dir, env });
    }
  });

  it("sweeps a merged worktree older than the age and keeps a young one, an unmerged one and one in use", async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    const merged = await addRunWorktree({ projectDir: dir, runId: "run-old-mrgd", protectedRoot: PROTECTED });
    const unmerged = await addRunWorktree({ projectDir: dir, runId: "run-old-work", protectedRoot: PROTECTED });
    const young = await addRunWorktree({ projectDir: dir, runId: "run-young000", protectedRoot: PROTECTED });
    const busy = await addRunWorktree({ projectDir: dir, runId: "run-busy0000", protectedRoot: PROTECTED });
    if (!merged.ok || !unmerged.ok || !young.ok || !busy.ok) throw new Error("fixtures");
    fs.writeFileSync(path.join(unmerged.path, "work.js"), "kept\n");
    git(unmerged.path, "add", "-A");
    git(unmerged.path, "commit", "-q", "-m", "unmerged work");
    for (const p of [merged.path, unmerged.path, busy.path]) fs.utimesSync(p, old, old);

    const outcome = await sweepRunWorktrees(dir, { inUse: new Set([busy.path]) });
    expect(outcome.removed).toEqual([merged.path]);
    expect(outcome.kept.sort()).toEqual([busy.path, unmerged.path, young.path].sort());
    expect(fs.existsSync(merged.path)).toBe(false);
    // A swept branch that held nothing is gone too; the unmerged one stays.
    expect(await branchExists(dir, merged.branch)).toBe(false);
    expect(await branchExists(dir, unmerged.branch)).toBe(true);
  });

  it("prunes a worktree whose files somebody deleted by hand", async () => {
    const made = await addRunWorktree({ projectDir: dir, runId: "run-handgone", protectedRoot: PROTECTED });
    if (!made.ok) throw new Error(made.detail);
    fs.rmSync(made.path, { recursive: true, force: true });
    const outcome = await sweepRunWorktrees(dir);
    expect(outcome.removed).toEqual([made.path]);
    expect(await listRunWorktrees(dir)).toEqual([]);
  });

  it("says whether the files are actually gone, not whether git was happy", async () => {
    const made = await addRunWorktree({ projectDir: dir, runId: "run-report00", protectedRoot: PROTECTED });
    if (!made.ok) throw new Error(made.detail);
    expect(await removeRunWorktree(dir, made.path)).toBe(true);
    // A path git no longer knows and that is not there either is still "gone":
    // only git's own registration was stale, and the caller wanted the files
    // removed.
    expect(await removeRunWorktree(dir, made.path)).toBe(true);
    // A path that IS there and is not a worktree of this repository is not:
    // recording it as removed would leave the disk unreclaimed with nothing to
    // retry from.
    const stranger = path.join(dir, "not-a-worktree");
    fs.mkdirSync(stranger, { recursive: true });
    expect(await removeRunWorktree(dir, stranger)).toBe(false);
    expect(fs.existsSync(stranger)).toBe(true);

    // "I cannot look" is not "it is gone": only ENOENT counts, so a stat that
    // fails for any other reason leaves the caller able to try again.
    const stat = vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    try {
      expect(await removeRunWorktree(dir, stranger)).toBe(false);
    } finally {
      stat.mockRestore();
    }
  });

  it("drops a run branch on request", async () => {
    const made = await addRunWorktree({ projectDir: dir, runId: "run-dropped0", protectedRoot: PROTECTED });
    if (!made.ok) throw new Error(made.detail);
    await removeRunWorktree(dir, made.path);
    expect(await deleteRunBranch(dir, made.branch)).toBe(true);
    expect(await branchExists(dir, made.branch)).toBe(false);
  });
});
