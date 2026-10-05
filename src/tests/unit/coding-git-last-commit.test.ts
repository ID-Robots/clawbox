/**
 * The projects listing's newest commit (`lastCommit` in src/lib/coding-git.ts).
 *
 * The Coding Agent window reads the projects listing every 5 s while a run is
 * live or a pull request waits on its checks, and the listing asked `git log`
 * once per project each time — a process per project per poll, on the box
 * whose CPU the run being watched needs. A commit never changes once made, so
 * the answer is kept under the commit id git printed and handed back while
 * HEAD still names it. What these pin is that it is ALWAYS the answer git
 * would give: every way HEAD can move asks git again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Real git, real repositories: vitest's 5 s default is not enough on a loaded
// CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const runChild = vi.hoisted(() => vi.fn());
vi.mock("@/lib/child-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/child-run")>();
  return { ...actual, runChild };
});

type Lib = typeof import("@/lib/coding-git");
let lib: Lib;
let root: string;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf-8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", HOME: root },
  }).trim();
}

function commit(dir: string, subject: string): void {
  fs.writeFileSync(path.join(dir, "file.txt"), `${subject}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", subject);
}

function makeRepo(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  return dir;
}

/** How many `git log` processes the library has started. */
function gitLogs(): number {
  return runChild.mock.calls.filter(([cmd, args]) => cmd === "git" && (args as string[]).includes("log")).length;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-git-last-"));
  vi.resetModules();
  // The real runner, counted: every git process still runs.
  const actual = await vi.importActual<typeof import("@/lib/child-run")>("@/lib/child-run");
  runChild.mockReset();
  runChild.mockImplementation(actual.runChild);
  lib = await import("@/lib/coding-git");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("lastCommit", () => {
  it("asks git once, then answers from the commit HEAD still names", async () => {
    const dir = makeRepo("app");
    commit(dir, "first");
    const first = await lib.lastCommit(dir);
    expect(first?.subject).toBe("first");
    expect(gitLogs()).toBe(1);
    expect(await lib.lastCommit(dir)).toEqual(first);
    expect(await lib.lastCommit(dir)).toEqual(first);
    expect(gitLogs()).toBe(1);
  });

  it("asks again for a new commit, a reset back, a checkout and a detached HEAD", async () => {
    const dir = makeRepo("app");
    commit(dir, "first");
    const base = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
    expect((await lib.lastCommit(dir))?.subject).toBe("first");

    commit(dir, "second");
    expect((await lib.lastCommit(dir))?.subject).toBe("second");

    // Back to a commit seen before — the answer is that commit's, not the
    // newest one asked about.
    git(dir, "reset", "--quiet", "--hard", "HEAD~1");
    expect((await lib.lastCommit(dir))?.subject).toBe("first");

    git(dir, "checkout", "--quiet", "-b", "feature");
    commit(dir, "on a branch");
    expect((await lib.lastCommit(dir))?.subject).toBe("on a branch");
    git(dir, "checkout", "--quiet", base);
    expect((await lib.lastCommit(dir))?.subject).toBe("first");

    git(dir, "checkout", "--quiet", "--detach", "feature");
    expect((await lib.lastCommit(dir))?.subject).toBe("on a branch");
  });

  it("reads a branch packed into packed-refs, and follows it when it moves", async () => {
    const dir = makeRepo("packed");
    commit(dir, "first");
    git(dir, "pack-refs", "--all");
    const branch = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
    expect(fs.existsSync(path.join(dir, ".git", "refs", "heads", branch))).toBe(false);
    expect((await lib.lastCommit(dir))?.subject).toBe("first");
    const asked = gitLogs();
    expect((await lib.lastCommit(dir))?.subject).toBe("first");
    expect(gitLogs()).toBe(asked);

    commit(dir, "second");
    expect((await lib.lastCommit(dir))?.subject).toBe("second");
  });

  it("answers null for a repository with no commit yet, every time", async () => {
    const dir = makeRepo("fresh");
    expect(await lib.lastCommit(dir)).toBeNull();
    expect(await lib.lastCommit(dir)).toBeNull();
    commit(dir, "first");
    expect((await lib.lastCommit(dir))?.subject).toBe("first");
  });

  it("asks git every time where HEAD is not read plainly — a linked worktree", async () => {
    const dir = makeRepo("main");
    commit(dir, "first");
    const tree = path.join(root, "tree");
    git(dir, "worktree", "add", "--quiet", "-b", "side", tree);
    expect(fs.statSync(path.join(tree, ".git")).isFile()).toBe(true);
    expect((await lib.lastCommit(tree))?.subject).toBe("first");
    expect((await lib.lastCommit(tree))?.subject).toBe("first");
    expect(gitLogs()).toBe(2);
  });

  it("never reads a ref named outside .git", async () => {
    const dir = makeRepo("odd");
    commit(dir, "first");
    const id = git(dir, "rev-parse", "HEAD");
    // A planted HEAD whose ref climbs out of the repository, to a file that
    // holds a commit id: answered by git (which refuses it), never by the file.
    fs.writeFileSync(path.join(root, "outside"), `${id}\n`);
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/../../../outside\n");
    await lib.lastCommit(dir);
    await lib.lastCommit(dir);
    expect(gitLogs()).toBe(2);
  });
});
