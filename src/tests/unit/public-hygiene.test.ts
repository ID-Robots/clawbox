import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Starts real processes (node, and git for the scan-diff cases): vitest's 5 s
// test default is not enough. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });

// scripts/public-hygiene.mjs keeps internal details out of this public
// repository (TASK-1366): the `public-hygiene` check scans every PR's added
// lines with it, and the nano workflow redacts its log, summary, comment and
// artifact through it. Its unit tests are plain `node --test`, so that check
// runs them without installing anything; this runs the same file from
// `npm test`, the way nano-tests-runner.test.ts runs the nano self-test.

const TESTS = path.resolve(process.cwd(), "scripts/public-hygiene.test.mjs");

const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;

describe.skipIf(!has("git", ["--version"]))("scripts/public-hygiene.mjs (node --test)", () => {
  it("passes every unit test", () => {
    const result = spawnSync("node", ["--test", TESTS], { encoding: "utf-8", timeout: 110_000 });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toMatch(/^# fail 0$/m);
    expect(result.status, output).toBe(0);
  });
});
