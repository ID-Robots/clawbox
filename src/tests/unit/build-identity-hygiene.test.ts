import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * TASK-447 round 2, defects 3, 4 and 5 — the three ways this feature reported
 * the wrong thing about a real box (hwtest-round1, 2026-08-24):
 *
 *  3. the drift WARN ran in the update's step 7, six steps after step 1
 *     hard-resets the tree, so it named the post-sync commit and never saw the
 *     drift the customer actually had;
 *  4. `build-info.json` stamped `dirty: true` on builds from provably clean
 *     trees, because it counted untracked files;
 *  5. `.deployed-sha`, an orphan of the pre-3.9 deploy method that nothing in
 *     this repository reads, was the untracked file doing it — and it forced a
 *     drift banner onto a box whose build, checkout and BUILD_ID all agreed.
 *
 * 4 and 5 are the same incident from both ends, so they are tested together.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");
const UPDATER_TS = fs.readFileSync(path.join(REPO_ROOT, "src/lib/updater.ts"), "utf-8");
const INSTALL_SH = fs.readFileSync(path.join(REPO_ROOT, "install.sh"), "utf-8");
const GITIGNORE = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf-8");
const STAMPER = path.join(REPO_ROOT, "scripts/write-build-info.mjs");

const HAS_GIT = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const d = HAS_GIT ? describe : describe.skip;

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

function seedRepo(): void {
  execFileSync("git", ["init", "-q", "-b", "beta", repo]);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  // The shipped ignore list, verbatim — the fix for defect 5 lives in it.
  fs.writeFileSync(path.join(repo, ".gitignore"), GITIGNORE);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "one");
  git("update-ref", "refs/remotes/origin/beta", git("rev-parse", "HEAD"));
}

function stamp(): { dirty: boolean | null; untracked: number | null; branch: string | null } {
  const run = spawnSync("node", [STAMPER], {
    cwd: repo,
    env: { ...process.env, CLAWBOX_ROOT: repo },
    encoding: "utf-8",
  });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(fs.readFileSync(path.join(repo, ".next", "build-info.json"), "utf-8"));
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-hygiene-"));
  seedRepo();
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

d("build-info.json `dirty` describes the tracked files the build came from", () => {
  it("is false on a clean tree", () => {
    expect(stamp()).toMatchObject({ dirty: false, untracked: 0, branch: "beta" });
  });

  it("is false when the only difference is an untracked file, and counts it separately", () => {
    // The exact shape of the incident: a QA operator's stray file in the
    // project root stamped `dirty: true` on two consecutive clean builds.
    fs.writeFileSync(path.join(repo, "operator-note.txt"), "left behind\n");

    expect(stamp()).toMatchObject({ dirty: false, untracked: 1 });
  });

  it("is true when a tracked file was modified — the thing the flag is for", () => {
    fs.writeFileSync(path.join(repo, "README.md"), "edited over ssh\n");

    expect(stamp()).toMatchObject({ dirty: true });
  });

  it("ignores gitignored paths, so a device's own data/ never reads as dirty", () => {
    fs.mkdirSync(path.join(repo, "data"), { recursive: true });
    fs.writeFileSync(path.join(repo, "data", "config.json"), "{}\n");

    expect(stamp()).toMatchObject({ dirty: false, untracked: 0 });
  });
});

d(".deployed-sha — the orphan that faked drift", () => {
  let mod: typeof import("@/lib/updater");

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mod = await import("@/lib/updater");
  });

  it("is not written or read by anything that ships", () => {
    const grep = spawnSync(
      "git",
      ["-C", REPO_ROOT, "grep", "-l", "-e", "deployed-sha", "--", ":!*.gitignore", ":!src/tests/*"],
      { encoding: "utf-8" },
    );
    const files = (grep.stdout || "").split("\n").map((f) => f.trim()).filter(Boolean);
    // The only mentions that ship are the two places that DELETE it and the
    // stamper's comment explaining why it broke `dirty`. Nothing creates it.
    expect(files.sort()).toEqual(["install.sh", "scripts/write-build-info.mjs", "src/lib/updater.ts"]);
    for (const file of files) {
      const body = fs.readFileSync(path.join(REPO_ROOT, file), "utf-8");
      expect(body, `${file} must not WRITE .deployed-sha`).not.toMatch(/>\s*"?\$?\{?[^\n]*\.deployed-sha/);
    }
  });

  it("is ignored by the shipped .gitignore, so it cannot count as a dirty tree", () => {
    fs.writeFileSync(path.join(repo, ".deployed-sha"), "1b21187\n");

    expect(git("status", "--porcelain")).toBe("");
    expect(spawnSync("git", ["-C", REPO_ROOT, "check-ignore", "-q", ".deployed-sha"]).status).toBe(0);
  });

  it("does not raise a drift banner on an otherwise healthy box", async () => {
    fs.writeFileSync(path.join(repo, ".deployed-sha"), "1b21187\n");
    const identity = await import("@/lib/build-identity");

    const { checkout, drift } = await identity.collectBuildIdentity(repo);

    expect(checkout.dirty).toBe(false);
    expect(drift.codes).not.toContain("checkout-dirty");
  });

  it("is deleted by the updater, since `git clean -fd` spares ignored paths", async () => {
    const marker = path.join(repo, ".deployed-sha");
    fs.writeFileSync(marker, "1b21187\n");

    expect(await mod.removeOrphanDeployedSha(repo)).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    // And on a box that never had one it is a silent no-op, not an error.
    expect(await mod.removeOrphanDeployedSha(repo)).toBe(true);
  });

  it("is deleted by install.sh's step 1 as well, before the sync", () => {
    const start = INSTALL_SH.indexOf("step_bootstrap_updater() {");
    const fn = INSTALL_SH.slice(start, INSTALL_SH.indexOf("\n}", start));
    expect(fn).toContain('rm -f "$PROJECT_DIR/.deployed-sha"');
    expect(fn.indexOf(".deployed-sha")).toBeLessThan(fn.lastIndexOf("sync_repo_to_update_target"));
  });
});

d("the drift diagnosis is taken before the update touches the repository", () => {
  let mod: typeof import("@/lib/updater");

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mod = await import("@/lib/updater");
  });

  it("sees drift that step 1's `reset --hard` would erase seconds later", async () => {
    // The customer's state: a tracked file edited over SSH, and a checkout
    // behind the tested commit for its branch.
    fs.writeFileSync(path.join(repo, ".update-branch"), "beta\n");
    fs.writeFileSync(path.join(repo, "README.md"), "two\n");
    git("commit", "-qam", "two");
    git("update-ref", "refs/remotes/origin/beta", git("rev-parse", "HEAD"));
    git("reset", "-q", "--hard", "HEAD~1");
    fs.writeFileSync(path.join(repo, "README.md"), "edited over ssh\n");

    const before = await mod.collectDriftWarnings(repo);
    expect(before.map((w) => w.code).sort()).toEqual(["checkout-behind-pin", "checkout-dirty"]);

    // What install.sh's step 1 (sync_repo_to_update_target) does to the tree,
    // six steps before the WARN used to run.
    git("reset", "-q", "--hard", "HEAD");
    git("checkout", "-q", "beta");
    git("reset", "-q", "--hard", "origin/beta");

    const after = await mod.collectDriftWarnings(repo);
    expect(after.map((w) => w.code)).not.toContain("checkout-dirty");
    expect(after.map((w) => w.code)).not.toContain("checkout-behind-pin");
  });

  it("runUpdate captures the baseline before it runs a single step", () => {
    const body = UPDATER_TS.slice(UPDATER_TS.indexOf("async function runUpdate("));
    const capture = body.indexOf("captureDriftBaseline()");
    const loop = body.indexOf("for (let i = startFrom; i < steps.length; i++)");
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(loop);
    // …and persists it immediately: the run reboots halfway through, and only
    // persisted warnings survive that.
    const fn = UPDATER_TS.slice(
      UPDATER_TS.indexOf("async function captureDriftBaseline()"),
      UPDATER_TS.indexOf("async function captureDriftBaseline()") + 400,
    );
    expect(fn).toContain("collectDriftWarnings()");
    expect(fn).toContain("persistWarnings()");
  });

  it("step 1 really is the step that moves the tree first", () => {
    // If this ever stops being true the ordering above stops mattering, and
    // the comment explaining it goes stale silently.
    const steps = UPDATER_TS.slice(UPDATER_TS.indexOf("const UPDATE_STEPS: UpdateStepDef[] = ["));
    expect(steps.indexOf('id: "bootstrap_updater"')).toBeLessThan(steps.indexOf('id: RESTART_STEP_ID'));
    const bootstrap = INSTALL_SH.slice(
      INSTALL_SH.indexOf("step_bootstrap_updater() {"),
      INSTALL_SH.indexOf("step_git_pull() {"),
    );
    expect(bootstrap).toContain("sync_repo_to_update_target");
  });
});
