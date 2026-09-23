import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  planShards,
  shardFilter,
  SHARDS,
  UPGRADE_PREREQUISITES,
  UPGRADE_SPEC,
} from "../../../e2e-install/shards";

// Every case here runs a real bash (or bun) over the workflows' own scripts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * The CI sharding (TASK-1127): the vitest suite split four ways and merged,
 * and the e2e-install suite split into a `core` shard every PR runs and an
 * `upgrade` shard planned from the PR's changed files.
 *
 * Both splits put the verdict in a job of its own that the others report
 * into, and both have the same two ways to fail silently: a part that did not
 * run being read as a part that passed, and a verdict job that is SKIPPED —
 * which branch protection reads as success. So the workflows' own bash is
 * executed here rather than matched: a regex over YAML stays green over a
 * script that exits 0 on every path.
 */

const REPO = path.resolve(__dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf-8");

/** One job of a workflow, from its key to the next two-space key. */
function job(yml: string, key: string): string {
  const jobsAt = yml.indexOf("\njobs:\n");
  const headers = [...yml.slice(jobsAt).matchAll(/^ {2}([\w-]+):$/gm)];
  const at = headers.findIndex((h) => h[1] === key);
  expect(at, `no \`${key}\` job`).toBeGreaterThan(-1);
  const next = headers[at + 1];
  return yml.slice(jobsAt + headers[at].index!, next ? jobsAt + next.index! : yml.length);
}

/** The job-level keys of a job: everything before its `steps:`. */
const header = (jobText: string) => jobText.slice(0, jobText.indexOf("    steps:"));

/** The `run: |` block of the step with that name, dedented. */
function runBlock(text: string, stepName: string): string {
  const at = text.indexOf(`- name: ${stepName}\n`);
  expect(at, `no step named "${stepName}"`).toBeGreaterThan(-1);
  const runAt = text.indexOf("run: |\n", at);
  const nextStep = text.indexOf("\n      - ", at + 1);
  expect(runAt, `"${stepName}" has no run block`).toBeGreaterThan(-1);
  if (nextStep !== -1) expect(runAt).toBeLessThan(nextStep);
  const lines = text.slice(runAt + "run: |\n".length).split("\n");
  const indent = lines[0].length - lines[0].trimStart().length;
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") { out.push(""); continue; }
    if (line.length - line.trimStart().length < indent) break;
    out.push(line.slice(indent));
  }
  return out.join("\n");
}

/** Run a bash script; the exit status and everything it printed. */
function bash(script: string, env: Record<string, string>, cwd = REPO): { status: number; out: string } {
  try {
    const out = execFileSync("bash", ["-c", script], {
      // Only what the script is given, so nothing from the runner's own
      // environment (a GITHUB_OUTPUT, a CHANGED_FILES) can answer for it.
      cwd, env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env }, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ci-shards-")); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("the vitest shards", () => {
  const tests = read(".github/workflows/pr-tests-coverage.yml");
  const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;

  describe("scripts/check-vitest-shards.sh — nothing merged unless every shard reported", () => {
    function check(files: string[]): { status: number; out: string } {
      const dir = fs.mkdtempSync(path.join(tmp, "blobs-"));
      for (const f of files) fs.writeFileSync(path.join(dir, f), "[]");
      return bash(`bash scripts/check-vitest-shards.sh "${dir}"`, {});
    }

    it("accepts a complete set, however many shards it was", () => {
      expect(check(["blob-1-4.json", "blob-2-4.json", "blob-3-4.json", "blob-4-4.json"]).status).toBe(0);
      expect(check(["blob-1-1.json"]).status).toBe(0);
    });

    it("refuses a set with a shard missing, and names it", () => {
      const r = check(["blob-1-4.json", "blob-2-4.json", "blob-4-4.json"]);
      expect(r.status).not.toBe(0);
      expect(r.out).toContain("3/4");
    });

    it("refuses nothing at all — no shard reported", () => {
      expect(check([]).status).not.toBe(0);
      expect(bash(`bash scripts/check-vitest-shards.sh "${path.join(tmp, "absent")}"`, {}).status).not.toBe(0);
    });

    it("refuses blobs from runs of different shard counts", () => {
      // A complete 1..2 beside a stray 1-4 is not a complete set of anything.
      expect(check(["blob-1-2.json", "blob-2-2.json", "blob-1-4.json"]).status).not.toBe(0);
    });

    it("refuses any other file, because the merge would read it as a blob", () => {
      expect(check(["blob-1-1.json", "notes.txt"]).status).not.toBe(0);
      expect(check(["blob-1-1.json", ".hidden"]).status).not.toBe(0);
    });
  });

  it("each shard runs the CI script with the blob reporter and the thresholds off — and nothing else", () => {
    // Anything more (a filter, --passWithNoTests, a narrower project) would
    // make the merged suite smaller than `bun run test:coverage` at a checkout
    // while every shard stayed green.
    const ci = scripts["test:coverage:ci"];
    const shard = scripts["test:coverage:shard"];
    expect(shard.startsWith(`${ci} `)).toBe(true);
    expect(shard.slice(ci.length).trim().split(/\s+/).sort()).toEqual([
      "--coverage.thresholds.branches=0",
      "--coverage.thresholds.functions=0",
      "--coverage.thresholds.lines=0",
      "--coverage.thresholds.statements=0",
      "--reporter=blob",
      "--reporter=default",
    ]);
  });

  it("the merge is the CI script over the shards' reports, so the config's thresholds apply to it", () => {
    // Exactly this: no threshold override can ride along, so the zeros above
    // stop at the shards and the gate is vitest.config.ts's, once, over the
    // merged coverage.
    expect(scripts["test:coverage:merge"]).toBe(`${scripts["test:coverage:ci"]} --merge-reports`);
    expect(read("vitest.config.ts")).toMatch(/thresholds: \{\s*statements: [1-9]/);
  });

  it("splits by the matrix's own size, so the matrix and the split cannot disagree", () => {
    const shard = job(tests, "shard");
    expect(shard).toMatch(/^\s+run: bun run test:coverage:shard --shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}$/m);
    const list = /^\s+shard: \[([\d, ]+)\]$/m.exec(shard)?.[1].split(",").map((n) => Number(n.trim()));
    expect(list, "the shard matrix is not a literal list").toBeDefined();
    expect(list).toEqual(list!.map((_, i) => i + 1));
    expect(list!.length).toBeGreaterThan(1);
    expect(shard).toMatch(/^\s+fail-fast: false$/m);
  });

  it("hands every shard's report to the merge, and checks the set before merging", () => {
    const shard = job(tests, "shard");
    expect(shard).toMatch(/name: vitest-blob-\$\{\{ matrix\.shard \}\}/);
    expect(shard).toMatch(/path: \.vitest-reports\//);
    // .vitest-reports is a dot-directory: upload-artifact v4 leaves it out
    // without this and the merge finds nothing.
    expect(shard).toMatch(/include-hidden-files: true/);
    const verdict = job(tests, "test");
    expect(verdict).toMatch(/pattern: vitest-blob-\*/);
    expect(verdict).toMatch(/merge-multiple: true/);
    const checkAt = verdict.indexOf("run: bash scripts/check-vitest-shards.sh .vitest-reports");
    const mergeAt = verdict.indexOf("run: bun run test:coverage:merge");
    expect(checkAt).toBeGreaterThan(-1);
    expect(mergeAt).toBeGreaterThan(checkAt);
  });

  it("the `test` verdict waits for every job, is never skipped, and fails unless they all passed", () => {
    const verdict = job(tests, "test");
    expect(header(verdict)).toMatch(/^ {4}needs: \[checks, shard\]$/m);
    expect(header(verdict)).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) \}\}$/m);
    const script = runBlock(verdict, "The checks and every shard passed");
    const results = ["success", "failure", "cancelled", "skipped"];
    for (const checks of results) {
      for (const shards of results) {
        const { status } = bash(script, { CHECKS_RESULT: checks, SHARD_RESULT: shards });
        expect(status === 0, `checks=${checks} shards=${shards} exited ${status}`).toBe(checks === "success" && shards === "success");
      }
    }
  });
});

describe("the e2e-install shards", () => {
  const yml = read(".github/workflows/e2e-install.yml");
  const specs = fs.readdirSync(path.join(REPO, "e2e-install")).filter((f) => f.endsWith(".spec.ts")).sort();

  /** The specs a shard selects, the way Playwright applies testMatch/testIgnore to absolute paths. */
  function selected(shard: string | undefined): string[] {
    const { testMatch, testIgnore } = shardFilter(shard);
    const any = (res: RegExp | RegExp[] | undefined, p: string) =>
      res !== undefined && [res].flat().some((re) => re.test(p));
    return specs.filter((f) => {
      const abs = path.join(REPO, "e2e-install", f);
      return any(testMatch, abs) && !any(testIgnore, abs);
    });
  }

  it("names specs that exist", () => {
    expect(specs.length).toBeGreaterThan(10);
    for (const f of [UPGRADE_SPEC, ...UPGRADE_PREREQUISITES]) expect(specs).toContain(f);
  });

  it("runs every spec, once each, across core and upgrade — and all of them with no shard set", () => {
    expect(selected(undefined)).toEqual(specs);
    expect(selected("core")).toEqual(specs.filter((f) => f !== UPGRADE_SPEC));
    expect(selected("upgrade")).toEqual([...UPGRADE_PREREQUISITES, UPGRADE_SPEC].sort());
    // Nothing falls between the shards: every spec is in at least one.
    const covered = new Set(SHARDS.flatMap((s) => selected(s)));
    expect([...covered].sort()).toEqual(specs);
  });

  it("keeps the reboot on every PR", () => {
    // It needs only the wizard's state, and since the owner-session fix it
    // takes seconds, so it rides in `core` rather than behind the path gate.
    expect(selected("core")).toContain("99-power.spec.ts");
  });

  it("throws on a shard name it does not know, rather than running the wrong suite", () => {
    expect(() => shardFilter("upgrdae")).toThrow(/not a shard/);
  });

  it("plans every shard when the changed files are unknown", () => {
    expect(planShards(null).shards).toEqual([...SHARDS]);
  });

  it("plans the upgrade shard for the paths the upgrade depends on", () => {
    for (const p of [
      "install.sh", "install-x64.sh", "scripts/root-update-step.sh", "config/clawbox-setup.service",
      "package.json", "bun.lock", "next.config.ts", "production-server.js", "src/instrumentation.ts",
      "src/instrumentation-node.ts", "src/lib/updater.ts", "src/lib/updater-handover.ts", "src/lib/update-lock.ts",
      "src/lib/root-steps.ts", "src/lib/config-store.ts", "src/app/setup-api/update/run/route.ts",
      "src/app/setup-api/setup/status/route.ts", "src/app/setup-api/system/update-branch/route.ts",
      "e2e-install/Dockerfile", ".github/workflows/e2e-install.yml",
    ]) {
      const plan = planShards(["README.md", p]);
      expect(plan.shards, p).toEqual([...SHARDS]);
      expect(plan.because).toEqual([p]);
    }
  });

  it("plans core alone for the rest", () => {
    for (const p of [
      "README.md", "src/components/chat.tsx", "src/lib/coding-team.ts", "src/lib/updaterish/x.ts",
      "src/app/setup-api/system/power/route.ts", "src/tests/unit/updater.test.ts", "docs/install.md",
      ".github/workflows/pr-tests-coverage.yml", "mcp/clawbox-mcp.ts",
    ]) {
      expect(planShards([p]).shards, p).toEqual(["core"]);
    }
    expect(planShards([]).shards).toEqual(["core"]);
  });

  it("feeds the plan to the matrix, and the shard to the Playwright config", () => {
    const shards = job(yml, "e2e-install");
    expect(header(shards)).toMatch(/^ {4}needs: plan$/m);
    expect(header(shards)).toMatch(/^ {8}shard: \$\{\{ fromJSON\(needs\.plan\.outputs\.shards\) \}\}$/m);
    expect(header(shards)).toMatch(/^ {6}CLAWBOX_E2E_SHARD: \$\{\{ matrix\.shard \}\}$/m);
    expect(read("e2e-install/playwright.config.ts")).toMatch(/\.\.\.shardFilter\(process\.env\.CLAWBOX_E2E_SHARD\)/);
  });

  describe("the plan step", () => {
    const script = runBlock(job(yml, "plan"), "Plan the shards");

    /** Run the step with a stub `gh` that prints `files` (or fails), and read its output. */
    function plan(env: Record<string, string>, files: string[] | "fail"): { status: number; shards: string } {
      const dir = fs.mkdtempSync(path.join(tmp, "plan-"));
      const bin = path.join(dir, "bin");
      fs.mkdirSync(bin);
      const tsv = path.join(dir, "files.tsv");
      fs.writeFileSync(tsv, files === "fail" ? "" : files.map((f) => `${f}\n`).join(""));
      fs.writeFileSync(path.join(bin, "gh"), files === "fail" ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\ncat "${tsv}"\n`, { mode: 0o755 });
      const output = path.join(dir, "output");
      const r = bash(script, {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
        RUNNER_TEMP: dir,
        REPO: "ID-Robots/clawbox",
        PR_NUMBER: "1",
        ...env,
      });
      const shards = fs.existsSync(output) ? /^shards=(.*)$/m.exec(fs.readFileSync(output, "utf-8"))?.[1] ?? "" : "";
      return { status: r.status, shards };
    }
    const ALL = JSON.stringify([...SHARDS]);

    it("plans every shard for a schedule or a dispatch", () => {
      expect(plan({ EVENT: "schedule" }, "fail")).toEqual({ status: 0, shards: ALL });
      expect(plan({ EVENT: "workflow_dispatch" }, "fail")).toEqual({ status: 0, shards: ALL });
    });

    it("plans from the PR's files", () => {
      expect(plan({ EVENT: "pull_request", CHANGED_FILES: "2" }, ["README.md", "src/lib/coding-team.ts"]))
        .toEqual({ status: 0, shards: '["core"]' });
      expect(plan({ EVENT: "pull_request", CHANGED_FILES: "2" }, ["README.md", "install.sh"]))
        .toEqual({ status: 0, shards: ALL });
    });

    it("counts a rename under its old name too", () => {
      // One file entry, two names: moved OUT of a gated path.
      expect(plan({ EVENT: "pull_request", CHANGED_FILES: "1" }, ["docs/old-updater-notes.md\tsrc/lib/updater-notes.ts"]))
        .toEqual({ status: 0, shards: ALL });
    });

    it("plans every shard when the file list cannot be trusted", () => {
      // The API failed…
      expect(plan({ EVENT: "pull_request", CHANGED_FILES: "1" }, "fail")).toEqual({ status: 0, shards: ALL });
      // …listed fewer files than the PR has (it stops at 3000)…
      expect(plan({ EVENT: "pull_request", CHANGED_FILES: "3" }, ["README.md", "docs/a.md"])).toEqual({ status: 0, shards: ALL });
      // …or the PR's own count is missing.
      expect(plan({ EVENT: "pull_request", CHANGED_FILES: "" }, ["README.md"])).toEqual({ status: 0, shards: ALL });
    });
  });

  it("the `e2e-install` check is the verdict: never skipped, and red unless the plan and every shard passed", () => {
    const verdict = job(yml, "verdict");
    // The name branch protection requires. The shards report under
    // `e2e-install (<shard>)`, which no rule names.
    expect(header(verdict)).toMatch(/^ {4}name: e2e-install$/m);
    expect(header(verdict)).toMatch(/^ {4}needs: \[plan, e2e-install\]$/m);
    expect(header(verdict)).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) \}\}$/m);
    expect(header(job(yml, "e2e-install"))).toMatch(/^ {4}name: e2e-install \(\$\{\{ matrix\.shard \}\}\)$/m);
    const script = runBlock(verdict, "Every planned shard passed");
    const results = ["success", "failure", "cancelled", "skipped"];
    for (const planned of results) {
      for (const shards of results) {
        const { status } = bash(script, {
          PLAN_RESULT: planned, SHARD_RESULT: shards, SHARDS: '["core"]', GITHUB_OUTPUT: path.join(tmp, "verdict-output"),
        });
        expect(status === 0, `plan=${planned} shards=${shards} exited ${status}`).toBe(planned === "success" && shards === "success");
      }
    }
  });

  it("plan-shards.ts prints the plan as the matrix reads it", () => {
    const run = (args: string[], input: string) =>
      execFileSync("bun", ["e2e-install/plan-shards.ts", ...args], { cwd: REPO, input, encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    expect(run(["--all"], "")).toBe(JSON.stringify([...SHARDS]));
    expect(run([], "README.md\nsrc/components/chat.tsx\n")).toBe('["core"]');
    expect(run([], "README.md\nscripts/force-update.sh\n")).toBe(JSON.stringify([...SHARDS]));
  });
});
