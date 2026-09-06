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
 * direct dependency, and the checks are about lines, not structure. Where a
 * check IS about structure — which job runs a command, what a comment job
 * renders — the text is cut into steps, or the script is executed, rather than
 * matched: a `String.includes` over a whole job once stayed green with the step
 * it guards deleted, because the step's doc comment quoted the command.
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
 * `run: bun run typecheck:mcp || true` each left every case in it green. That
 * is the false-success class inside the guard against it.
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
    // the Test step left every case in the file green.
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

    // Over the job's STEPS, not over its text. `testJob` carries the workflow's
    // COMMENTS, and the lint step's own doc block quotes `bun run lint` in
    // prose — so a plain `includes` stayed GREEN with the whole `Lint
    // (advisory)` step DELETED. Measured: that mutation failed two cases and
    // this, the one case whose whole purpose is to notice a check leaving the
    // job, was not one of them. It is the false-success class the `step()`
    // helper above strips comments for, left in the one case that did not use
    // it.
    //
    // A command counts only where a step RUNS it — its `run:` line or the block
    // scalar under it — so a comment, a step `name:` or an `env:` value does
    // not, and a step moved to a second job leaves this slice entirely.
    //
    // The anchor is the run KEY at line start, not `indexOf("run:")`: a step
    // named `Rerun: …` otherwise anchored the slice inside its own name and
    // handed the whole step to the search. And it is BOUNDED at the next key at
    // the same indentation, because a block scalar's lines are indented deeper
    // while an `env:` or `with:` after `run:` is not — without the bound, a
    // value under `env:` counted as something the step runs. Both measured.
    //
    // Textual, like every other assertion here: a line inside a `run: |` block
    // that itself began `- name:` would forge a step boundary. Cross-checked
    // against a parse of the same file — the split yields exactly one piece per
    // real step, and every anchor lands on a real `run:` key.
    const runsOfEachStep = testJob
      .split("\n").filter((line) => !/^\s*#/.test(line)).join("\n")
      .split(/^ *- (?=name:|uses:|run:)/m).slice(1)
      .map((step) => {
        const key = /^([ \t]*)run:/m.exec(step);
        if (!key) return "";
        const fromRun = step.slice(key.index);
        const next = new RegExp(`^${key[1]}[\\w-]+:`, "m").exec(fromRun.slice(key[0].length));
        return next ? fromRun.slice(0, key[0].length + next.index) : fromRun;
      });

    for (const command of ["bun run typecheck:mcp", "bun run check:mcp-tools", "bun run lint"]) {
      expect(runsOfEachStep.some((body) => body.includes(command)),
        `${command} is not run by any step of the test job`).toBe(true);
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

/**
 * What the three PR-comment jobs actually SAY, by running their own scripts.
 *
 * The sibling case above pins that each comment job stays REACHABLE on a red
 * run (`&& always()`), which is what this PR fixed. `always()` also runs the
 * job while the workflow is being CANCELLED — a state the two-way verdict
 * `result === 'success' ? passed : failed` reports as "failed". Before the
 * `always()` the job was simply skipped on a cancellation and the section kept
 * its previous value, so making it reachable is what makes that sentence
 * reachable: a false failure this PR introduced, over a run that was stopped
 * rather than broken. `pr-tests-coverage.yml` gained a three-state verdict in
 * the same round; the other two are its siblings.
 *
 * Run rather than matched. Every assertion above is a regex over the YAML, and
 * one of them stayed green with the whole step it guards DELETED because the
 * step's own doc comment quoted the command — so a verdict is asserted here by
 * executing the workflow's script against a stubbed `github`/`context` and
 * reading the comment body it would post.
 */
describe("what the PR-comment jobs render", () => {
  /** The comment job's inline `script:` block, dedented out of the YAML. */
  function commentScript(file: string): string {
    const yml = read(`.github/workflows/${file}`);
    const at = yml.indexOf("\n  comment:\n");
    expect(at, `${file} has no comment job`).toBeGreaterThan(-1);
    // Bounded at the end of the comment job. `comment` is the last job in all
    // three files today, but an unbounded search would let a comment job that
    // LOST its inline script silently pick up the next job's instead of failing
    // here.
    const headerEnd = at + "\n  comment:\n".length;
    const after = /^ {2}[\w-]+:$/m.exec(yml.slice(headerEnd));
    const job = after ? yml.slice(at, headerEnd + after.index) : yml.slice(at);
    const scriptAt = job.indexOf("script: |");
    expect(scriptAt, `${file}: the comment job has no inline script`).toBeGreaterThan(-1);
    const rest = job.slice(job.indexOf("\n", scriptAt) + 1).split("\n");
    const indent = rest[0].length - rest[0].trimStart().length;
    const out: string[] = [];
    for (const line of rest) {
      if (line.trim() === "") { out.push(""); continue; }
      if (line.length - line.trimStart().length < indent) break;
      out.push(line.slice(indent));
    }
    return out.join("\n");
  }

  /**
   * The comment body that script would post, for a given `needs.<job>.result`.
   *
   * `existing` is what the workflow found already on the PR: `undefined` takes
   * the CREATE path, a body takes the UPDATE path — and the update path is the
   * one that runs in production on every workflow after the first, and the one
   * the original defect lived in (the section kept its last "✅ passed").
   */
  async function render(file: string, env: Record<string, string>, existing?: string): Promise<string> {
    let posted = "";
    const capture = async ({ body }: { body: string }) => { posted = body; };
    const github = {
      paginate: async () => (existing === undefined ? [] : [{ id: 1, user: { type: "Bot" }, body: existing }]),
      rest: { issues: { listComments: () => undefined, createComment: capture, updateComment: capture } },
    };
    const context = {
      repo: { owner: "ID-Robots", repo: "clawbox" },
      issue: { number: 1 },
      serverUrl: "https://github.com",
      runId: 1,
    };
    // `actions/github-script` also injects `core`, `exec`, `io` and `glob`.
    // They are stubbed rather than left undefined so that adding, say, a
    // `core.summary` line to a comment script makes THAT change fail on its own
    // merits instead of throwing a ReferenceError that blames the verdict logic
    // — a false failure in the guard. A script that wrote its verdict to the
    // summary instead of the comment still fails, on "posted nothing" below.
    const core = new Proxy({}, { get: () => () => undefined });
    const run = new Function("github", "context", "process", "core", "exec", "io", "glob",
      `return (async () => {\n${commentScript(file)}\n})()`);
    await run(github, context, { env }, core, core, core, core);
    expect(posted, `${file}: the comment job posted nothing`).not.toBe("");
    return posted;
  }

  /** One rendered section: its icon, its `Result:` verdict, and its whole text. */
  function sectionOf(body: string, heading: string) {
    const at = body.search(new RegExp(`^## \\S+ ${heading}$`, "m"));
    expect(at, `no "${heading}" section in the rendered comment`).toBeGreaterThan(-1);
    const rest = body.slice(at);
    const end = rest.indexOf("\n<!--");
    const text = end === -1 ? rest : rest.slice(0, end);
    return {
      text,
      icon: text.match(new RegExp(`^## (\\S+) ${heading}$`, "m"))?.[1] ?? "",
      verdict: text.match(/^- Result: \*\*(.+)\*\*$/m)?.[1] ?? "",
    };
  }

  // The env var that carries the outcome, and the section heading.
  const JOBS: [string, string, string][] = [
    ["pr-tests-coverage.yml", "SUITE_OUTCOME", "Tests"],
    ["e2e-tests.yml", "E2E_RESULT", "E2E"],
    ["e2e-install.yml", "E2E_INSTALL_RESULT", "E2E Install"],
  ];

  /**
   * The environment a real run of that comment job would have.
   *
   * `pr-tests-coverage.yml` reads TWO variables — the suite step's outcome and
   * the job's result — and `needs.test.result` is ALWAYS set in a real run.
   * Leaving it out rendered a square production cannot produce, and that is
   * what hid a live false success in the pair of sentences below the verdict.
   */
  const envFor = (key: string, outcome: string): Record<string, string> =>
    key === "SUITE_OUTCOME" ? { SUITE_OUTCOME: outcome, TEST_RESULT: outcome } : { [key]: outcome };

  it.each(JOBS)("%s renders a verdict for a run that passed and for one that failed", async (file, key, heading) => {
    const passed = sectionOf(await render(file, envFor(key, "success")), heading);
    expect(passed.icon).toBe("✅");
    expect(passed.verdict).toMatch(/^(passed|success)$/);
    const failed = sectionOf(await render(file, envFor(key, "failure")), heading);
    expect(failed.icon).toBe("❌");
    expect(failed.verdict).toMatch(/^(failed|failure)$/);
  });

  it.each(JOBS)("%s does not call a cancelled run a failure", async (file, key, heading) => {
    // `always()` runs the comment job during a cancellation too. A two-state
    // verdict then overwrites the section with "failed" — a claim that the
    // suite broke, about a run that was STOPPED, by the 30-minute timeout
    // TASK-702 added or by a person. Before the `always()` this job was simply
    // skipped on a cancellation and the section kept its previous value, so
    // making it reachable is what makes the false failure reachable.
    const s = sectionOf(await render(file, envFor(key, "cancelled")), heading);
    expect(s.verdict, "a cancelled run is reported as a failure").not.toMatch(/^(failed|failure)$/);
    expect(s.icon, "a cancelled run carries the failure icon").not.toBe("❌");
    // And it says so, rather than going quiet about which of the two it was.
    expect(s.text.toLowerCase()).toContain("cancel");
  });

  it("never says the suite passed when it failed", async () => {
    // The two sentences below the verdict are about a suite that REPORTED, and
    // they used to fire on either outcome. `SUITE_OUTCOME=failure` with
    // `TEST_RESULT=cancelled` therefore rendered "❌ Tests — Result: failed"
    // followed by "The suite passed, then the run was cancelled" — two
    // contradictory claims, the second of them a false success, in the square a
    // reader reaches by cancelling the run on seeing the suite go red. Lint
    // (advisory) and Parse coverage keep the job alive for about two minutes
    // after the failure, so that window is the normal one.
    const s = sectionOf(await render("pr-tests-coverage.yml", { SUITE_OUTCOME: "failure", TEST_RESULT: "cancelled" }), "Tests");
    expect(s.verdict).toBe("failed");
    expect(s.text, "a failed suite is reported as having passed").not.toContain("The suite passed");
    expect(s.text.toLowerCase()).toContain("cancel");
    // The same conflation in the other sentence: over a failed suite, "even
    // though the suite did" contradicts the verdict one line above it.
    const bothFailed = sectionOf(await render("pr-tests-coverage.yml", { SUITE_OUTCOME: "failure", TEST_RESULT: "failure" }), "Tests");
    expect(bothFailed.verdict).toBe("failed");
    expect(bothFailed.text, "a failed suite is credited with having passed").not.toContain("even though the suite did");
  });

  it.each(JOBS)("%s updates its own section in place and leaves its siblings alone", async (file, key, heading) => {
    // The CREATE path is what every case above exercises, because `paginate`
    // returns nothing. The UPDATE path is the one that runs on every workflow
    // after the first — and the one the original defect lived in, where the
    // section kept its last "✅ passed" because the job never ran to replace
    // it. A verdict that renders correctly and then splices into the wrong
    // marker is the same stale sentence by another route.
    const existing = await render(file, envFor(key, "success"));
    const updated = await render(file, envFor(key, "failure"), existing);
    expect(sectionOf(updated, heading).verdict).toMatch(/^(failed|failure)$/);
    // Exactly one section for this job, and every other section carried over
    // untouched.
    expect(updated.match(new RegExp(`^## \\S+ ${heading}$`, "gm"))).toHaveLength(1);
    for (const other of ["Tests", "E2E", "E2E Install"].filter((h) => h !== heading)) {
      const before = existing.match(new RegExp(`^## \\S+ ${other}$`, "m"));
      if (before) expect(updated).toContain(before[0]);
    }
  });

  it("gives the two E2E comments the same icon for the same result", async () => {
    // They are the same sentence about two suites and sit in the same PR
    // comment, so a reader comparing them should not have to decide whether ⏹️
    // and ⏭️ mean different things. Relational rather than a table of emoji:
    // the pair has to move together, and neither is pinned to a literal.
    for (const result of ["success", "failure", "cancelled", "skipped"]) {
      const tests = sectionOf(await render("e2e-tests.yml", { E2E_RESULT: result }), "E2E");
      const install = sectionOf(await render("e2e-install.yml", { E2E_INSTALL_RESULT: result }), "E2E Install");
      expect(install.icon, `the two E2E comments disagree on the icon for a ${result} run`).toBe(tests.icon);
    }
  });

  it("does not blame a later step when the run that passed was cancelled", async () => {
    // pr-tests-coverage.yml alone reports two facts: the SUITE's verdict and
    // the JOB's. The second sentence is reached whenever `needs.test.result` is
    // not `success`, and `always()` reaches this job during a cancellation too
    // — so a suite that passed before the run was stopped was told to the
    // reader as "a later step in it failed", the sibling of the E2E false
    // failure above.
    const body = await render("pr-tests-coverage.yml", { SUITE_OUTCOME: "success", TEST_RESULT: "cancelled" });
    const s = sectionOf(body, "Tests");
    expect(s.verdict).toBe("passed");
    expect(s.text, "a cancelled run is blamed on a later step").not.toContain("a later step in it failed");
    expect(s.text.toLowerCase()).toContain("cancel");
    // …and the real case it exists for still reads that way.
    const stepFailed = sectionOf(await render("pr-tests-coverage.yml", { SUITE_OUTCOME: "success", TEST_RESULT: "failure" }), "Tests");
    expect(stepFailed.text).toContain("a later step in it failed");
  });

  it.each(JOBS)("%s does not call a skipped run a failure either", async (file, key, heading) => {
    // The other non-verdict `always()` lets through: `needs.<job>.result` is
    // `skipped` when the job it reports on never ran at all.
    const s = sectionOf(await render(file, envFor(key, "skipped")), heading);
    expect(s.verdict, "a skipped run is reported as a failure").not.toMatch(/^(failed|failure)$/);
    expect(s.icon, "a skipped run carries the failure icon").not.toBe("❌");
  });
});

/**
 * Repository secrets on a pull_request run.
 *
 * e2e-install.yml checks out the PR HEAD on a `pull_request` event and then
 * runs that head's playwright.config.ts, global-setup.ts and specs on the
 * host. Its "Write .env.test" step used to run unconditionally, putting
 * `secrets.CLAWBOX_AI_API_KEY` and `secrets.TELEGRAM_BOT_TOKEN` in a file
 * beside code the PR controls — so a same-repo branch (a fork never gets the
 * secrets on this trigger) could read the file and send it anywhere. The
 * updater spec reads CLAWBOX_UPGRADE_TARGET_BRANCH from process.env, and
 * both `loadEnvTest()` helpers answer `{}` when the file is absent, so the
 * whole step is gated rather than split.
 *
 * This is hygiene, not the fence: the PR head supplies the workflow file too,
 * so the secrets also have to leave repository scope (a GitHub Environment
 * restricted to beta/main) — a settings change no test here can see.
 */
describe("secrets never reach a pull_request run", () => {
  const yml = read(".github/workflows/e2e-install.yml");
  // Comments removed first — the step's own doc comment quotes `secrets` and
  // the pattern, and must satisfy nothing. Then the file cut into steps, the
  // PREAMBLE kept: the workflow-level and job-level `env:` blocks sit before
  // the first step, and a `secrets.X` moved into the job's env would be
  // inherited by the suite step — the exact regression a step-only walk
  // could not see.
  const text = yml.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  const [preamble, ...steps] = text.split(/^ *- (?=name:|uses:|run:)/m);
  const stepName = (step: string) => /^name: (.*)$/m.exec(step)?.[1] ?? step.split("\n")[0];
  // `secrets.GITHUB_TOKEN` is the per-run token GitHub scopes itself — read-
  // only on a fork PR, harmless on any pull_request — and not the class this
  // guard is about. (Convention in this file is `github.token`; a step that
  // names it through `secrets.` is exempt here rather than failed over it.)
  const SECRET = /secrets\.(?!GITHUB_TOKEN\b)/;
  const gated = (step: string) => /^\s+if:.*github\.event_name != 'pull_request'/m.test(step);
  const count = (s: string) => (s.match(new RegExp(SECRET.source, "g")) ?? []).length;

  it("gates every step that reads a secret on the event not being a pull_request", () => {
    const withSecrets = steps.filter((step) => SECRET.test(step));
    expect(withSecrets.length, "no step reads a secret — the guard has nothing to guard").toBeGreaterThan(0);
    for (const step of withSecrets) {
      expect(gated(step), `step "${stepName(step)}" reads a secret and can run on a pull_request`).toBe(true);
    }
  });

  it("keeps every secret inside a gated step — none in the workflow or job env", () => {
    expect(preamble, "a secret is read outside every step (a workflow- or job-level env), where the suite step inherits it")
      .not.toMatch(SECRET);
    // Every occurrence in the file is accounted for by a gated step: a secret
    // that reached a step this splitter does not recognise would show here.
    const inGatedSteps = steps.filter(gated).reduce((n, step) => n + count(step), 0);
    expect(count(text), "a secret is read somewhere no gated step covers").toBe(inGatedSteps);
  });

  it("runs the PR head's playwright suite in a step that reads no secret", () => {
    const suite = steps.filter((step) => step.includes("playwright test --config e2e-install/playwright.config.ts"));
    expect(suite.length, "the e2e-install suite step is gone").toBe(1);
    expect(suite[0], "the suite step, which executes PR-controlled code, reads a secret").not.toMatch(SECRET);
  });

  it("does not hand a fork's PR the secrets through pull_request_target either", () => {
    expect(yml).not.toMatch(/^\s+pull_request_target:/m);
  });
});

/**
 * The fence itself: a GitHub Environment.
 *
 * The step-level `if:` above is hygiene — on a `pull_request` event the PR
 * head supplies the workflow file, so a same-repo branch can simply delete
 * the gate. What a branch cannot edit is an Environment's deployment-branch
 * policy. The one `e2e-install` job (a credentialed twin would repeat every
 * step, and a caller job that `uses:` a reusable workflow cannot set an
 * Environment — only the called workflow's own jobs can) names its
 * Environment by event: `e2e-credentials`, restricted to beta and main,
 * for the schedule and a dispatch; a secretless one for a pull_request. The
 * policy is a settings change no test can see; what this pins is that the
 * workflow ASKS for it, and never asks for the credentialed one on a PR.
 */
describe("credentialed e2e-install runs are bound to a protected Environment", () => {
  const yml = read(".github/workflows/e2e-install.yml");
  const text = yml.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  // The e2e-install job alone: from its key to the next job key at the same
  // indent. `environment:` has to be the JOB's, not a step's `with:` or a
  // job further down.
  const jobStart = text.indexOf("\n  e2e-install:\n");
  const jobEnd = text.indexOf("\n  comment:\n", jobStart);
  const job = text.slice(jobStart, jobEnd);
  const [preamble] = job.split(/^ *- (?=name:|uses:|run:)/m);
  const ENVIRONMENT = /^ {4}environment: \$\{\{\s*github\.event_name == 'pull_request' && '([^']+)' \|\| '([^']+)'\s*\}\}$/m;

  it("declares a job-level environment chosen by the event", () => {
    expect(jobStart, "the e2e-install job is gone").toBeGreaterThan(-1);
    expect(jobEnd, "the comment job is gone").toBeGreaterThan(jobStart);
    expect(preamble, "the e2e-install job declares no job-level `environment:`").toMatch(ENVIRONMENT);
    // Only one — a second declaration would be a YAML duplicate key, and
    // which one GitHub honours is not something to find out on a PR.
    expect(job.match(/^ {4}environment:/gm)?.length).toBe(1);
  });

  it("names e2e-credentials for every run that is not a pull_request", () => {
    const [, onPullRequest, otherwise] = ENVIRONMENT.exec(preamble) ?? [];
    expect(otherwise, "the schedule and a dispatch must run in the protected Environment").toBe("e2e-credentials");
    expect(onPullRequest, "a pull_request run must not name the credentialed Environment").not.toBe("e2e-credentials");
    expect(onPullRequest, "the pull_request Environment has no name").toBeTruthy();
  });

  it("pins the pull_request Environment name and its README entry", () => {
    // The name is a reservation the owner creates empty; the README is where
    // they learn that, so the two are pinned together.
    const [, onPullRequest] = ENVIRONMENT.exec(preamble) ?? [];
    expect(onPullRequest).toBe("e2e-pull-request");
    expect(read("e2e-install/README.md"), "the README does not document the two Environment names for the owner")
      .toMatch(/`e2e-pull-request`[\s\S]*`e2e-credentials`/);
  });

  it("keeps the pull_request gate on the step that writes the secrets, as hygiene", () => {
    const steps = job.split(/^ *- (?=name:|uses:|run:)/m).slice(1);
    const writer = steps.find((step) => /^name: Write \.env\.test$/m.test(step));
    expect(writer, "the Write .env.test step is gone").toBeDefined();
    expect(writer, "the secret-writing step lost its pull_request gate").toMatch(/^\s+if:.*github\.event_name != 'pull_request'/m);
  });

  it("leaves the comment job reading the e2e-install verdict", () => {
    // The PR comment reports the job by name; a rename of the job to carry
    // the environment would silently detach it.
    const comment = text.slice(jobEnd);
    expect(comment).toMatch(/^\s+needs: e2e-install$/m);
    expect(comment).toContain("needs.e2e-install.result");
  });
});
