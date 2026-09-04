import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Which checks CI actually runs.
 *
 * TASK-708: three commands this repo ships and documents were in NO workflow —
 * `eslint`, `typecheck:mcp` and `check:mcp-tools`. The consequence was not
 * theoretical: `tsc -p mcp/tsconfig.json` reported three errors on beta that
 * nobody saw, in files the MCP tree pulls in transitively, because the root
 * tsconfig EXCLUDES `mcp/**` and nothing else typechecks that tree. Fixers had
 * been running these by hand.
 *
 * A command that only runs when someone remembers is a check the repo does not
 * have, so this pins the wiring rather than the commands.
 */

const REPO = path.resolve(__dirname, "../../..");
const WORKFLOWS = path.join(REPO, ".github", "workflows");

function workflow(name: string): string {
  return fs.readFileSync(path.join(WORKFLOWS, name), "utf-8");
}

/**
 * An anchored `run:` line, the idiom src/tests/unit/ci-workflows.test.ts
 * already uses.
 *
 * `toContain("bun run typecheck:mcp")` matches the workflow's own COMMENTS,
 * which name every one of these commands — so commenting a step out leaves the
 * assertion green. Measured: `# run: bun run typecheck:mcp  # TEMPORARILY OFF`
 * passes a substring check and fails this one.
 */
function runsCommand(source: string, command: string): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Either form: a one-line `run: <cmd>`, or the command on its own line inside
  // a `run: |` block. Both are real ways to run it; a COMMENTED one is not, and
  // neither anchor matches `# run: …` or `#   <cmd>`.
  return new RegExp(`^\\s+run: ${escaped}(\\s|$)`, "m").test(source)
    || new RegExp(`^\\s+${escaped}(\\s|$)`, "m").test(source);
}

describe("the checks CI runs", () => {
  const tests = workflow("pr-tests-coverage.yml");

  it("typechecks the MCP tree", () => {
    // `mcp/**` is excluded from the root tsconfig on purpose, so `tsc --noEmit`
    // — wherever it runs — never covers it. This is the only job that can.
    expect(runsCommand(tests, "bun run typecheck:mcp")).toBe(true);
  });

  it("checks the MCP tool contract", () => {
    expect(runsCommand(tests, "bun run check:mcp-tools")).toBe(true);
  });

  it("runs eslint", () => {
    expect(runsCommand(tests, "bun run lint")).toBe(true);
  });

  it("declares whether lint is advisory, rather than leaving it implied", () => {
    // eslint reports errors on beta today, so it cannot be blocking without
    // being fixed first. `continue-on-error` is the mechanism that says so out
    // loud; a step that is neither blocking nor marked advisory is a check
    // whose failures nobody can interpret.
    // Bounded at the NEXT step, or the slice runs to end-of-file and the
    // assertion is satisfied by a `continue-on-error` on some other step —
    // measured: moving it to the Test step left this green.
    const start = tests.lastIndexOf("- name:", tests.indexOf("bun run lint >"));
    const next = tests.indexOf("- name:", start + 1);
    const lintStep = tests.slice(start, next === -1 ? undefined : next);
    expect(lintStep).toMatch(/continue-on-error:\s*true/);
    expect(lintStep).toContain("bun run lint");
  });

  it("keeps every check in the same job as the tests", () => {
    // Not a second workflow and not a second job: these run on the same
    // checkout and the same `bun install`, so a PR gets one red X with
    // everything in it rather than four jobs to open.
    //
    // The `test` job is bounded by the next two-space key AFTER `jobs:`, so a
    // key under `on:` cannot be mistaken for a job.
    const jobsAt = tests.indexOf("\njobs:\n");
    expect(jobsAt).toBeGreaterThan(-1);
    const headers = [...tests.slice(jobsAt).matchAll(/^ {2}([\w-]+):$/gm)];
    expect(headers[0]?.[1]).toBe("test");
    const end = headers[1] ? jobsAt + headers[1].index! : tests.length;
    const testJob = tests.slice(jobsAt, end);

    for (const command of ["bun run typecheck:mcp", "bun run check:mcp-tools", "bun run lint"]) {
      expect(runsCommand(testJob, command), `${command} is not RUN in the test job`).toBe(true);
    }
  });
});
