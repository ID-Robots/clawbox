/**
 * A run's temporary folder written into the files it leaves behind
 * (coding-worktree-heal.ts), against a REAL repository in a temp folder: the
 * README of two failed teams, said in the project's own folder before the
 * branch is merged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { addWorkerWorktree, ensureTeamBranch, mergeWorkerBranch } from "@/lib/coding-team-worktree";
import { HEAL_COMMIT_SUBJECT, healWorktreePaths } from "@/lib/coding-worktree-heal";

// Starts real git processes: vitest's defaults are not enough on a loaded CI
// runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let dir: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } }).trim();

beforeEach(() => {
  // realpath: the worktree's own path is what the run writes, and macOS and
  // some CI runners hand out a temp folder behind a link.
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-heal-")));
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

async function worker(task = "t4"): Promise<{ path: string; branch: string }> {
  const team = await ensureTeamBranch(dir, "team-abc");
  expect(team.ok).toBe(true);
  const wt = await addWorkerWorktree(dir, "team-abc", task, 1);
  if (!wt.ok) throw new Error("no worktree");
  return { path: wt.path, branch: wt.branch };
}

describe("healWorktreePaths", () => {
  it("says a worker's folder in the project's own, in every file the worker wrote it into, as one commit", async () => {
    const wt = await worker();
    fs.mkdirSync(path.join(wt.path, "mcp"));
    fs.writeFileSync(
      path.join(wt.path, "mcp", "README.md"),
      [`Run it: node ${wt.path}/mcp/server.mjs`, `Register: openclaw mcp set calc '{"command":"node","args":["${wt.path}/mcp/server.mjs"]}'`, `The checkout is ${wt.path}.`, "Relative paths stay: mcp/server.mjs", ""].join("\n"),
    );
    fs.writeFileSync(path.join(wt.path, "config.json"), JSON.stringify({ cwd: wt.path, sibling: `${dir}/.clawbox/worktrees/t3-1/lib/x.ts` }));
    fs.writeFileSync(path.join(wt.path, "notes.txt"), "nothing to see\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-q", "-m", "Coding agent: docs");

    const healed = await healWorktreePaths(wt.path);
    expect(healed).toMatchObject({ ok: true });
    if (!healed?.ok) return;
    expect([...healed.files].sort()).toEqual(["config.json", "mcp/README.md"]);
    expect(healed.commit).toBe(git(wt.path, "rev-parse", "--short", "HEAD"));

    const readme = fs.readFileSync(path.join(wt.path, "mcp", "README.md"), "utf8");
    expect(readme).toContain(`Run it: node ${dir}/mcp/server.mjs`);
    expect(readme).toContain(`"args":["${dir}/mcp/server.mjs"]`);
    expect(readme).toContain(`The checkout is ${dir}.`);
    expect(readme).toContain("Relative paths stay: mcp/server.mjs");
    expect(readme).not.toContain(".clawbox/worktrees");
    // A sibling's worktree in the same file goes with it: it is as dead.
    expect(JSON.parse(fs.readFileSync(path.join(wt.path, "config.json"), "utf8"))).toEqual({ cwd: dir, sibling: `${dir}/lib/x.ts` });

    // One more commit on the worker's branch, in the box's name, only those files.
    expect(git(wt.path, "log", "-1", "--format=%s")).toBe(HEAL_COMMIT_SUBJECT);
    expect(git(wt.path, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["config.json", "mcp/README.md"]);
    expect(git(wt.path, "status", "--porcelain")).toBe("");

    // And it is what the team merges.
    expect(await mergeWorkerBranch(dir, wt.branch, "Coding team team-abc: t4")).toEqual({ ok: true, merged: true });
    expect(fs.readFileSync(path.join(dir, "mcp", "README.md"), "utf8")).not.toContain(".clawbox/worktrees");
  });

  it("commits nothing when no file names the folder, and is done at once a second time", async () => {
    const wt = await worker();
    fs.writeFileSync(path.join(wt.path, "app.js"), "console.log(1)\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-q", "-m", "Coding agent: app");
    const head = git(wt.path, "rev-parse", "HEAD");
    expect(await healWorktreePaths(wt.path)).toEqual({ ok: true, files: [], commit: null });
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(head);

    fs.writeFileSync(path.join(wt.path, "README.md"), `cd ${wt.path}\n`);
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-q", "-m", "Coding agent: readme");
    expect(await healWorktreePaths(wt.path)).toMatchObject({ ok: true, files: ["README.md"] });
    const healedHead = git(wt.path, "rev-parse", "HEAD");
    expect(await healWorktreePaths(wt.path)).toEqual({ ok: true, files: [], commit: null });
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(healedHead);
  });

  it("leaves a binary file alone", async () => {
    const wt = await worker();
    const blob = Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(wt.path), Buffer.from([0, 255])]);
    fs.writeFileSync(path.join(wt.path, "blob.bin"), blob);
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-q", "-m", "Coding agent: files");
    const head = git(wt.path, "rev-parse", "HEAD");
    expect(await healWorktreePaths(wt.path)).toEqual({ ok: true, files: [], commit: null });
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(head);
    expect(fs.readFileSync(path.join(wt.path, "blob.bin")).equals(blob)).toBe(true);
  });

  it("touches only tracked files: what the run left untracked is not its commit to make", async () => {
    const wt = await worker();
    fs.writeFileSync(path.join(wt.path, "scratch.log"), `ran in ${wt.path}\n`);
    expect(await healWorktreePaths(wt.path)).toEqual({ ok: true, files: [], commit: null });
    expect(fs.readFileSync(path.join(wt.path, "scratch.log"), "utf8")).toBe(`ran in ${wt.path}\n`);
  });

  it("answers null for a folder that is not a worktree of a project", async () => {
    fs.writeFileSync(path.join(dir, "README.md"), `cd ${dir}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "readme");
    expect(await healWorktreePaths(dir)).toBeNull();
    expect(git(dir, "log", "-1", "--format=%s")).toBe("readme");
  });
});
