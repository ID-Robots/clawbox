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

/** Every `run:` line in a workflow, block scalars included. */
function runLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => /^\s+(run:|[^\s#-].*)/.test(line) || line.trim().length > 0)
    .join("\n");
}

describe("the checks CI runs", () => {
  const tests = workflow("pr-tests-coverage.yml");

  it("typechecks the MCP tree", () => {
    // `mcp/**` is excluded from the root tsconfig on purpose, so `tsc --noEmit`
    // — wherever it runs — never covers it. This is the only job that can.
    expect(runLines(tests)).toMatch(/bun run typecheck:mcp/);
  });

  it("checks the MCP tool contract", () => {
    expect(runLines(tests)).toMatch(/bun run check:mcp-tools/);
  });

  it("runs eslint", () => {
    expect(runLines(tests)).toMatch(/bun run lint/);
  });

  it("declares whether lint is advisory, rather than leaving it implied", () => {
    // eslint reports errors on beta today, so it cannot be blocking without
    // being fixed first. `continue-on-error` is the mechanism that says so out
    // loud; a step that is neither blocking nor marked advisory is a check
    // whose failures nobody can interpret.
    const lintStep = tests.slice(tests.lastIndexOf("- name:", tests.indexOf("bun run lint")));
    expect(lintStep).toMatch(/continue-on-error:\s*true/);
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
      expect(testJob, `${command} is not in the test job`).toContain(command);
    }
  });
});
