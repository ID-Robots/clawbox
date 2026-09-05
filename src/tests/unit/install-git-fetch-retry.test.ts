import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { testEnv } from "@/tests/helpers/env";

// Starts a real bash: vitest's 5 s test and 10 s hook defaults are not enough
// on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Measured on the dev network 2026-09-02 (TASK-655): GitHub answers git's
 * protocol-v2 POST to /git-upload-pack with `HTTP 401` and a body reading
 * "Repository not found." — for a PUBLIC repository — from an address that has
 * used up its anonymous allowance. git reports it as
 * `fatal: could not read Username for 'https://github.com'`.
 *
 * Roughly one attempt in three got through, and step 0 of an in-app update
 * (`bootstrap_updater` → `sync_repo_to_update_target`) fetches exactly once. So
 * a box behind such an address cannot update, and the failure text sends its
 * owner looking for a password nobody has.
 *
 * git itself has no retry: 2.34 (the boxes) and 2.43 (the dev PC) both lack any
 * `fetch.retry` / `http.retry` knob, so the retry has to live in install.sh.
 * `GIT_TERMINAL_PROMPT=0` IS git's own switch and is used rather than
 * reimplemented — without it the same fetch blocks on a credential prompt when
 * a tty is attached instead of failing.
 */

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${INSTALL_SH.slice(start, end)}\n}`;
}

const ANON_REFUSAL = "fatal: could not read Username for 'https://github.com': No such device or address";

let tmp: string;
let attemptLog: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-fetch-retry-"));
  attemptLog = path.join(tmp, "attempts");
  fs.writeFileSync(attemptLog, "");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Drive the shipped function against a stub `git` that refuses the first
 * `refusals` attempts exactly the way github.com does, then succeeds.
 * `sleep` is stubbed so the backoff is observable without being waited out.
 */
function runFetch(refusals: number): { status: number; output: string; attempts: number } {
  const script = [
    "set -euo pipefail",
    `ATTEMPTS=${JSON.stringify(attemptLog)}`,
    `REFUSALS=${refusals}`,
    "git() {",
    "  printf 'git %s\\n' \"$*\" >> \"$ATTEMPTS\"",
    "  local n; n=$(wc -l < \"$ATTEMPTS\")",
    "  if [ \"$n\" -le \"$REFUSALS\" ]; then",
    `    printf '%s\\n' ${JSON.stringify(ANON_REFUSAL)} >&2`,
    "    return 128",
    "  fi",
    "  return 0",
    "}",
    "sleep() { :; }",
    extractShellFunction("git_retryable_failure"),
    extractShellFunction("git_with_retry"),
    `git_with_retry -C ${JSON.stringify(tmp)} fetch origin`,
  ].join("\n");

  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "" }),
  });
  const attempts = fs
    .readFileSync(attemptLog, "utf-8")
    .split("\n")
    .filter(Boolean).length;
  return { status: r.status ?? -1, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, attempts };
}

d("install.sh survives GitHub refusing an anonymous fetch", () => {
  it("retries a refused fetch instead of failing the update on the first attempt", () => {
    const r = runFetch(2);

    expect(r.status).toBe(0);
    expect(r.attempts).toBe(3);
  });

  it("does not retry a fetch that succeeded", () => {
    const r = runFetch(0);

    expect(r.status).toBe(0);
    expect(r.attempts).toBe(1);
  });

  it("names GitHub's anonymous refusal rather than a missing password", () => {
    const r = runFetch(99);

    expect(r.status).not.toBe(0);
    // The owner is told what actually happened. "could not read Username"
    // alone sent two people looking for credentials a ClawBox never has.
    expect(r.output).toMatch(/anonymous/i);
    expect(r.output).toMatch(/GitHub/);
  });

  it("does not retry a failure asking again cannot fix", () => {
    // "destination path already exists" is not a refusal; three attempts and
    // 9 s of sleeps spend the root step's budget to reach the same answer.
    const script = [
      "set -euo pipefail",
      `ATTEMPTS=${JSON.stringify(attemptLog)}`,
      "git() {",
      "  printf 'git %s\\n' \"$*\" >> \"$ATTEMPTS\"",
      "  echo \"fatal: destination path 'x' already exists and is not an empty directory.\" >&2",
      "  return 128",
      "}",
      "sleep() { :; }",
      extractShellFunction("git_retryable_failure"),
      extractShellFunction("git_with_retry"),
      `git_with_retry clone --branch beta https://example.invalid/x ${JSON.stringify(tmp)} || true`,
    ].join("\n");
    spawnSync("bash", ["-c", script], {
      encoding: "utf-8",
      env: testEnv({ PATH: process.env.PATH ?? "" }),
    });

    expect(fs.readFileSync(attemptLog, "utf-8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("leaves git's own output on stderr, so a caller capturing stdout gets none of it", () => {
    // The function captures git's stderr to classify it. Re-emitting it on
    // STDOUT would make it indistinguishable from a result to any future caller
    // that reads this function's stdout.
    const script = [
      "set -euo pipefail",
      "git() { echo 'Fetching origin' >&2; return 0; }",
      extractShellFunction("git_retryable_failure"),
      extractShellFunction("git_with_retry"),
      "out=$(git_with_retry -C /tmp fetch origin 2>/dev/null)",
      'printf "[%s]" "$out"',
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf-8",
      env: testEnv({ PATH: process.env.PATH ?? "" }),
    });

    expect(r.status).toBe(0);
    expect(r.stdout?.trim()).toBe("[]");
  });

  it("is defined before the bootstrap block that runs the FIRST of the three fetches", () => {
    // bash defines a function when execution reaches it. The bootstrap block
    // decides which install.sh the rest of the update runs, so a definition
    // below it would leave that fetch — the one that matters most — unretried.
    const defined = INSTALL_SH.indexOf("git_with_retry() {");
    const bootstrap = INSTALL_SH.indexOf("# ── Bootstrap: pull latest install.sh");
    const used = INSTALL_SH.indexOf("git_with_retry -C \"$_b\"");

    expect(defined).toBeGreaterThan(-1);
    expect(bootstrap).toBeGreaterThan(defined);
    expect(used).toBeGreaterThan(bootstrap);
  });

  it("is what sync_repo_to_update_target fetches through", () => {
    const sync = extractShellFunction("sync_repo_to_update_target");

    expect(sync).toContain("git_with_retry");
    // The bare one-shot fetch is what step 0 died on; it must not survive
    // beside the retrying one.
    expect(sync).not.toMatch(/^\s*git -c safe\.directory=.*fetch origin\s*$/m);
  });
});
