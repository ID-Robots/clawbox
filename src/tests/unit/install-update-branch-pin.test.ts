import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { testEnv } from "@/tests/helpers/env";
import {
  accountOnlyHome, CAN_LOCK_HOME, handOverOrder, shellFunctionIfPresent, unlockTree,
} from "../helpers/account-only-home";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// A device is flashed with CLAWBOX_VERSION=<branch>, which flash.sh hands to
// install.sh as CLAWBOX_BRANCH. What the device later UPDATES to is decided
// separately, by resolve_update_branch (install.sh) and resolveUpdateBranch
// (src/lib/updater.ts): the `.update-branch` pin, else the current branch if it
// tracks a remote, else `main`.
//
// install.sh read that pin and never wrote it, so it existed only when a human
// created it — two freshly provisioned devices arrived with none. Rule 2 caught
// those, but a branch's upstream link does not survive a re-clone, so an
// unpinned unit can silently resolve to `main` and update itself onto a branch
// it was never built for. On customer units that reaches the customer before it
// reaches us.
//
// persist_update_branch_pin closes the gap: an explicit CLAWBOX_BRANCH is
// recorded on disk, owned by the app user so the Settings UI can still rewrite
// it, and an installer run WITHOUT the env var leaves an existing pin alone.
//
// A device carrying NO pin is the remaining hole, and the branch it is checked
// out on is the only record of what it was built from — a record
// sync_repo_to_update_target destroys moments later. So an unpinned device
// adopts that branch, under the narrow conditions adoptable_checkout_branch
// enforces. A device on `main` is unaffected either way: rule 2 returns main
// when the current branch is main, and rule 3's fallback IS main, so main-built
// units resolve to main through every path with or without a pin.

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");
const GITIGNORE = fs.readFileSync(path.join(REPO, ".gitignore"), "utf-8");
const RESET_ROUTE = fs.readFileSync(
  path.join(REPO, "src/app/setup-api/setup/reset/route.ts"),
  "utf-8",
);
const UPDATER_TS = fs.readFileSync(path.join(REPO, "src/lib/updater.ts"), "utf-8");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const HAS_GIT = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;
const dg = CAN_RUN && HAS_GIT ? describe : describe.skip;

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${INSTALL_SH.slice(start, end)}\n}`;
}

// Sourced verbatim so the tests exercise the code that ships, not a copy.
const PERSIST_FN = extractShellFunction("persist_update_branch_pin");
const IS_SAFE_REF_FN = extractShellFunction("is_safe_git_ref");
const ADOPT_FN = extractShellFunction("adoptable_checkout_branch");

let tmp: string;
let projectDir: string;
let pinFile: string;
let chownLog: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-pin-"));
  projectDir = path.join(tmp, "clawbox");
  fs.mkdirSync(projectDir);
  pinFile = path.join(projectDir, ".update-branch");
  chownLog = path.join(tmp, "chown-calls");
  fs.writeFileSync(chownLog, "");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Run persist_update_branch_pin against a throwaway project dir.
 *
 * `chown` is stubbed — the test host is not root and has no `clawbox` user —
 * but every call is logged so the ownership contract is still observable.
 * `as_clawbox` runs its command as this suite's user and logs it: the pin is
 * written by the account. `chmod` is left REAL so the resulting mode can be
 * read off the filesystem. The account is `clawbox`, not this suite's user,
 * so to the hand-over every entry is a leftover: it hands the checkout back
 * whole; with `user` naming the suite's user nothing is handed over.
 */
function runPersist(env: Record<string, string> = {}, { user = "clawbox", prelude = "" } = {}): {
  status: number;
  stdout: string;
  chowns: string[];
  asClawbox: string[];
} {
  const calls = path.join(tmp, "as-clawbox-calls");
  fs.writeFileSync(calls, "");
  const script = [
    "set -euo pipefail",
    `PROJECT_DIR=${JSON.stringify(projectDir)}`,
    'IFACE_ENV="$PROJECT_DIR/data/network.env"',
    `CLAWBOX_USER=${JSON.stringify(user)}`,
    `chown() { printf '%s\\n' "$*" >> ${JSON.stringify(chownLog)}; }`,
    // One record per call, \x1e-terminated: a `sh -c` program spans lines.
    `as_clawbox() { printf '%s\\036' "$*" >> ${JSON.stringify(calls)}; "$@"; }`,
    prelude,
    shellFunctionIfPresent(INSTALL_SH, "hand_over_checkout"),
    IS_SAFE_REF_FN,
    ADOPT_FN,
    PERSIST_FN,
    "persist_update_branch_pin",
  ].join("\n");

  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    // Deliberately NOT inheriting process.env: a CLAWBOX_BRANCH exported in a
    // developer's shell would rewrite what each case is asking.
    env: testEnv({ PATH: process.env.PATH ?? "", ...env }),
  });
  const lines = (file: string) => fs.readFileSync(file, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean);
  return {
    status: r.status ?? -1,
    stdout: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    chowns: lines(chownLog),
    asClawbox: fs.readFileSync(calls, "utf-8").split("\x1e").filter(Boolean),
  };
}

/** Temp files left next to the pin — on a device these dirty `git status`. */
function strayTempFiles(): string[] {
  return fs
    .readdirSync(projectDir)
    .filter((name) => name.startsWith(".update-branch."));
}

d("persist_update_branch_pin records the branch the device was built with", () => {
  it("writes the pin when the installer is given an explicit branch", () => {
    const r = runPersist({ CLAWBOX_BRANCH: "beta" });

    expect(r.status).toBe(0);
    expect(fs.readFileSync(pinFile, "utf-8")).toBe("beta\n");
    expect(r.stdout).toContain("Pinning update branch to 'beta'");
  });

  it("writes a branch containing slashes verbatim", () => {
    // Feature branches are the common QA case and the one most likely to be
    // mangled by a sloppy write.
    const r = runPersist({ CLAWBOX_BRANCH: "fix/persist-update-branch" });

    expect(r.status).toBe(0);
    expect(fs.readFileSync(pinFile, "utf-8")).toBe("fix/persist-update-branch\n");
  });

  it("writes the pin as the app user, so it is the app user's own, 0644", () => {
    // install.sh runs as root. The web app runs as the clawbox user and
    // rewrites this file itself via /setup-api/system/update-branch, so a
    // root-owned pin turns that POST into an EACCES — the same failure a
    // root-owned data/ produced in the config store. The account writes it,
    // so it is the account's without any chown; on a checkout that is all the
    // account's, nothing changes hands at all.
    const r = runPersist({ CLAWBOX_BRANCH: "beta" }, { user: os.userInfo().username });

    expect(r.status).toBe(0);
    expect(fs.readFileSync(pinFile, "utf-8")).toBe("beta\n");
    expect(r.chowns).toEqual([]);
    expect(r.asClawbox).toHaveLength(1);
    expect(r.asClawbox[0]).toMatch(/^sh -c [\s\S]* sh \S+$/);
    expect(r.asClawbox[0].endsWith(` sh ${pinFile}`)).toBe(true);
    // mktemp makes 0600 whatever the umask; the write sets 0644 itself.
    expect(fs.statSync(pinFile).mode & 0o777).toBe(0o644);
  });

  it("hands a checkout with leftovers back whole before the account writes the pin", () => {
    // The checkout someone cloned as root: its owner is root, so the account
    // could not write beside the pin until the checkout is handed back.
    const r = runPersist({ CLAWBOX_BRANCH: "beta" }, {
      prelude: `stat() { if [ "\${@: -1}" = ${JSON.stringify(projectDir)} ]; then echo root; else command stat "$@"; fi; }`,
    });

    expect(r.status).toBe(0);
    expect(r.chowns).toEqual([`-R clawbox:clawbox ${projectDir}`]);
    expect(fs.readFileSync(pinFile, "utf-8")).toBe("beta\n");
    expect(fs.statSync(pinFile).mode & 0o777).toBe(0o644);
    expect(strayTempFiles()).toEqual([]);
  });

  it("leaves no temp file behind in the working tree", () => {
    // The pin is gitignored; a stranded temp file next to it would show up in
    // `git status` on the device forever.
    runPersist({ CLAWBOX_BRANCH: "beta" });

    expect(strayTempFiles()).toEqual([]);
  });

  it("leaves no temp file behind when the write fails after the temp was made", () => {
    // A rename that fails is the last step of the write: the temp the account
    // made beside the pin goes with the failure.
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "mv"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const r = runPersist({ CLAWBOX_BRANCH: "beta", PATH: `${bin}:${process.env.PATH ?? ""}` });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("WARN: failed to write the update-branch pin");
    expect(fs.existsSync(pinFile)).toBe(false);
    expect(strayTempFiles()).toEqual([]);
  });

  it("warns, and does not fail the install, when the account cannot write at all", () => {
    const r = runPersist({ CLAWBOX_BRANCH: "beta" }, {
      prelude: 'as_clawbox() { [ "$1" = sh ] && return 1; "$@"; }',
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Pinning update branch to 'beta'");
    expect(r.stdout).toContain("WARN: failed to write the update-branch pin");
    expect(fs.existsSync(pinFile)).toBe(false);
    expect(strayTempFiles()).toEqual([]);
  });

  it("never enters a directory left at the pin's name", () => {
    // The rename replaces the pin's directory entry and is told the target is
    // not a directory: a directory there is not written into.
    fs.mkdirSync(pinFile);

    const r = runPersist({ CLAWBOX_BRANCH: "beta" });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("WARN: failed to write the update-branch pin");
    expect(fs.readdirSync(pinFile)).toEqual([]);
    expect(strayTempFiles()).toEqual([]);
  });

  it("does not write through a symlink planted at a guessable temp path", () => {
    // The temp's name is mktemp's, created exclusively beside the pin: a link
    // planted at any fixed name next to it is neither followed nor removed.
    const decoy = path.join(tmp, "decoy");
    fs.writeFileSync(decoy, "untouched\n");
    fs.symlinkSync(decoy, `${pinFile}.tmp`);
    fs.symlinkSync(decoy, `${pinFile}.stage`);

    const r = runPersist({ CLAWBOX_BRANCH: "beta" });

    expect(r.status).toBe(0);
    expect(fs.readFileSync(decoy, "utf-8")).toBe("untouched\n");
    expect(fs.readFileSync(pinFile, "utf-8")).toBe("beta\n");
    expect(fs.lstatSync(pinFile).isSymbolicLink()).toBe(false);
    expect(r.chowns).toEqual([`-R clawbox:clawbox ${projectDir}`]);
    expect(strayTempFiles().sort()).toEqual([".update-branch.stage", ".update-branch.tmp"]);
  });

  it("refuses to write through a symlink left in the pin's place", () => {
    // The project dir belongs to the app user; install.sh runs as root. A
    // symlink planted here would redirect the write, the chown and the chmod
    // onto its target. `[ -f ]` alone follows it, so the check has to be -L.
    const decoy = path.join(tmp, "decoy");
    fs.writeFileSync(decoy, "untouched\n");
    fs.symlinkSync(decoy, pinFile);

    const r = runPersist({ CLAWBOX_BRANCH: "beta" });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("is a symlink");
    expect(fs.readFileSync(decoy, "utf-8")).toBe("untouched\n");
    expect(r.chowns).toEqual([]);
    expect(fs.lstatSync(pinFile).isSymbolicLink()).toBe(true);
  });

  it("repairs ownership of a pin that already names the right branch", () => {
    // A hand-written `sudo sh -c 'echo beta > .update-branch'` leaves a
    // root-owned file with the correct contents. Re-asserting owner and mode on
    // the no-write path is what makes the installer able to heal that.
    fs.writeFileSync(pinFile, "beta\n");
    fs.chmodSync(pinFile, 0o600);

    const r = runPersist({ CLAWBOX_BRANCH: "beta" });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already pinned to 'beta'");
    // Handed back with the checkout whole, never by its name; the mode is the
    // account's to set on its own file.
    expect(r.chowns).toEqual([`-R clawbox:clawbox ${projectDir}`]);
    expect(r.asClawbox).toEqual([`chmod 644 -- ${pinFile}`]);
    expect(fs.statSync(pinFile).mode & 0o777).toBe(0o644);
  });

  it("overwrites a stale pin that names a different branch", () => {
    // Documented precedence: CLAWBOX_BRANCH > .update-branch > current > main.
    // The repo has just been hard-reset onto CLAWBOX_BRANCH, so a pin still
    // naming the old branch would make the next unattended update pull the
    // device straight back off the branch it was built with.
    fs.writeFileSync(pinFile, "main\n");

    const r = runPersist({ CLAWBOX_BRANCH: "beta" });

    expect(r.status).toBe(0);
    expect(fs.readFileSync(pinFile, "utf-8")).toBe("beta\n");
    // Repinning a device is not a silent act.
    expect(r.stdout).toContain("Re-pinning update branch 'main' -> 'beta'");
  });

  it("does not clobber an existing pin when no branch is given", () => {
    // The other direction: an operator re-running the installer bare, and every
    // updater-triggered `install.sh --step`, must leave the device where it is.
    fs.writeFileSync(pinFile, "beta\n");

    const r = runPersist();

    expect(r.status).toBe(0);
    expect(fs.readFileSync(pinFile, "utf-8")).toBe("beta\n");
    // Contents untouched, but the pin is NOT left as found: see below.
  });

  it("repairs an unreadable pin even with no branch given", () => {
    // A pin the app user cannot read is worse than no pin. The updater runs as
    // the app user, so rule 1 is swallowed and it resolves `main`, while
    // install.sh — running as root — still reads the pin and disagrees. The
    // device then updates to a branch its own pin denies.
    //
    // The repair therefore cannot sit behind an explicit CLAWBOX_BRANCH: the
    // run that has to heal this is precisely the bare one.
    fs.writeFileSync(pinFile, "beta\n");
    fs.chmodSync(pinFile, 0o600);

    const r = runPersist();

    expect(r.status).toBe(0);
    expect(fs.readFileSync(pinFile, "utf-8")).toBe("beta\n");
    expect(r.chowns).toEqual([`-R clawbox:clawbox ${projectDir}`]);
    expect(fs.statSync(pinFile).mode & 0o777).toBe(0o644);
  });

  it("warns, and does not fail the install, when the pin's mode cannot be reset", () => {
    fs.writeFileSync(pinFile, "beta\n");

    const r = runPersist({}, { prelude: 'as_clawbox() { [ "$1" = chmod ] && return 1; "$@"; }' });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("WARN: could not reset the update-branch pin's mode");
    expect(fs.readFileSync(pinFile, "utf-8")).toBe("beta\n");
  });

  it("does not invent a pin when no branch is given", () => {
    const r = runPersist();

    expect(r.status).toBe(0);
    expect(fs.existsSync(pinFile)).toBe(false);
  });

  it("does not delete an existing pin when no branch is given", () => {
    fs.writeFileSync(pinFile, "beta\n");
    runPersist();
    expect(fs.existsSync(pinFile)).toBe(true);
  });

  it("refuses to write a value that is not a valid git ref", () => {
    // The pin is interpolated into `origin/<ref>` by both resolvers. Writing
    // junk here would only move the failure to update time.
    fs.writeFileSync(pinFile, "beta\n");

    const r = runPersist({ CLAWBOX_BRANCH: "beta; rm -rf /" });

    expect(r.status).toBe(0);
    expect(fs.readFileSync(pinFile, "utf-8")).toBe("beta\n");
    expect(r.stdout).toContain("not a valid git ref");
  });

  it("survives a missing project dir instead of failing the install", () => {
    fs.rmSync(projectDir, { recursive: true, force: true });

    const r = runPersist({ CLAWBOX_BRANCH: "beta" });

    // `set -euo pipefail` is active: a non-zero return here aborts the step.
    expect(r.status).toBe(0);
  });
});

/**
 * The checkout only `as_clawbox` can write to (src/tests/helpers/account-only-
 * home.ts): a `mkdir`, `>` or `mv` root's own shell makes there fails with
 * EACCES, and a root `chmod` on a checkout path is logged. The account is not
 * the suite's user, so the hand-over fires; root's `chown` only records.
 */
(CAN_RUN && CAN_LOCK_HOME ? describe : describe.skip)("persist_update_branch_pin writes as the service account", () => {
  function runLocked(env: Record<string, string>) {
    const aux = path.join(tmp, "aux");
    fs.mkdirSync(aux, { recursive: true });
    const account = accountOnlyHome(projectDir, aux);
    const script = [
      "set -euo pipefail",
      `PROJECT_DIR=${JSON.stringify(projectDir)}`,
      'IFACE_ENV="$PROJECT_DIR/data/network.env"',
      "CLAWBOX_USER=clawbox",
      account.shell,
      `chown() { [ -n "\${AS_SERVICE_USER:-}" ] || printf '%s\\n' "$*" >> ${JSON.stringify(chownLog)}; }`,
      shellFunctionIfPresent(INSTALL_SH, "hand_over_checkout"),
      account.recordHandOvers,
      IS_SAFE_REF_FN,
      ADOPT_FN,
      PERSIST_FN,
      "__ao_lock",
      "persist_update_branch_pin",
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", env: testEnv({ PATH: process.env.PATH ?? "", ...env }) });
    unlockTree(projectDir);
    return {
      status: r.status ?? -1,
      out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
      rootInHome: account.rootInHome(),
      sequence: account.sequence(),
      chowns: fs.readFileSync(chownLog, "utf-8").split("\n").filter(Boolean),
    };
  }

  it("writes the pin as the account, after handing the checkout back", () => {
    const r = runLocked({ CLAWBOX_BRANCH: "fix/persist-update-branch" });

    expect(r.status, r.out).toBe(0);
    expect(r.out).toBe("  Pinning update branch to 'fix/persist-update-branch' (explicit CLAWBOX_BRANCH)\n");
    expect(fs.readFileSync(pinFile, "utf-8")).toBe("fix/persist-update-branch\n");
    expect(fs.statSync(pinFile).mode & 0o777).toBe(0o644);
    expect(strayTempFiles()).toEqual([]);
    expect(r.rootInHome).toEqual([]);
    expect(r.chowns).toEqual([`-R clawbox:clawbox ${projectDir}`]);
    const { handOver, firstWrite } = handOverOrder(r.sequence, "hand_over_checkout .update-branch");
    expect(handOver, r.sequence.join(" | ")).toBeGreaterThanOrEqual(0);
    expect(handOver).toBeLessThan(firstWrite);
  });

  it("re-asserts the mode of an existing pin as the account", () => {
    fs.writeFileSync(pinFile, "beta\n");
    fs.chmodSync(pinFile, 0o600);

    const r = runLocked({ CLAWBOX_BRANCH: "beta" });

    expect(r.status, r.out).toBe(0);
    expect(r.out).toBe("  Update branch already pinned to 'beta'\n");
    expect(fs.readFileSync(pinFile, "utf-8")).toBe("beta\n");
    expect(fs.statSync(pinFile).mode & 0o777).toBe(0o644);
    expect(r.rootInHome).toEqual([]);
    const { handOver, firstWrite } = handOverOrder(r.sequence, "hand_over_checkout .update-branch");
    expect(handOver, r.sequence.join(" | ")).toBeGreaterThanOrEqual(0);
    expect(handOver).toBeLessThan(firstWrite);
  });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

/**
 * Make `projectDir` a clone of a throwaway origin that carries `main` and
 * `beta`, checked out on `branch`. A real clone, not a fixture: what
 * adoptable_checkout_branch inspects is remote-tracking refs and HEAD, and a
 * hand-built .git would let the test pass while the device failed.
 */
function makeRepo(branch: string): void {
  const seed = path.join(tmp, "seed");
  const origin = path.join(tmp, "origin.git");
  fs.mkdirSync(seed);
  git(seed, "init", "--quiet");
  // Not `init -b main`: that flag postdates git 2.28 and this has to run on
  // whatever the CI image ships.
  git(seed, "symbolic-ref", "HEAD", "refs/heads/main");
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "test");
  fs.writeFileSync(path.join(seed, "f"), "x\n");
  git(seed, "add", "f");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "branch", "beta");
  git(tmp, "clone", "--quiet", "--bare", seed, origin);
  fs.rmSync(projectDir, { recursive: true, force: true });
  git(tmp, "clone", "--quiet", origin, projectDir);
  if (branch !== "main") git(projectDir, "checkout", "--quiet", branch);
}

dg("an unpinned device adopts the branch it is checked out on", () => {
  it("records the checked-out branch", () => {
    makeRepo("beta");

    const r = runPersist();

    expect(r.status).toBe(0);
    expect(fs.readFileSync(pinFile, "utf-8")).toBe("beta\n");
    expect(r.stdout).toContain("Pinning update branch to 'beta'");
    // Adoption is not a silent act either — the log says where the value came
    // from, so an operator can tell it apart from a flash-time choice.
    expect(r.stdout).toContain("the branch this checkout is on");
  });

  it("records a branch whose upstream link is gone — the case rule 2 misses", () => {
    // This is the whole bug. `git clone` sets the upstream link; a re-clone or
    // a hand-rebuilt checkout does not, and rule 2 requires it. Measured on a
    // device: an unpinned box on beta with no upstream resolves `main` in both
    // resolvers, even though install.sh's own bootstrap block reset it to
    // origin/beta minutes earlier in the same run.
    makeRepo("beta");
    git(projectDir, "branch", "--unset-upstream", "beta");

    const r = runPersist();

    expect(r.status).toBe(0);
    expect(fs.readFileSync(pinFile, "utf-8")).toBe("beta\n");
  });

  it("does not adopt main", () => {
    // Rule 2 returns main when the current branch is main, and rule 3's
    // fallback IS main, so a main device already resolves to main through every
    // path. Writing the pin anyway would gain nothing and would freeze a box an
    // operator later moves by hand.
    makeRepo("main");

    const r = runPersist();

    expect(r.status).toBe(0);
    expect(fs.existsSync(pinFile)).toBe(false);
  });

  it("does not adopt a detached HEAD", () => {
    // Deliberately NOT closed: a detached HEAD has no branch name to record.
    // Inferring one from the commit is a guess — on the real repo main and beta
    // sit on the same commit, so `--points-at HEAD` is ambiguous exactly when
    // it would matter. Such a device still falls through to main; the fix is
    // for the flasher to pass CLAWBOX_BRANCH.
    makeRepo("beta");
    git(projectDir, "checkout", "--quiet", "--detach", "HEAD");

    const r = runPersist();

    expect(r.status).toBe(0);
    expect(fs.existsSync(pinFile)).toBe(false);
  });

  it("does not adopt a branch origin does not carry", () => {
    // Without this guard a pin would be written for a branch that cannot be
    // fetched, turning today's silent fallback to main into a hard failure at
    // `reset --hard origin/<branch>` on every future update.
    makeRepo("beta");
    git(projectDir, "checkout", "--quiet", "-b", "local-only");

    const r = runPersist();

    expect(r.status).toBe(0);
    expect(fs.existsSync(pinFile)).toBe(false);
  });

  it("leaves an existing pin alone rather than adopting over it", () => {
    // An existing pin is somebody's explicit choice — the Settings UI, an
    // earlier flash, an operator. Adoption only fills a vacuum.
    makeRepo("beta");
    fs.writeFileSync(pinFile, "main\n");

    const r = runPersist();

    expect(r.status).toBe(0);
    expect(fs.readFileSync(pinFile, "utf-8")).toBe("main\n");
  });

  it("still lets an explicit branch win over the checkout", () => {
    makeRepo("beta");

    const r = runPersist({ CLAWBOX_BRANCH: "fix/qa-build" });

    expect(fs.readFileSync(pinFile, "utf-8")).toBe("fix/qa-build\n");
    expect(r.stdout).toContain("explicit CLAWBOX_BRANCH");
  });
});

describe("the pin is wired into the install", () => {
  it("step_git_pull persists the pin", () => {
    // Without this call site the function is dead code. git_pull is the step
    // that puts the repo on a branch, and it runs early enough that a later
    // failed step still leaves a correctly pinned device.
    expect(extractShellFunction("step_git_pull")).toContain("persist_update_branch_pin");
  });

  it("step_git_pull pins BEFORE it syncs", () => {
    // Order is the whole of the adoption fix. sync_repo_to_update_target checks
    // out and hard-resets, so the checked-out branch — the only record of what
    // an unpinned device was built from — is gone once it returns. Pinning
    // first also feeds resolve_update_branch's rule 1 on this same run, so the
    // branch the device keeps is the branch this run installs.
    // Comment lines are stripped first: the comment explaining the ordering
    // names both functions, so matching raw text would assert on prose.
    const step = extractShellFunction("step_git_pull")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    const pinAt = step.indexOf("persist_update_branch_pin");
    const resolveAt = step.indexOf("resolve_update_branch");
    const syncAt = step.indexOf("sync_repo_to_update_target");

    expect(pinAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(pinAt);
    expect(syncAt).toBeGreaterThan(pinAt);
  });

  it("git_pull is dispatchable, so the pin can be repaired without a full install", () => {
    const dispatch = INSTALL_SH.slice(
      INSTALL_SH.indexOf("DISPATCH_STEPS=("),
      INSTALL_SH.indexOf(")", INSTALL_SH.indexOf("DISPATCH_STEPS=(")),
    );
    expect(dispatch).toContain("git_pull");
  });

  it("the pin never dirties the git tree", () => {
    // install.sh writes this file into the repo working tree. If it were
    // tracked, sync_repo_to_update_target's `git reset --hard` would fight it
    // and `git status` would be permanently dirty on every device. The temp
    // file the write is staged through needs the same treatment: it is renamed
    // into place immediately, but a run that dies between the two would
    // otherwise leave the device dirty forever.
    const lines = GITIGNORE.split("\n").map((l) => l.trim());
    expect(lines).toContain(".update-branch");
    expect(lines).toContain(".update-branch.*");
  });
});

describe("the pin outlives the things updater.ts says it outlives", () => {
  // resolveUpdateBranch's docstring claims rule 1 "survives factory reset +
  // git reset". Both halves are load-bearing for a shipped unit, and neither is
  // enforced by anything else.

  it("factory reset never targets the pin", () => {
    expect(RESET_ROUTE).not.toContain(".update-branch");
  });

  it("factory reset wipes data/, not the project root that holds the pin", () => {
    // DATA_DIR is CONFIG_ROOT + "/data"; the pin sits in CONFIG_ROOT itself.
    // A reset that ever wiped the project root instead would silently unpin
    // every device it touched.
    expect(RESET_ROUTE).toContain("removeDirectoryContents(OPENCLAW_DIR)");
    expect(RESET_ROUTE).toContain("fs.readdir(DATA_DIR)");
    expect(RESET_ROUTE).not.toMatch(/readdir\(\s*PROJECT_DIR/);
    expect(RESET_ROUTE).not.toMatch(/removeDirectoryContents\(\s*PROJECT_DIR/);
  });

  it("the home-dir wipe list does not reach into the project dir", () => {
    // HOME_REMOVE_PATHS and HOME_CONTENT_WIPE_DIRS are joined onto HOME_DIR,
    // and the project dir is HOME_DIR/clawbox — one entry of "clawbox" here
    // would take the pin (and the checkout) with it.
    const listBlock = RESET_ROUTE.slice(
      RESET_ROUTE.indexOf("const HOME_REMOVE_PATHS"),
      RESET_ROUTE.indexOf("async function wipeHomeUserState"),
    );
    expect(listBlock.length).toBeGreaterThan(0);
    expect(listBlock).not.toMatch(/["']clawbox\/?["']/);
  });

  it("the pin file is the same path on both sides of the read", () => {
    // install.sh writes $PROJECT_DIR/.update-branch; updater.ts and the
    // Settings route read PROJECT_DIR + ".update-branch". A drift between them
    // would leave a device pinned in a file nothing consults.
    expect(UPDATER_TS).toContain('const PROJECT_DIR = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox"');
    expect(UPDATER_TS).toContain('path.join(PROJECT_DIR, ".update-branch")');
    expect(INSTALL_SH).toContain('PROJECT_DIR="/home/clawbox/clawbox"');
    expect(PERSIST_FN).toContain('"$PROJECT_DIR/.update-branch"');
  });
});
