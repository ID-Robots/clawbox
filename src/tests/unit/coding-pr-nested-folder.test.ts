/**
 * @vitest-environment node
 *
 * A project folder INSIDE a repository that is not its own — ~/Projects with
 * a .git of its own, packages/app in a monorepo — is a fact startRunBranch
 * names, not a repository it branches. Before this, `checkout -b` ran in the
 * PARENT (moving the owner's branch under them on every run), the settle then
 * refused the commit as `foreign_repo`, and the run ended gave_up over a pull
 * request that was never possible: 39 of 44 live runs on the owner's box.
 * Real git, a parent repository with a nested project folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { startRunBranch } from "@/lib/coding-pr";

// Starts a real process (git): vitest's 5 s test and 10 s hook defaults are
// not enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();

let parent: string;
let nested: string;

beforeEach(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), "coding-pr-nested-"));
  git(parent, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(parent, ".gitignore"), "node_modules\n");
  git(parent, "add", "-A");
  git(parent, "commit", "-q", "-m", "first");
  nested = path.join(parent, "quake2");
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, "README.md"), "# quake2\n");
});

afterEach(() => {
  fs.rmSync(parent, { recursive: true, force: true });
});

describe("startRunBranch on a folder inside another repository", () => {
  it("answers not_repository_root with the enclosing root and leaves the parent untouched", async () => {
    const before = git(parent, "rev-parse", "--abbrev-ref", "HEAD");
    const result = await startRunBranch({ directory: nested, runId: "run-abcd1234", protectedRoot: path.join(parent, "elsewhere") });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("not_repository_root");
    if (result.reason !== "not_repository_root") throw new Error("unreachable");
    expect(fs.realpathSync(result.root)).toBe(fs.realpathSync(parent));
    expect(result.detail).toMatch(/part of the repository at /);
    expect(result.detail).not.toMatch(/fatal/);
    // The parent repository was NOT branched: same branch checked out, no run branch anywhere.
    expect(git(parent, "rev-parse", "--abbrev-ref", "HEAD")).toBe(before);
    expect(git(parent, "branch", "--list", "clawbox/*")).toBe("");
  });

  it("still branches a repository of its own, nested or not", async () => {
    // The nested folder IS a repository: the parent's enclosing it changes nothing.
    git(nested, "init", "-q", "-b", "main");
    git(nested, "add", "-A");
    git(nested, "commit", "-q", "-m", "first");
    const result = await startRunBranch({ directory: nested, runId: "run-abcd1234", protectedRoot: path.join(parent, "elsewhere") });
    expect(result).toMatchObject({ ok: true, branch: "clawbox/run-abcd1234", base: "main" });
    expect(git(nested, "rev-parse", "--abbrev-ref", "HEAD")).toBe("clawbox/run-abcd1234");
    expect(git(parent, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });
});
