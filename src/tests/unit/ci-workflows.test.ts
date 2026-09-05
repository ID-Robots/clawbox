import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * The CI workflows are configuration no other test sees, and two of their
 * speed-ups are only correct while a relation BETWEEN files holds:
 *
 * - pr-tests-coverage.yml runs vitest with the json-summary reporter alone
 *   (the html tree, the clover XML and the text table cost real time in a
 *   550-file suite and nothing in CI reads them). That is safe precisely
 *   because "Parse coverage" reads coverage-summary.json — the one file
 *   json-summary writes. Drop that reporter, or read a different file, and
 *   the step's `if [ -f ... ]` guard switches the PR comment's numbers off
 *   silently instead of failing the job.
 * - e2e-tests.yml restores .next/cache before the build. Put the cache step
 *   after the run step and it restores nothing while looking like it does.
 *
 * These read the files as text on purpose: the repo has no YAML parser as a
 * direct dependency, and the checks are about lines, not structure.
 */

const REPO = path.resolve(__dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf-8");

describe("Tests workflow coverage reporters", () => {
  const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
  const workflow = read(".github/workflows/pr-tests-coverage.yml");

  it("test:coverage:ci is test:coverage with only the reporter set changed", () => {
    // Same vitest, same config file, same thresholds: a CI-only script that
    // ran a different suite would let coverage pass on CI and fail locally.
    expect(scripts["test:coverage:ci"]).toMatch(/^vitest run --config vitest\.config\.ts --coverage\b/);
    expect(scripts["test:coverage:ci"].startsWith(scripts["test:coverage"])).toBe(true);
    expect(scripts["test:coverage:ci"]).toContain("--coverage.reporter=json-summary");
    for (const reporter of ["html", "clover", "text"]) {
      expect(scripts["test:coverage:ci"]).not.toContain(`--coverage.reporter=${reporter}`);
    }
  });

  it("the workflow runs the CI script and parses the file json-summary writes", () => {
    expect(workflow).toMatch(/^\s+run: bun run test:coverage:ci$/m);
    // vitest's json-summary reporter writes coverage/coverage-summary.json;
    // the parse step's guard and its readFileSync must both name that file.
    expect(workflow).toMatch(/if \[ -f coverage\/coverage-summary\.json \]/);
    expect(workflow).toMatch(/readFileSync\('coverage\/coverage-summary\.json'/);
  });

  it("the local script keeps every reporter for a person at a checkout", () => {
    expect(scripts["test:coverage"]).not.toContain("--coverage.reporter");
    const config = read("vitest.config.ts");
    expect(config).toMatch(/reporter: \["text", "json-summary", "html", "clover"\]/);
  });
});

describe("E2E workflow Next.js build cache", () => {
  const workflow = read(".github/workflows/e2e-tests.yml");

  it("restores .next/cache before the build that fills it", () => {
    const cacheStep = workflow.indexOf("path: .next/cache");
    const runStep = workflow.indexOf("run: bun run test:e2e:coverage");
    expect(cacheStep).toBeGreaterThan(-1);
    expect(runStep).toBeGreaterThan(-1);
    expect(cacheStep).toBeLessThan(runStep);
  });

  it("keys the cache on the lockfile and the build inputs, with a lockfile fallback", () => {
    const step = workflow.slice(workflow.indexOf("path: .next/cache"), workflow.indexOf("run: bun run test:e2e:coverage"));
    // An exact key must change whenever the sources do; otherwise a hit would
    // hand the build a cache from other code (Next re-validates entries, so
    // that is slow rather than wrong — but it would be a cache that never
    // updates). The prefix fallback is what makes an unrelated change warm.
    expect(step).toMatch(/key: nextjs-\$\{\{ runner\.os \}\}-\$\{\{ hashFiles\('bun\.lock'\) \}\}-\$\{\{ hashFiles\('src\/\*\*'/);
    expect(step).toMatch(/restore-keys: \|\n\s+nextjs-\$\{\{ runner\.os \}\}-\$\{\{ hashFiles\('bun\.lock'\) \}\}-\n/);
  });
});

/**
 * Which checks CI actually runs — and whether they can still fail the job.
 *
 * TASK-708: three commands this repo ships and documents were in NO workflow —
 * `eslint`, `typecheck:mcp` and `check:mcp-tools`. The consequence was not
 * theoretical: `tsc -p mcp/tsconfig.json` reported three errors on beta that
 * nobody saw, in files the MCP tree pulls in transitively, because the root
 * tsconfig EXCLUDES `mcp/**` and nothing else typechecks that tree. Fixers had
 * been running these by hand.
 *
 * A command that only runs when someone remembers is a check the repo does not
 * have — and so is a step present but neutered, which is why every assertion
 * below is made over the STEP, not over the file. Measured on the first
 * revision of this guard: `continue-on-error: true`, `if: ${{ false }}` and
 * `run: bun run typecheck:mcp || true` each left all five cases green. That is
 * the false-success class inside the guard against it.
 */
describe("the checks CI runs, and their blocking status", () => {
  const tests = read(".github/workflows/pr-tests-coverage.yml");

  /**
   * One step of a job, from its `- name:` to the next one, COMMENTS REMOVED.
   *
   * Bounded at the NEXT step, or the slice runs to end-of-file and every
   * assertion below is satisfied by some other step's keys — measured: without
   * the bound, moving `continue-on-error` to the Test step left the lint case
   * green.
   *
   * And the comments go, because that bound puts a step's DOCUMENTATION inside
   * the PREVIOUS step's slice: a comment block sits above the `- name:` it
   * describes. This workflow's lint comment names `continue-on-error` twice, so
   * over the raw slice the `Test` step read as advisory and could not be pinned
   * at all — which is why `continue-on-error: true` on it left every case here
   * green. The same coupling let any harmless comment false-fail the step above
   * it, with a message accusing a step nobody touched.
   *
   * Anchored on the `run:` LINE where the step has one, for the mirror-image
   * reason: `indexOf` takes the first occurrence anywhere in the file, and a
   * comment that quotes a command would anchor the slice on some other step.
   * The multi-line lint step writes `run: |` and names its command below, so
   * the bare command stays as the fallback.
   */
  function step(command: string): string {
    const at = [tests.indexOf(`run: ${command}`), tests.indexOf(command)].find((i) => i > -1) ?? -1;
    expect(at, `${command} appears nowhere in the workflow`).toBeGreaterThan(-1);
    const start = tests.lastIndexOf("- name:", at);
    const next = tests.indexOf("- name:", start + 1);
    return tests.slice(start, next === -1 ? undefined : next)
      .split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  }

  /**
   * The step runs exactly that command, and nothing swallows its status.
   *
   * `toContain("bun run typecheck:mcp")` matches the workflow's own COMMENTS,
   * which name every one of these commands — so commenting a step out leaves
   * such an assertion green. And an anchor that allows a suffix matches
   * `|| true`, `; true` and `|| echo WARN`, which is the same defect written
   * the other way round: the step runs, reports success, and checks nothing.
   */
  function runsBlocking(command: string): void {
    const body = step(command);
    const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(body, `${command} is not the step's whole run: line`)
      .toMatch(new RegExp(`^\\s+run: ${escaped}\\s*$`, "m"));
    expect(body, `${command} is marked advisory`).not.toMatch(/continue-on-error/);
    expect(body, `${command} is conditional, so it can be switched off in place`)
      .not.toMatch(/^\s+if:/m);
  }

  it("typechecks the MCP tree, blocking", () => {
    // `mcp/**` is excluded from the root tsconfig on purpose, so `tsc --noEmit`
    // — wherever it runs — never covers it. This is the only job that can.
    runsBlocking("bun run typecheck:mcp");
  });

  it("checks the MCP tool contract, blocking", () => {
    runsBlocking("bun run check:mcp-tools");
  });

  it("runs the suite itself, blocking", () => {
    // The step this whole workflow exists for, and the one the pinning test did
    // not pin: `continue-on-error: true` here keeps the job green, so
    // `needs.test.result` reaches the `comment` job as `success` and the PR
    // comment renders "Tests — Result: passed" over a red suite of 11 000+
    // tests. Measured on the first revision of this guard: adding that key to
    // the Test step left all eleven cases green.
    runsBlocking("bun run test:coverage:ci");
  });

  it("checks the sudoers allow-list, blocking", () => {
    // A privilege boundary, and the third blocking step here. It was as
    // unpinned as the suite was.
    runsBlocking("bun run check:sudoers");
  });

  it("runs eslint, and says out loud that it is advisory", () => {
    // eslint reports errors on beta today, so it cannot be blocking without
    // being fixed first. `continue-on-error` is the mechanism that says so out
    // loud; a step that is neither blocking nor marked advisory is a check
    // whose failures nobody can interpret. It is the ONE step here allowed to
    // carry that key, which the two cases above assert.
    const lint = step("bun run lint >");
    expect(lint).toMatch(/continue-on-error:\s*true/);
    // It writes the counts somewhere a person looks, and tells a CLEAN run from
    // a CRASHED one — eslint prints no summary line for either, so one branch
    // for both would make every PR read like a broken step the day the ratchet
    // reaches zero.
    expect(lint).toContain("GITHUB_STEP_SUMMARY");
    expect(lint).toMatch(/Lint clean/);
    expect(lint).toMatch(/crashed/);
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
      expect(testJob.includes(command), `${command} is not in the test job`).toBe(true);
    }
  });

  it("cannot be switched off a level up either", () => {
    // The step assertions above have a blind spot one level higher, and it is
    // cheaper to reach than any of the three they close. Measured, each leaving
    // all the other cases green:
    //
    //   jobs.test.continue-on-error: true   → GitHub does not fail the workflow
    //     on the job, so `needs.test.result` reaches the `comment` job as
    //     `success` and the PR comment renders "Tests — Result: passed" over a
    //     red suite. The false-success sentence this whole PR exists to prevent.
    //   jobs.test.if: ${{ false }}          → the job is skipped outright: three
    //     checks and the entire suite.
    //   on.pull_request.paths: [...]        → most PRs never trigger it at all.
    const jobsAt = tests.indexOf("\njobs:\n");
    const header = tests.slice(jobsAt, tests.indexOf("    steps:", jobsAt));
    expect(header).toContain("  test:");
    expect(header, "the test job is marked continue-on-error").not.toMatch(/continue-on-error/);
    expect(header, "the test job is conditional").not.toMatch(/^ {4}if:/m);

    // The trigger, unnarrowed: `pull_request:` with no key under it. A
    // `paths:`/`paths-ignore:`/`types:` filter would exempt whole classes of PR
    // from every check above, and nothing else here would notice.
    expect(tests.slice(0, jobsAt)).toMatch(/\non:\n {2}pull_request:\n(?! {4})/);
  });

  it("says Tests passed or failed only about the suite, never about the job", () => {
    // `needs.test.result` is the JOB's verdict and the sentence claims something
    // about the SUITE. They come apart in both directions: a blocking step ahead
    // of vitest failing leaves the suite unrun, and a step after it failing
    // (Parse coverage, which runs `if: always()` and parses JSON) turns the job
    // red over a green suite. Reading the job verdict as the suite's is a false
    // failure either way, so the verdict is driven off the suite step's own
    // outcome and the job result gets a line of its own.
    //
    // It takes all four — the id, the job output, the env, and a branch that
    // reads only `success`/`failure` as a verdict — or the comment silently
    // falls back to the job.
    expect(step("bun run test:coverage:ci")).toMatch(/^\s+id: suite$/m);
    expect(tests).toMatch(/^\s+suite: \$\{\{ steps\.suite\.outcome \}\}$/m);
    expect(tests).toMatch(/SUITE_OUTCOME: \$\{\{ needs\.test\.outputs\.suite \}\}/);
    expect(tests).toMatch(/const passed = suite === 'success';/);
    expect(tests).toMatch(/const failed = suite === 'failure';/);
    expect(tests).toContain("did not run");
    // …and the job's own result is reported, not silently dropped.
    expect(tests).toContain("TEST_RESULT !== 'success'");
  });

  it("keeps every PR-comment job reachable on a red run", () => {
    // The hole that let all of the above ship dead. Every other assertion in
    // this file is about the `test` job; the feature lives in `comment`.
    //
    // A job whose `if:` carries no status-check function gets GitHub's implicit
    // `success()`, so it is SKIPPED whenever the job it `needs` failed. The
    // comment is edited in place under one marker, so its section then keeps
    // whatever it last said — verified live, `test -> failure, comment ->
    // skipped` on runs 33967347945, 33968019417 and 33939067430, while a PR
    // whose latest run was red showed "✅ Tests — Result: passed" for a day.
    // The only sentence the job had ever been able to render was "passed".
    //
    // All three comment jobs, because it is the same mechanism in each and
    // e2e-tests.yml had it too; e2e-install.yml is the one that got it right,
    // and is pinned here so it stays that way.
    for (const file of ["pr-tests-coverage.yml", "e2e-tests.yml", "e2e-install.yml"]) {
      const yml = read(`.github/workflows/${file}`);
      const at = yml.indexOf("\n  comment:\n");
      expect(at, `${file} has no comment job`).toBeGreaterThan(-1);
      const header = yml.slice(at, yml.indexOf("    steps:", at));
      expect(header, `${file}: the comment job does not wait for the job it reports on`)
        .toMatch(/^ {4}needs: \S+$/m);
      expect(header, `${file}: the comment job's if: has no status function, so GitHub skips it whenever the job it reports on fails`)
        .toMatch(/^ {4}if:.*(always\(\)|!cancelled\(\)|failure\(\))/m);
    }
  });

  it("runs the advisory step after the suite it must not delay", () => {
    // Lint is the only non-blocking step here; running it first put a check
    // nobody is waiting for in front of the verdict everybody is. `if: always()`
    // is what keeps it running when the suite went red — the counts are most
    // useful on exactly that run.
    expect(tests.indexOf("bun run test:coverage:ci")).toBeLessThan(tests.indexOf("bun run lint >"));
    // Either status function keeps it running on a red suite. `!cancelled()` is
    // the better one — `always()` also runs it while the job is being cancelled,
    // which on a hung suite spends another two minutes after the timeout that
    // exists to stop exactly that — and it is the idiom e2e-tests.yml uses.
    expect(step("bun run lint >")).toMatch(/if:\s*(\$\{\{\s*)?(always\(\)|!cancelled\(\))/);
  });
});
