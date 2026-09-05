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
// force-update.sh carries its own copy of the same shape: it is the recovery
// script an owner runs when the in-app update cannot, so it must not be able to
// hang on the box it is recovering either.
const FORCE_UPDATE_SH = fs.readFileSync(path.join(REPO, "scripts", "force-update.sh"), "utf-8");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

function extractShellFunctionFrom(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${source.slice(start, end)}\n}`;
}

function extractShellFunction(name: string): string {
  return extractShellFunctionFrom(INSTALL_SH, name);
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

/** Run one extracted-function script under a wall-clock bound, and report what stopped it. */
function runBounded(script: string, knobs: Record<string, string>): {
  status: number;
  output: string;
  attempts: number;
  harnessError: string | null;
} {
  const r = spawnSync("timeout", ["10", "bash", "-c", script], {
    encoding: "utf-8",
    // Far above what the runaway loop writes in ten seconds (~200 KB/s
    // measured), so spawnSync's 1 MB default cannot be what ends the run.
    maxBuffer: 64 * 1024 * 1024,
    env: testEnv({ PATH: process.env.PATH ?? "", ...knobs }),
  });
  const attempts = fs
    .readFileSync(attemptLog, "utf-8")
    .split("\n")
    .filter(Boolean).length;
  return {
    status: r.status ?? -1,
    output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    attempts,
    // `timeout` missing, or the buffer blown after all: either would otherwise
    // read as a clean run with an unexpected status.
    harnessError: r.error ? String(r.error) : null,
  };
}

/**
 * The retry knobs as an operator may actually have exported them.
 *
 * `git` always refuses here, so a loop that never breaks never returns on its
 * own and something has to stop it. `maxBuffer` is raised well past what the
 * runaway loop can produce in the window so that the thing which stops it is
 * `timeout` — rc 124 — and not spawnSync's 1 MB default cutting the child off
 * with `ENOBUFS` and a null status. That distinction is the whole reason the
 * "never exited" assertion below can fail at all: with the default buffer it
 * passes on the defective code.
 */
function runFetchWithKnobs(knobs: Record<string, string>): ReturnType<typeof runBounded> {
  const script = [
    "set -euo pipefail",
    `ATTEMPTS=${JSON.stringify(attemptLog)}`,
    "git() {",
    "  printf 'git %s\\n' \"$*\" >> \"$ATTEMPTS\"",
    `  printf '%s\\n' ${JSON.stringify(ANON_REFUSAL)} >&2`,
    "  return 128",
    "}",
    "sleep() { :; }",
    extractShellFunction("git_retryable_failure"),
    extractShellFunction("git_with_retry"),
    `git_with_retry -C ${JSON.stringify(tmp)} fetch origin || echo "rc=$?"`,
  ].join("\n");

  return runBounded(script, knobs);
}

/** force-update.sh's inline twin, with `run_as_clawbox` and `sleep` stubbed. */
function runForceFetch(gitSays: string, knobs: Record<string, string> = {}): ReturnType<typeof runBounded> {
  const script = [
    "set -euo pipefail",
    `ATTEMPTS=${JSON.stringify(attemptLog)}`,
    'GIT="git"',
    "run_as_clawbox() {",
    "  printf 'fetch\\n' >> \"$ATTEMPTS\"",
    `  printf '%s\\n' ${JSON.stringify(gitSays)} >&2`,
    "  return 128",
    "}",
    "sleep() { :; }",
    extractShellFunctionFrom(FORCE_UPDATE_SH, "git_retryable_failure"),
    extractShellFunctionFrom(FORCE_UPDATE_SH, "fetch_with_retry"),
    'fetch_with_retry || echo "rc=$?"',
  ].join("\n");

  return runBounded(script, knobs);
}

d("a retry knob an operator got wrong cannot hang the update", () => {
  it("clamps a non-numeric attempt count instead of looping for ever", () => {
    // `[ "$attempt" -ge "$max" ]` with a non-numeric `max` makes `[` itself
    // fail — "integer expression expected" — every iteration, so the loop
    // never reaches its break and the step burns its whole budget on a
    // refusal that will not clear. rc 124 below is `timeout` killing it.
    const r = runFetchWithKnobs({ CLAWBOX_GIT_RETRIES: "invalid" });

    expect(r.harnessError).toBeNull();
    expect(r.status, "`timeout` had to kill the retry loop").not.toBe(124);
    expect(r.attempts).toBe(3);
    expect(r.output).toContain("attempt 1/3");
    expect(r.output).not.toMatch(/integer expression expected/);
  });

  it("clamps a non-numeric delay, so the backoff stays a number of seconds", () => {
    // `sleep` is stubbed here, but on a box it is real and `set -e` is on: a
    // garbage delay makes `sleep` fail and takes the whole install.sh down.
    const r = runFetchWithKnobs({ CLAWBOX_GIT_RETRY_DELAY: "soon" });

    expect(r.harnessError).toBeNull();
    expect(r.output).toContain("retrying in 3s");
    expect(r.output).not.toMatch(/unbound variable/);
  });

  it("keeps a deliberate override working", () => {
    const r = runFetchWithKnobs({ CLAWBOX_GIT_RETRIES: "2", CLAWBOX_GIT_RETRY_DELAY: "7" });

    expect(r.attempts).toBe(2);
    expect(r.output).toContain("attempt 1/2");
    expect(r.output).toContain("retrying in 7s");
  });
});

d("scripts/force-update.sh retries the same way, or does not retry at all", () => {
  it("clamps a non-numeric attempt count instead of looping for ever", () => {
    const r = runForceFetch(ANON_REFUSAL, { CLAWBOX_GIT_RETRIES: "invalid" });

    expect(r.harnessError).toBeNull();
    expect(r.status, "`timeout` had to kill the retry loop").not.toBe(124);
    expect(r.attempts).toBe(3);
  });

  it("classifies with the SAME list install.sh uses, character for character", () => {
    // Two copies exist because install.sh is an installer, not a library, and
    // cannot be sourced from a standalone recovery script. Nothing else stops
    // them drifting: each is extracted separately by the tests above, so either
    // could be edited alone and stay green while the two scripts disagreed
    // about which failures are worth asking again.
    expect(extractShellFunctionFrom(FORCE_UPDATE_SH, "git_retryable_failure"))
      .toBe(extractShellFunction("git_retryable_failure"));
  });

  it("retries GitHub's anonymous refusal", () => {
    const r = runForceFetch(ANON_REFUSAL);

    expect(r.attempts).toBe(3);
    expect(r.output).toMatch(/GitHub refused this device's anonymous request/);
  });

  it("does not retry a failure asking again cannot fix", () => {
    // The recovery script is run by an owner who is already stuck. Spending
    // 3 s + 6 s of backoff on a broken remote before saying so is time taken
    // from someone waiting at the box.
    const r = runForceFetch("fatal: 'origin' does not appear to be a git repository");

    expect(r.attempts).toBe(1);
  });
});

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
