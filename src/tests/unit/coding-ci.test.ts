/**
 * A pull request's failed CI, read (src/lib/coding-ci.ts) — from the shape
 * `gh run view --log-failed` really prints: `<job>\t<step>\t<timestamp> <text>`,
 * coloured — and whether a team's goal asks for a pull request or a merge.
 */
import { describe, expect, it } from "vitest";
import { ciFailureLine, ciFiles, ciFixNotes, cleanActionsLog, goalRefusesPullRequest, goalWantsMerge, goalWantsPullRequest, MAX_CI_FIX_ATTEMPTS, MAX_TEAM_CI_ROUNDS, readCiFailure } from "@/lib/coding-ci";

const line = (text: string, job = "test (20.x)", step = "Run tests") => `${job}\t${step}\t2026-10-11T10:00:00.1234567Z ${text}`;

const VITEST_LOG = [
  line("\u001b[31m FAIL \u001b[39m src/tests/unit/cart.test.ts > cart > adds the tax"),
  line("AssertionError: expected 10 to be 11"),
  line(" ❯ src/lib/cart.ts:12:3"),
  line(" ❯ /home/runner/work/shop/shop/src/lib/tax.ts:4:10"), // public-hygiene: allow GitHub's hosted-runner checkout path, the prefix under test
  line("   at node_modules/vitest/dist/runner.js:1:1"),
  line("See https://github.com/o/r/blob/main/docs/x.md for help"),
  line("##[error]Process completed with exit code 1."),
].join("\n");

const PYTHON_LOG = [
  line("FAIL: test_km_to_mi (test_convert.TestConvert.test_km_to_mi)", "unit", "python -m unittest"),
  line('  File "/home/runner/work/conv/conv/convert.py", line 4, in convert', "unit", "python -m unittest"), // public-hygiene: allow GitHub's hosted-runner checkout path, the prefix under test
  line("KeyError: ('km', 'mi')", "unit", "python -m unittest"),
].join("\n");

const check = (name: string, url: string | null = "https://github.com/o/r/actions/runs/123/job/456") => ({ name, state: "fail" as const, url });

describe("cleanActionsLog", () => {
  it("takes the job, the step, the timestamp and the colour off every line", () => {
    expect(cleanActionsLog(VITEST_LOG).split("\n")[0]).toBe(" FAIL  src/tests/unit/cart.test.ts > cart > adds the tax");
    expect(cleanActionsLog(VITEST_LOG).split("\n")[1]).toBe("AssertionError: expected 10 to be 11");
    expect(cleanActionsLog("plain line")).toBe("plain line");
  });
});

describe("readCiFailure", () => {
  it("names the failing tests and the files, a runner's checkout path made the repository's", () => {
    const f = readCiFailure(7, [{ check: check("test (20.x)"), log: VITEST_LOG }], 1_000);
    expect(f).toMatchObject({ prNumber: 7, at: 1_000, checks: ["test (20.x)"], unread: [] });
    expect(f.tests).toEqual(["src/tests/unit/cart.test.ts > cart > adds the tax"]);
    expect(f.files).toEqual(["src/tests/unit/cart.test.ts", "src/lib/cart.ts", "src/lib/tax.ts"]);
    // Never a toolchain's file, never a URL's path.
    expect(f.files.join(" ")).not.toMatch(/node_modules|docs\/x\.md/);
    expect(f.excerpt).toContain("AssertionError: expected 10 to be 11");
    expect(f.excerpt).not.toContain("2026-10-11T");
  });

  it("reads a Python traceback the same way, and reads a log shared by two checks once", () => {
    const f = readCiFailure(3, [{ check: check("unit"), log: PYTHON_LOG }, { check: check("unit (3.12)"), log: PYTHON_LOG }]);
    expect(f.checks).toEqual(["unit", "unit (3.12)"]);
    expect(f.tests).toEqual(["test_convert.TestConvert.test_km_to_mi"]);
    expect(f.files).toEqual(["convert.py"]);
    expect(f.excerpt.match(/KeyError/g)).toHaveLength(1);
  });

  it("says which failing checks it could not read, rather than dropping them", () => {
    const f = readCiFailure(3, [{ check: check("lint", null), log: null }, { check: check("unit"), log: PYTHON_LOG }]);
    expect(f.unread).toEqual(["lint"]);
    expect(f.checks).toEqual(["lint", "unit"]);
  });

  it("keeps the excerpt to its tail, at a line", () => {
    const long = Array.from({ length: 400 }, (_, i) => line(`noise ${i} ${"x".repeat(40)}`)).join("\n");
    const f = readCiFailure(1, [{ check: check("build"), log: long }]);
    expect(f.excerpt.length).toBeLessThanOrEqual(2_401);
    expect(f.excerpt.startsWith("…\n")).toBe(true);
    expect(f.excerpt).toContain("noise 399");
  });
});

describe("ciFiles", () => {
  it("leaves out a path anywhere on the runner but the checkout", () => {
    expect(ciFiles("at /opt/hostedtoolcache/node/20/lib/x.js:1\nat /__w/repo/repo/app/main.ts:2")).toEqual(["app/main.ts"]);
  });

  it("names a file at the repository's root from a runner's line or a line number, never a host or a version", () => {
    expect(ciFiles(" FAIL  app.test.js > the form > submits\n ❯ app.js:3:1\nlistening on localhost:3000\nusing node:20.11")).toEqual(["app.test.js", "app.js"]);
  });
});

describe("what the fixer is told", () => {
  const failure = readCiFailure(7, [{ check: check("test (20.x)"), log: VITEST_LOG }]);

  it("a single run pushes its fix; a team's worker never does", () => {
    const run = ciFixNotes(failure, { push: true });
    expect(run).toMatch(/^CI failed on pull request #7: test \(20\.x\); failing tests: src\/tests\/unit\/cart\.test\.ts > cart > adds the tax\./);
    expect(run).toContain("- src/tests/unit/cart.test.ts > cart > adds the tax");
    expect(run).toContain("Files the failure names: src/tests/unit/cart.test.ts, src/lib/cart.ts, src/lib/tax.ts");
    expect(run).toMatch(/commit and push the branch so pull request #7 updates/);
    const worker = ciFixNotes(failure, { push: false, excerptChars: 200 });
    expect(worker).toMatch(/Do not push: the team's orchestrator pushes the fix/);
    expect(worker).not.toMatch(/commit and push/);
  });

  it("says what failed in one line for the feed and the board", () => {
    expect(ciFailureLine({ prNumber: 9, checks: ["build", "lint"], tests: [] })).toBe("CI failed on pull request #9: build, lint");
  });

  it("is bounded", () => {
    expect(MAX_CI_FIX_ATTEMPTS).toBe(2);
    expect(MAX_TEAM_CI_ROUNDS).toBe(2);
  });
});

describe("what a team's goal asks for", () => {
  it.each([
    ["Build the invoice app and open a PR", true, false],
    ["Add dark mode, open a pull request and merge it when CI is green", true, true],
    ["Refactor the parser, then merge the PR", true, true],
    ["Add tests; open a pull request but do not merge it", true, false],
    ["Fix the bug and open a PR for review only — don't merge", true, false],
    ["Make the button blue", false, false],
    // A merge of the CODE is not consent to merge a pull request.
    ["Merge the two config files into one", false, false],
    ["Open a PR and get it merged once CI passes", true, true],
    ["Ship it: open a pull request, auto-merge", true, true],
    ["Update the docs without merging anything", false, false],
    // A negator however far before the merge, in its clause, is a refusal.
    ["Open a PR, do not under any circumstances merge it", true, false],
    ["Open a pull request and never, whatever the checks say, merge it", true, false],
    // …but not one in another clause, nor a word that only starts like one.
    ["Notify the team. Open a PR and merge it when CI is green", true, true],
    // A goal that REFUSES a pull request asks for none (a live team's "Do not
    // open a PR" used to open one).
    ["Build the invoice app. Do not open a PR; leave the work on the branch", false, false],
    ["Add dark mode, no pull request", false, false],
    ["Refactor the parser without a PR", false, false],
    ["Don't open a pull request, I will", false, false],
    ["Do not touch the README. Open a PR when done", true, false],
    // A pull request that already exists, named, is a reference and asks for
    // nothing: a live team's goal failed its finished work on "(PR #14)".
    ["Add a pagination helper that an outside contributor sent in (PR #14), with tests", false, false],
    ["Port the pagination helper sent in PR #14 to the new API", false, false],
    ["Fix the flaky test; see pull request 12 for the history", false, false],
    ["Rework the parser as discussed in https://github.com/acme/site/pull/12", false, false],
    ["Review and merge PR #14", false, false],
    ["The bug came in with PR 9. Fix it", false, false],
    ["Review the open PRs and summarize them in NOTES.md", false, false],
    ["Write the release notes for the PRs merged last week", false, false],
    // …but an ask beside a reference is still an ask.
    ["Build on PR #14 and open a pull request of your own", true, false],
    ["Create a pull request for the fix", true, false],
    ["Send me a PR when it works", true, false],
    ["Raise a draft PR with the change", true, false],
    ["Submit the work as a pull request", true, false],
    ["Fix the bug, then open PRs for each package", true, false],
    ["I need a pull request for this", true, false],
  ])("%s → PR %s, merge %s", (goal, pr, merge) => {
    expect(goalWantsPullRequest(goal)).toBe(pr);
    expect(goalWantsMerge(goal)).toBe(merge);
  });
});

/**
 * A refusal outranks the owner's auto-PR switch (coding-team.ts opens none and
 * says so; a single run skips its branch): a goal that says nothing about pull
 * requests is NOT a refusal, so the switch still decides there.
 */
describe("goalRefusesPullRequest", () => {
  it.each([
    ["Do not open a pull request and do not merge.", true],
    ["Add dark mode, no pull request", true],
    ["Refactor the parser without a PR", true],
    ["Don't open a PR; leave the work on the branch", true],
    ["Build the invoice app and open a PR", false],
    ["Make the button blue", false],
    ["Do not touch the README. Open a PR when done", false],
    ["Merge the two config files into one", false],
  ])("%s → refuses %s", (goal, refuses) => {
    expect(goalRefusesPullRequest(goal)).toBe(refuses);
  });
});
