import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Starts real processes (bash, jq, timeout, a fixture test that is killed at
// its two-second deadline): vitest's 5 s test default is not enough. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });

// The on-device suite (scripts/nano-tests/, TASK-1324) needs a nano-lab board
// and runs in .github/workflows/nano-hardware-tests.yml. Its RUNNER does not:
// scripts/nano-tests/selftest.sh drives run.sh against fixture tests and a
// stub `nano-ci` and checks every verdict it reaches — ok / not ok / skip, the
// per-test deadline, the exit code, summary.json's shape, redaction, a
// cancelled run — plus lib.sh's quoting across `nano-ci ssh` and the job
// summary. This runs that self-test from `npm test`, the way the repo runs its
// other shell scripts; the `checks` job of pr-tests-coverage.yml runs it too,
// beside shellcheck.

const SELFTEST = path.resolve(process.cwd(), "scripts/nano-tests/selftest.sh");

const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
const canRun = process.platform === "linux" && has("bash", ["--version"]) && has("jq", ["--version"]) && has("timeout", ["--version"]);

describe.skipIf(!canRun)("scripts/nano-tests/run.sh (self-test)", () => {
  it("passes every self-test check", () => {
    const result = spawnSync("bash", [SELFTEST], { encoding: "utf-8", timeout: 110_000 });
    const output = `${result.stdout}\n${result.stderr}`;
    const failed = output.split("\n").filter((line) => line.startsWith("not ok"));
    expect(failed, output).toEqual([]);
    expect(result.status, output).toBe(0);
    expect(result.stdout).toMatch(/^# all \d+ self-test checks passed$/m);
  });
});
