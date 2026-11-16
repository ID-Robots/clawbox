import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * TASK-2602: scripts/promote-workstation.sh is the one way the `workstation`
 * branch moves. Run for real against a bare repository standing in for
 * GitHub: what it refuses, that a dry run pushes nothing, and that a push
 * carries a lease on the tip it read.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SCRIPT = path.resolve(__dirname, "../../../scripts/promote-workstation.sh");
const HAS_TOOLS = process.platform !== "win32"
  && spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = HAS_TOOLS ? describe : describe.skip;

let root: string;
let origin: string;
let work: string;
let clone: string;

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function commit(message: string): string {
  fs.writeFileSync(path.join(work, "file.txt"), `${message}\n`);
  git(work, "add", "-A");
  git(work, "commit", "-qm", message);
  return git(work, "rev-parse", "HEAD");
}

function run(...args: string[]): { status: number; out: string } {
  const res = spawnSync("bash", [SCRIPT, ...args], {
    cwd: clone,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { status: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

const remoteTip = (branch: string) =>
  git(origin, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);

let c: { main1: string; beta1: string; beta2: string; beta3: string; side: string };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-promote-"));
  origin = path.join(root, "origin.git");
  work = path.join(root, "work");
  clone = path.join(root, "clone");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "user.name", "Test");
  const main1 = commit("main one");
  git(work, "checkout", "-qb", "beta");
  const beta1 = commit("beta one");
  const beta2 = commit("beta two");
  const beta3 = commit("beta three");
  git(work, "checkout", "-q", "-b", "side", main1);
  const side = commit("never merged");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main", "beta");
  execFileSync("git", ["clone", "-q", origin, clone]);
  c = { main1, beta1, beta2, beta3, side };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

d("scripts/promote-workstation.sh", () => {
  it("is executable and parses", () => {
    expect(fs.statSync(SCRIPT).mode & 0o111).not.toBe(0);
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
  });

  it("a dry run (no --push) says what it would do and pushes nothing", () => {
    const res = run(c.beta2);
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/has no workstation branch yet; this creates it/);
    expect(res.out).toMatch(/Dry run: +nothing was pushed/);
    expect(remoteTip("workstation")).toBe("");
  });

  it("--push creates the branch at the tested commit", () => {
    const res = run(c.beta2, "--push");
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/Promoted: workstation on origin is now/);
    expect(remoteTip("workstation")).toBe(c.beta2);
  });

  it("a later tested commit is a fast-forward and lists what reaches Workstations", () => {
    expect(run(c.beta1, "--push").status).toBe(0);
    const res = run(c.beta3, "--push");
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/fast-forward, 2 commit\(s\) reach Workstations/);
    expect(res.out).toContain("beta three");
    expect(res.out).toContain("beta two");
    expect(remoteTip("workstation")).toBe(c.beta3);
  });

  it("the same commit again changes nothing", () => {
    expect(run(c.beta2, "--push").status).toBe(0);
    const res = run(c.beta2, "--push");
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/already at/);
  });

  it("a commit on main is accepted", () => {
    expect(run(c.main1, "--push").status).toBe(0);
    expect(remoteTip("workstation")).toBe(c.main1);
  });

  it("refuses a branch name or a short sha: only the exact tested commit", () => {
    for (const arg of ["beta", c.beta2.slice(0, 12), `${c.beta2}x`]) {
      const res = run(arg, "--push");
      expect(res.status).toBe(1);
      expect(res.out).toMatch(/not a full 40-character commit sha/);
    }
    expect(remoteTip("workstation")).toBe("");
  });

  it("refuses a commit that is on neither beta nor main", () => {
    // The commit exists on GitHub (on another branch) but not in the shared history.
    git(work, "push", "-q", "origin", "side");
    git(clone, "fetch", "-q", "origin", "side");
    const res = run(c.side, "--push");
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/is on neither beta or main of origin/);
    expect(remoteTip("workstation")).toBe("");
  });

  it("refuses a commit the remote does not carry at all", () => {
    const res = run("0123456789abcdef0123456789abcdef01234567", "--push");
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/is not a commit origin carries on beta or main/);
  });

  it("refuses to move backwards without --rollback, and does with it", () => {
    expect(run(c.beta3, "--push").status).toBe(0);
    const refused = run(c.beta1, "--push");
    expect(refused.status).toBe(1);
    expect(refused.out).toMatch(/not a fast-forward/);
    expect(remoteTip("workstation")).toBe(c.beta3);

    const rolled = run(c.beta1, "--rollback", "--push");
    expect(rolled.status).toBe(0);
    expect(rolled.out).toMatch(/NOT a fast-forward \(--rollback\)/);
    expect(remoteTip("workstation")).toBe(c.beta1);
  });

  it("carries a lease: a branch that moved after it was read is not overwritten", () => {
    expect(run(c.beta1, "--push").status).toBe(0);
    // Another promotion lands between this run's read and its push: simulated
    // with a pre-push hook in the clone that moves the remote branch first.
    const hook = path.join(clone, ".git", "hooks", "pre-push");
    fs.writeFileSync(hook, `#!/usr/bin/env bash\ngit --git-dir='${origin}' update-ref refs/heads/workstation ${c.beta2}\n`);
    fs.chmodSync(hook, 0o755);
    const res = run(c.beta3, "--push");
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/the push was refused/);
    expect(remoteTip("workstation")).toBe(c.beta2);
  });

  it("takes --remote as a URL and writes no ref into the checkout it runs in", () => {
    const before = git(clone, "for-each-ref", "--format=%(refname)");
    const res = run(c.beta2, "--remote", origin, "--push");
    expect(res.status).toBe(0);
    expect(remoteTip("workstation")).toBe(c.beta2);
    expect(git(clone, "for-each-ref", "--format=%(refname)")).toBe(before);
  });

  it("prints its usage on a missing or extra argument", () => {
    expect(run().status).toBe(2);
    expect(run().out).toMatch(/Usage:/);
    expect(run(c.beta1, c.beta2).status).toBe(2);
    expect(run(c.beta1, "--bogus").status).toBe(2);
  });
});
