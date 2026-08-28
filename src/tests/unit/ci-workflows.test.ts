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
