/**
 * The team's git plumbing against a REAL repository in a temp folder: the
 * team branch, a worker's worktree and branch, the merge home, a conflict
 * aborted rather than guessed at, and the worktree's removal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { addWorkerWorktree, adoptOwnBranchWork, changedFiles, committableFiles, ensureTeamBranch, forkBase, harvestWorktree, isGeneratedArtifact, mergeWorkerBranch, removeWorktree, teamBranchName, workerBranchName } from "@/lib/coding-team-worktree";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

  it("commits what lay uncommitted in the checkout before a merge, so a file the worker also brought does not block it", async () => {
    const made = await ensureTeamBranch(dir, "team-x");
    expect(made.ok).toBe(true);
    const wt = await addWorkerWorktree(dir, "team-x", "t1", 1);
    if (!wt.ok) throw new Error(wt.detail);
    // The worker writes its file AND a favicon; meanwhile the box drew the
    // same favicon into the team's checkout, uncommitted.
    fs.writeFileSync(path.join(wt.path, "index.html"), "<h1>hi</h1>\n");
    fs.writeFileSync(path.join(wt.path, "favicon.ico"), "icon-bytes");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-q", "-m", "worker: index and favicon");
    fs.writeFileSync(path.join(dir, "favicon.ico"), "icon-bytes");
    const merged = await mergeWorkerBranch(dir, wt.branch, "merge t1");
    expect(merged).toEqual({ ok: true, merged: true });
    expect(fs.readFileSync(path.join(dir, "index.html"), "utf8")).toBe("<h1>hi</h1>\n");
    expect(fs.readFileSync(path.join(dir, "favicon.ico"), "utf8")).toBe("icon-bytes");
    // The stray file went on the team branch in a commit of its own, before the merge.
    expect(git(dir, "log", "--oneline", "-3")).toMatch(/files present in the checkout before a merge/);
    expect(git(dir, "status", "--porcelain")).toBe("");
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

describe("where a new team forks from", () => {
  /** A team branch with one commit on it, left checked out the way a failed team leaves it. */
  async function failedTeam(id: string, recorded?: (b: string) => string | null): Promise<string> {
    const made = await ensureTeamBranch(dir, id, recorded);
    if (!made.ok) throw new Error(made.detail);
    fs.writeFileSync(path.join(dir, `${id}.js`), "an old fix\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", `fix of ${id}`);
    return git(dir, "rev-parse", "HEAD");
  }

  it("forks from the base the team on the checked-out branch recorded, followed back past teams that forked from teams", async () => {
    git(dir, "checkout", "-q", "-b", "release");
    const releaseTip = git(dir, "rev-parse", "HEAD");
    await failedTeam("team-aaaaaaaa");
    const recorded: Record<string, string> = { "clawbox/team-aaaaaaaa": "release" };
    const b = await ensureTeamBranch(dir, "team-bbbbbbbb", (branch) => recorded[branch] ?? null);
    expect(b).toEqual({ ok: true, branch: "clawbox/team-bbbbbbbb", base: "release" });
    expect(git(dir, "rev-parse", "HEAD")).toBe(releaseTip);
    // A board from before the fix recorded a team branch as its base: followed back to release.
    recorded["clawbox/team-bbbbbbbb"] = "clawbox/team-aaaaaaaa";
    await failedTeam("team-cccccccc");
    recorded["clawbox/team-cccccccc"] = "clawbox/team-bbbbbbbb";
    expect(await forkBase(dir, (branch) => recorded[branch] ?? null)).toEqual({ ok: true, base: "release", from: "release" });
  });

  it("falls back to the remote's default branch, then main, master or develop — and refuses rather than fork a team's branch", async () => {
    await failedTeam("team-aaaaaaaa");
    expect(await forkBase(dir)).toEqual({ ok: true, base: "master", from: "master" });
    // The remote's default comes before master.
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "team-wt-remote-"));
    try {
      git(remote, "init", "-q", "--bare", "-b", "develop");
      git(dir, "remote", "add", "origin", remote);
      git(dir, "push", "-q", "origin", "master:develop");
      git(dir, "remote", "set-head", "origin", "develop");
      expect(await forkBase(dir)).toEqual({ ok: true, base: "develop", from: "origin/develop" });
      git(dir, "remote", "remove", "origin");
    } finally {
      fs.rmSync(remote, { recursive: true, force: true });
    }
    // Nothing but team branches: no fork at all, and why.
    git(dir, "branch", "-q", "-m", "master", "trunk");
    const none = await ensureTeamBranch(dir, "team-bbbbbbbb");
    expect(none).toMatchObject({ ok: false });
    if (!none.ok) expect(none.detail).toMatch(/clawbox\/team-aaaaaaaa, a coding team's branch/);
    // A branch that is not a team's is forked as it always was.
    git(dir, "checkout", "-q", "trunk");
    expect(await forkBase(dir)).toEqual({ ok: true, base: "trunk", from: null });
  });
});

/**
 * The bench, 2026-09-26: a worker wrote its two files in its worktree and
 * nothing reached its branch. The team merged the empty branch and removed
 * the worktree — the files with it. The harvest commits what was left behind
 * before the team judges the branch.
 */
describe("the harvest of a worker's worktree", () => {
  const MESSAGE = "Coding agent: Your task (t1 of 2): write the contract\n\nDone — both files delivered.\n\nRun: run-abc12345";

  it("commits what the worker left uncommitted on its branch, so the branch has it to merge", async () => {
    await ensureTeamBranch(dir, "team-h");
    const wt = await addWorkerWorktree(dir, "team-h", "t1", 1);
    if (!wt.ok) throw new Error(wt.detail);
    fs.writeFileSync(path.join(wt.path, "api-contract.md"), "# Contract\n");
    fs.writeFileSync(path.join(wt.path, "items.json"), "[]\n");
    fs.writeFileSync(path.join(wt.path, "index.html"), "<h1>changed</h1>\n");
    // A name git would read as a glob if it were not taken literally.
    fs.mkdirSync(path.join(wt.path, "docs"));
    fs.writeFileSync(path.join(wt.path, "docs", "a *b.md"), "not a glob\n");
    fs.mkdirSync(path.join(wt.path, "__pycache__"));
    fs.writeFileSync(path.join(wt.path, "__pycache__", "x.cpython-310.pyc"), "bytes");
    expect(await changedFiles(dir, wt.branch)).toEqual([]);

    const harvested = await harvestWorktree(wt.path, MESSAGE);
    if (!harvested.ok) throw new Error(harvested.detail);
    expect([...harvested.files].sort()).toEqual(["api-contract.md", "docs/a *b.md", "index.html", "items.json"]);
    expect((await changedFiles(dir, wt.branch)).sort()).toEqual(["api-contract.md", "docs/a *b.md", "index.html", "items.json"]);
    // The runner's own message shape, on the worker's branch, and nothing left behind.
    expect(git(wt.path, "log", "-1", "--format=%s")).toBe("Coding agent: Your task (t1 of 2): write the contract");
    expect(git(wt.path, "log", "-1", "--format=%b")).toContain("Run: run-abc12345");
    expect(git(wt.path, "status", "--porcelain")).toBe("");
    expect(git(wt.path, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("__pycache__");

    expect(await mergeWorkerBranch(dir, wt.branch, "t1 home")).toEqual({ ok: true, merged: true });
    expect(fs.readFileSync(path.join(dir, "api-contract.md"), "utf8")).toBe("# Contract\n");
    await removeWorktree(dir, wt.path);
  });

  it("stages a rename's old name with its new one", async () => {
    await ensureTeamBranch(dir, "team-h");
    const wt = await addWorkerWorktree(dir, "team-h", "t1", 1);
    if (!wt.ok) throw new Error(wt.detail);
    git(wt.path, "mv", "index.html", "home.html");
    const harvested = await harvestWorktree(wt.path, MESSAGE);
    expect(harvested.ok && [...harvested.files].sort()).toEqual(["home.html", "index.html"]);
    const tree = git(wt.path, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
    expect(tree).toContain("home.html");
    expect(tree).not.toContain("index.html");
    expect(git(wt.path, "status", "--porcelain")).toBe("");
  });

  it("leaves generated artifacts and .clawbox/ out even where git's exclude does not", async () => {
    await ensureTeamBranch(dir, "team-h");
    const wt = await addWorkerWorktree(dir, "team-h", "t1", 1);
    if (!wt.ok) throw new Error(wt.detail);
    // The exclude is written best effort; here it is not there at all.
    fs.writeFileSync(path.join(dir, ".git", "info", "exclude"), "");
    fs.writeFileSync(path.join(wt.path, "note.md"), "kept\n");
    fs.mkdirSync(path.join(wt.path, "__pycache__"));
    fs.writeFileSync(path.join(wt.path, "__pycache__", "x.cpython-310.pyc"), "bytes");
    fs.mkdirSync(path.join(wt.path, ".clawbox"));
    fs.writeFileSync(path.join(wt.path, ".clawbox", "state.json"), "{}");
    const harvested = await harvestWorktree(wt.path, MESSAGE);
    expect(harvested).toEqual({ ok: true, files: ["note.md"] });
    expect(await changedFiles(dir, wt.branch)).toEqual(["note.md"]);
    // Left where they were, uncommitted.
    expect(git(wt.path, "status", "--porcelain", "--untracked-files=all")).toMatch(/__pycache__\/x\.cpython-310\.pyc/);
  });

  it("commits nothing in a worktree the worker left clean", async () => {
    await ensureTeamBranch(dir, "team-h");
    const wt = await addWorkerWorktree(dir, "team-h", "t1", 1);
    if (!wt.ok) throw new Error(wt.detail);
    const before = git(wt.path, "rev-parse", "HEAD");
    expect(await harvestWorktree(wt.path, MESSAGE)).toEqual({ ok: true, files: [] });
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(before);
    expect(await changedFiles(dir, wt.branch)).toEqual([]);
  });

  it("counts only the written files git could have committed: still there, and not ignored", async () => {
    fs.writeFileSync(path.join(dir, ".gitignore"), "*.log\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "ignore logs");
    await ensureTeamBranch(dir, "team-h");
    const wt = await addWorkerWorktree(dir, "team-h", "t1", 1);
    if (!wt.ok) throw new Error(wt.detail);
    fs.writeFileSync(path.join(wt.path, "notes.md"), "kept\n");
    fs.writeFileSync(path.join(wt.path, "e2e.log"), "ignored by the project\n");
    fs.mkdirSync(path.join(wt.path, ".clawbox"));
    fs.writeFileSync(path.join(wt.path, ".clawbox", "state.json"), "{}");
    // e2e_check.py was written and deleted again; index.html is tracked and untouched.
    expect(await committableFiles(wt.path, ["notes.md", "e2e.log", ".clawbox/state.json", "e2e_check.py", "index.html"])).toEqual(["notes.md", "index.html"]);
    expect(await committableFiles(wt.path, ["e2e_check.py"])).toEqual([]);
    expect(await committableFiles(wt.path, ["notes.md"])).toEqual(["notes.md"]);
  });

  it("reports a folder git cannot read instead of calling it clean", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "team-wt-plain-"));
    try {
      const harvested = await harvestWorktree(plain, MESSAGE);
      expect(harvested).toMatchObject({ ok: false });
      if (!harvested.ok) expect(harvested.detail).toMatch(/not a git repository/);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

/**
 * team-6rgz8cyx and team-5oxkp7a9 (2026-09-06): CPython wrote
 * __pycache__/calc.cpython-310.pyc beside the file each task named. It was
 * swept in by `git add -A`, and the third alert of the run was git refusing
 * to merge two workers' copies of it: "Cannot merge binary files". The run
 * died on the alert ceiling with correct work in hand.
 */
describe("generated artifacts", () => {
  it("keeps a worker's bytecode cache out of git entirely", async () => {
    const team = await ensureTeamBranch(dir, "team-art");
    expect(team.ok).toBe(true);

    const exclude = fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("__pycache__/");
    expect(exclude).toContain("*.py[cod]");

    const wt = await addWorkerWorktree(dir, "team-art", "t1", 1);
    if (!wt.ok) throw new Error(wt.detail);

    // A worker edits the file its task named; the interpreter leaves a .pyc.
    fs.writeFileSync(path.join(wt.path, "calc.py"), "def add(a, b):\n    return a + b\n");
    fs.mkdirSync(path.join(wt.path, "__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(wt.path, "__pycache__", "calc.cpython-310.pyc"), Buffer.from([0x6f, 0x0d, 0x0d, 0x0a, 0x00, 0xff]));

    git(wt.path, "add", "-A");
    git(wt.path, "-c", "user.email=t@x", "-c", "user.name=t", "commit", "-q", "-m", "work");

    const inCommit = git(wt.path, "show", "--name-only", "--pretty=format:", "HEAD").split("\n").filter(Boolean);
    expect(inCommit).toContain("calc.py");
    expect(inCommit.some((f) => f.includes("__pycache__"))).toBe(false);

    const merged = await mergeWorkerBranch(dir, wt.branch, "bring t1 home");
    expect(merged).toMatchObject({ ok: true });
  });

  it("names what is generated and what is merely built on purpose", () => {
    expect(isGeneratedArtifact("__pycache__/calc.cpython-310.pyc")).toBe(true);
    expect(isGeneratedArtifact("src/__pycache__/a.pyc")).toBe(true);
    expect(isGeneratedArtifact("node_modules/x/index.js")).toBe(true);
    expect(isGeneratedArtifact(".DS_Store")).toBe(true);
    expect(isGeneratedArtifact("app.tsbuildinfo")).toBe(true);
    // A task can be asked to produce these, so they stay visible.
    expect(isGeneratedArtifact("dist/bundle.js")).toBe(false);
    expect(isGeneratedArtifact("src/calc.py")).toBe(false);
  });
});

describe("work a run committed on a branch of its own", () => {
  /** A worker's worktree on the team branch, and a commit helper in it. */
  async function worker(task = "t1") {
    await ensureTeamBranch(dir, "team-abc");
    const wt = await addWorkerWorktree(dir, "team-abc", task, 1);
    if (!wt.ok) throw new Error(wt.detail);
    const commit = (file: string, content: string, message = `write ${file}`) => {
      fs.writeFileSync(path.join(wt.path, file), content);
      git(wt.path, "add", "-A");
      git(wt.path, "commit", "-q", "-m", message);
      return git(wt.path, "rev-parse", "HEAD");
    };
    return { ...wt, commit };
  }

  it("moves the given branch forward to a branch the run made with `git checkout -b`, and puts HEAD back on it", async () => {
    const wt = await worker();
    git(wt.path, "checkout", "-q", "-b", "fix/arrows");
    const work = wt.commit("app.js", "console.log(1)\n");
    expect(await adoptOwnBranchWork(wt.path, wt.branch)).toEqual({ ok: true, from: "fix/arrows" });
    expect(git(dir, "rev-parse", wt.branch)).toBe(work);
    expect(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt.branch);
    expect(git(wt.path, "status", "--porcelain")).toBe("");
    expect(await changedFiles(dir, wt.branch)).toEqual(["app.js"]);
    // The run's own branch is left as it is.
    expect(git(dir, "rev-parse", "fix/arrows")).toBe(work);
  });

  it("keeps what the run left uncommitted on its own branch in the tree, for the harvest", async () => {
    const wt = await worker();
    git(wt.path, "checkout", "-q", "-b", "fix/own");
    wt.commit("app.js", "console.log(1)\n");
    fs.writeFileSync(path.join(wt.path, "notes.md"), "left over\n");
    expect(await adoptOwnBranchWork(wt.path, wt.branch)).toEqual({ ok: true, from: "fix/own" });
    expect(await harvestWorktree(wt.path, "harvest")).toEqual({ ok: true, files: ["notes.md"] });
    expect(git(dir, "show", `${wt.branch}:notes.md`)).toBe("left over");
  });

  it("takes a detached HEAD's commits too", async () => {
    const wt = await worker();
    git(wt.path, "checkout", "-q", "--detach");
    const work = wt.commit("app.js", "console.log(1)\n");
    expect(await adoptOwnBranchWork(wt.path, wt.branch)).toEqual({ ok: true, from: work.slice(0, 12) });
    expect(git(dir, "rev-parse", wt.branch)).toBe(work);
    expect(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt.branch);
  });

  it("finds the run's branch when it committed there and checked its given branch out again", async () => {
    const wt = await worker();
    git(wt.path, "checkout", "-q", "-b", "fix/arrow-back");
    const work = wt.commit("app.js", "console.log(1)\n");
    git(wt.path, "checkout", "-q", wt.branch);
    expect(await adoptOwnBranchWork(wt.path, wt.branch)).toEqual({ ok: true, from: "fix/arrow-back" });
    expect(git(dir, "rev-parse", wt.branch)).toBe(work);
    expect(fs.readFileSync(path.join(wt.path, "app.js"), "utf8")).toBe("console.log(1)\n");
  });

  it("merges the run's work into the given branch when it forked it from somewhere else", async () => {
    const wt = await worker();
    const given = wt.commit("given.txt", "on the given branch\n");
    git(wt.path, "checkout", "-q", "-b", "fix/from-master", "master");
    wt.commit("app.js", "console.log(1)\n");
    const r = await adoptOwnBranchWork(wt.path, wt.branch);
    expect(r).toEqual({ ok: true, from: "fix/from-master" });
    expect(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt.branch);
    expect(git(dir, "merge-base", "--is-ancestor", given, wt.branch)).toBe("");
    expect(git(dir, "show", `${wt.branch}:app.js`)).toBe("console.log(1)");
    expect(git(dir, "show", `${wt.branch}:given.txt`)).toBe("on the given branch");
  });

  it("reports a merge git cannot do alone, aborted, and leaves the given branch where it was", async () => {
    const wt = await worker();
    const given = wt.commit("index.html", "<h1>Given</h1>\n");
    git(wt.path, "checkout", "-q", "-b", "fix/clash", "master");
    wt.commit("index.html", "<h1>Clash</h1>\n");
    const r = await adoptOwnBranchWork(wt.path, wt.branch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/Merging fix\/clash into clawbox\/team-abc-t1-1/);
    expect(git(dir, "rev-parse", wt.branch)).toBe(given);
    expect(git(wt.path, "status", "--porcelain")).toBe("");
  });

  it("changes nothing for a run that stayed on its given branch — an amended or reset-away commit stays undone", async () => {
    const wt = await worker();
    wt.commit("app.js", "console.log(1)\n");
    git(wt.path, "commit", "-q", "--amend", "-m", "amended");
    const amended = git(wt.path, "rev-parse", "HEAD");
    wt.commit("tmp.txt", "scratch\n");
    git(wt.path, "reset", "-q", "--hard", "HEAD~1");
    expect(await adoptOwnBranchWork(wt.path, wt.branch)).toEqual({ ok: true, from: null });
    expect(git(dir, "rev-parse", wt.branch)).toBe(amended);
    expect(fs.existsSync(path.join(wt.path, "tmp.txt"))).toBe(false);
  });

  it("never takes a sibling worker's branch, nor the base branch it did not stand on", async () => {
    const mine = await worker("t1");
    const sibling = await addWorkerWorktree(dir, "team-abc", "t2", 1);
    if (!sibling.ok) throw new Error(sibling.detail);
    git(sibling.path, "checkout", "-q", "-b", "fix/sibling");
    fs.writeFileSync(path.join(sibling.path, "theirs.js"), "1\n");
    git(sibling.path, "add", "-A");
    git(sibling.path, "commit", "-q", "-m", "theirs");
    git(dir, "branch", "-f", "master", "fix/sibling");
    const tip = mine.commit("app.js", "console.log(1)\n");
    expect(await adoptOwnBranchWork(mine.path, mine.branch)).toEqual({ ok: true, from: null });
    expect(git(dir, "rev-parse", mine.branch)).toBe(tip);
  });

  it("puts a HEAD left on another branch at the very same commit back on the given branch", async () => {
    const wt = await worker();
    const tip = wt.commit("app.js", "console.log(1)\n");
    git(wt.path, "checkout", "-q", "-b", "fix/no-commit");
    expect(await adoptOwnBranchWork(wt.path, wt.branch)).toEqual({ ok: true, from: null });
    expect(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt.branch);
    expect(git(dir, "rev-parse", wt.branch)).toBe(tip);
  });
});
