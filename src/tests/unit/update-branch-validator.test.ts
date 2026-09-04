import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { isSafeBranch } from "@/lib/update-branch";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Two validators decide what may sit in `.update-branch`: is_safe_git_ref in
// install.sh (which WRITES the pin) and isSafeBranch in src/lib/update-branch.ts
// (which the updater and the Settings route READ it with).
//
// A disagreement between them is not a validation error, it is branch drift.
// resolveUpdateBranch does not fail on a pin it refuses — it falls through to
// rule 2, then to `main`. So a value install.sh accepts and the updater rejects
// produces a device whose pin says `feat/a+b` and whose updater installs `main`,
// with nothing in the logs. That is the failure this file exists to prevent, so
// the invariant is asserted directly rather than restated as two lists.

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0
  && spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${INSTALL_SH.slice(start, end)}\n}`;
}

/** Run install.sh's real is_safe_git_ref against a candidate ref, from `cwd`. */
function installShAccepts(ref: string, cwd: string = path.parse(REPO).root): boolean {
  const script = [
    "set -uo pipefail",
    extractShellFunction("is_safe_git_ref"),
    // The ref arrives as $1, never interpolated into the script text. Embedding
    // it would quote for JavaScript rather than for bash, and the two entries
    // that matter most would be compared as different strings: a real newline
    // becomes a literal backslash-n inside bash double quotes, and `$(id)` gets
    // command-substituted, so the shell would be validating the output of `id`
    // while isSafeBranch validated the literal. Both still return "reject", so
    // the bug hides as a passing test.
    'is_safe_git_ref "$1"',
  ].join("\n");
  // cwd defaults outside any git repo: install.sh runs from wherever the
  // operator invoked it, so the answer must not depend on being inside one.
  return spawnSync("bash", ["-c", script, "is_safe_git_ref", ref], { cwd }).status === 0;
}

// Real branch names, near-misses, and the values that historically resolved
// somewhere unintended. Anything added here is checked against BOTH validators.
const CORPUS = [
  "main",
  "beta",
  "fix/persist-update-branch",
  "origin/beta",
  "release/v1.0.0",
  "fix_something",
  "feature/branch.name",
  "feature/HEAD",
  "HEAD/x",
  "refs/heads/x",
  "v1.0",
  "a_b",
  // near-misses / hostile
  "feat/a+b",
  "feat/a~b",
  "feat/a^b",
  "feat/a:b",
  "-D",
  "--all",
  "/lead",
  "HEAD",
  "a..b",
  "a...b",
  "x/",
  "x//y",
  ".hidden",
  "a.",
  "a.lock",
  "a.lock/b",
  "a@{1}",
  "@",
  "a@b",
  "branch with spaces",
  "branch!special",
  "branch\nnewline",
  "ünïcode",
  "beta; rm -rf /",
  "$(id)",
  // Canaries for the harness rather than for the validators. Both sides must
  // reject these literally. If the ref were ever interpolated into the shell
  // script instead of passed as an argument, bash would substitute them to
  // "main" and accept, while isSafeBranch kept rejecting the literal — so the
  // agreement assertion below fails loudly instead of passing on two different
  // strings.
  "$(echo main)",
  "`echo main`",
  "",
];

d("install.sh and update-branch.ts agree on what a branch is", () => {
  it("never lets install.sh write a pin the updater would refuse", () => {
    // The safety-critical direction. install.sh must be a SUBSET: every value it
    // is willing to persist has to be one the runtime will honour, because the
    // penalty for a refused pin is a silent fall-through to `main`.
    const writtenButRefused = CORPUS.filter(
      (ref) => installShAccepts(ref) && !isSafeBranch(ref),
    );

    expect(writtenButRefused).toEqual([]);
  });

  it("agrees in both directions across the corpus", () => {
    const disagreements = CORPUS.filter((ref) => installShAccepts(ref) !== isSafeBranch(ref));

    expect(disagreements).toEqual([]);
  });

  it("accepts the branches devices are actually built from", () => {
    for (const ref of ["main", "beta", "fix/persist-update-branch", "release/v1.0.0"]) {
      expect(isSafeBranch(ref), ref).toBe(true);
      expect(installShAccepts(ref), ref).toBe(true);
    }
  });

  it("gives the same answer from a directory holding a broken .git", () => {
    // `git check-ref-format` needs no repository, but git still runs repository
    // discovery from the working directory first, and a broken .git there makes
    // it exit 128 for EVERY ref. That reads as "no valid branch": no pin gets
    // written and the device falls back to main — this PR's failure mode,
    // triggered by nothing but the directory the operator happened to be in.
    // install.sh pins this by calling `git -C /`.
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-brokengit-"));
    try {
      fs.writeFileSync(
        path.join(broken, ".git"),
        "gitdir: /nonexistent/path/worktrees/gone\n",
      );

      expect(installShAccepts("beta", broken)).toBe(true);
      expect(installShAccepts("fix/persist-update-branch", broken)).toBe(true);
      // and still rejects, rather than passing everything for the same reason
      expect(installShAccepts("HEAD", broken)).toBe(false);
      expect(installShAccepts("a..b", broken)).toBe(false);
    } finally {
      fs.rmSync(broken, { recursive: true, force: true });
    }
  });
});

describe("values that resolve somewhere other than where they read", () => {
  it('rejects "HEAD", which git resolves to origin\'s default branch', () => {
    // `git reset --hard origin/HEAD` follows origin's default branch — main —
    // so a device pinned to HEAD tracks main while its pin reads as a choice.
    // The Settings route used to return 200 for this.
    expect(isSafeBranch("HEAD")).toBe(false);
  });

  it("rejects revision ranges and empty path components", () => {
    for (const ref of ["a..b", "a...b", "x/", "x//y"]) {
      expect(isSafeBranch(ref), ref).toBe(false);
    }
  });

  it("rejects git's reserved spellings", () => {
    for (const ref of [".hidden", "a.", "a.lock", "a.lock/b"]) {
      expect(isSafeBranch(ref), ref).toBe(false);
    }
  });

  it("still rejects the flag-injection shapes", () => {
    // A ref starting with '-' is parsed by git as an option, not a ref.
    for (const ref of ["-D", "--all", "/lead"]) {
      expect(isSafeBranch(ref), ref).toBe(false);
    }
  });

  it("keeps accepting the legal names that merely look reserved", () => {
    // Over-tightening is drift too, in the other direction: install.sh accepts
    // these, so the runtime must as well.
    for (const ref of ["feature/HEAD", "HEAD/x", "feature/branch.name", "v1.0"]) {
      expect(isSafeBranch(ref), ref).toBe(true);
    }
  });
});
