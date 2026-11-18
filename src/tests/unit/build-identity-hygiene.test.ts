import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  accountOnlyHome, CAN_LOCK_HOME, handOverOrder, shellFunctionIfPresent, unlockTree,
} from "../helpers/account-only-home";

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

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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
    expect(fn).toContain('rm -f -- "$PROJECT_DIR/.deployed-sha"');
    expect(fn.indexOf(".deployed-sha")).toBeLessThan(fn.lastIndexOf("sync_repo_to_update_target"));
  });
});

/**
 * The orphan sits in the checkout, the service account's: the account removes
 * it, in step 1 and in git_pull alike, and a removal that fails ends neither
 * step. Run under `set -euo pipefail` against a checkout only `as_clawbox` can
 * write to (src/tests/helpers/account-only-home.ts): a root `rm` there fails
 * with EACCES, and a root command on a checkout path is logged. The account is
 * not the suite's user, so the hand-over in step 1 fires; root's `chown` only
 * records.
 */
(CAN_LOCK_HOME ? describe : describe.skip)(".deployed-sha is removed as the service account", () => {
  function runStep(step: "step_bootstrap_updater" | "step_git_pull", prelude = "") {
    const aux = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-hygiene-aux-"));
    try {
      fs.writeFileSync(path.join(repo, ".deployed-sha"), "1b21187\n");
      const account = accountOnlyHome(repo, aux);
      const script = [
        "set -euo pipefail",
        `PROJECT_DIR=${JSON.stringify(repo)}`,
        'IFACE_ENV="$PROJECT_DIR/data/network.env"',
        "CLAWBOX_USER=clawbox",
        account.shell,
        `chown() { [ -n "\${AS_SERVICE_USER:-}" ] || printf 'chown %s\\n' "$*" >> ${JSON.stringify(path.join(aux, "stubs"))}; }`,
        'resolve_update_branch() { UPDATE_TARGET_LOCAL=beta; UPDATE_TARGET_UPSTREAM=origin/beta; UPDATE_TARGET_UNRESOLVED=0; }',
        "refuse_unresolved_update_target() { exit 1; }",
        `sync_repo_to_update_target() { echo "synced $*"; }`,
        "handover_legacy_updater() { :; }",
        "persist_update_branch_pin() { :; }",
        prelude,
        shellFunctionIfPresent(INSTALL_SH, "hand_over_checkout"),
        account.recordHandOvers,
        shellFunctionIfPresent(INSTALL_SH, "step_fix_git_perms"),
        shellFunctionIfPresent(INSTALL_SH, step),
        "__ao_lock",
        step,
      ].join("\n");
      const r = spawnSync("bash", ["-c", script], { encoding: "utf-8" });
      unlockTree(repo);
      return { status: r.status, out: `${r.stdout}${r.stderr}`, rootInHome: account.rootInHome(), sequence: account.sequence() };
    } finally {
      unlockTree(repo);
      fs.rmSync(aux, { recursive: true, force: true });
    }
  }
  const failRm = 'eval "$(declare -f as_clawbox | sed \'1s/^as_clawbox /__real_as_clawbox /\')"\n'
    + 'as_clawbox() { [ "$1" = rm ] && return 1; __real_as_clawbox "$@"; }';

  it.each(["step_bootstrap_updater", "step_git_pull"] as const)("%s removes it as the account, then syncs", (step) => {
    const r = runStep(step);
    expect(r.status, r.out).toBe(0);
    expect(fs.existsSync(path.join(repo, ".deployed-sha"))).toBe(false);
    expect(r.out).toContain("synced beta origin/beta");
    expect(r.rootInHome).toEqual([]);
    expect(r.sequence.filter((l) => !l.startsWith("hand-over "))).toEqual([`rm -f -- ${path.join(repo, ".deployed-sha")}`]);
  });

  it("step_bootstrap_updater hands the checkout over first, through step_fix_git_perms", () => {
    const r = runStep("step_bootstrap_updater");
    const { handOver, firstWrite } = handOverOrder(r.sequence, "hand_over_checkout .git");
    expect(handOver, r.sequence.join(" | ")).toBeGreaterThanOrEqual(0);
    expect(handOver).toBeLessThan(firstWrite);
  });

  it.each(["step_bootstrap_updater", "step_git_pull"] as const)("%s still syncs when the removal fails", (step) => {
    const r = runStep(step, failRm);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("synced beta origin/beta");
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
