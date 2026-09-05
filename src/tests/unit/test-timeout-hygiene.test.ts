import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Vitest's defaults are 5 000 ms per test and 10 000 ms per hook, and both are
 * too tight for a test that runs REAL processes on a loaded CI runner.
 *
 * Measured (TASK-702): `startRunBranch` (src/lib/coding-pr.ts) runs six real
 * `git`/`gh` processes in series inside one case. Locally the first case in the
 * file takes ~470 ms; on a four-worker `ubuntu-latest` runner under v8 coverage
 * it inflates past 1 500 ms and the series crosses 5 s. The failure lands on a
 * file the PR did not touch — `coding-agent-spawn-failure.test.ts`,
 * `hermes-oauth-inline.test.tsx`, `capabilities-parallel.test.ts` and
 * `chat-spoken-reply.test.tsx` were all seen on 2026-09-03, and
 * `hermes-config-lock.test.ts` + `hermes-dashboard-auth-yaml.test.ts` on
 * 2026-09-04 — so it reads as an unrelated regression and costs a re-run.
 *
 * BOTH ceilings, not just the test one: `vi.setConfig({ testTimeout })` leaves
 * `hookTimeout` at 10 s, and several of these files do their process work in a
 * `beforeEach` — `updater-branch-resolution.test.ts` runs eleven real gits
 * there before every case. Raising only the test ceiling would have left the
 * dominant cost unguarded under a comment claiming it was fixed.
 *
 * The fix is NOT to widen the global defaults: 5 s is a useful guard against a
 * unit test that has genuinely hung, and every file that keeps it keeps that
 * guard. It is to declare the ceilings in the files that legitimately need
 * them. Mocking `git`/`gh` is not the fix either — in these files the real
 * process IS the thing under test.
 *
 * This is the guard that keeps it true for files added later.
 */

const REPO = path.resolve(__dirname, "../../..");
const ROOT = path.join(REPO, "src", "tests");
const rel = (p: string) => path.relative(REPO, p).split(path.sep).join("/");

/**
 * Comments blanked, length and newlines preserved. Strings are WALKED but kept.
 *
 * Every pattern below is read against this rather than the raw file: a
 * `vi.mock("child_process")` written inside a comment would otherwise EXCLUDE a
 * real-process test, and a commented-out `vi.setConfig` would satisfy the
 * declaration rule — both the direction that loses the guard rather than the
 * one that over-reports.
 *
 * Strings are kept because the facts this reads LIVE in them: the module
 * specifier of `from "child_process"` is a string, and blanking it would make
 * every file look like it starts no process at all. They are still walked, so a
 * `//` inside a URL cannot be mistaken for the start of a comment.
 */
function code(source: string): string {
  const out = source.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      blank(i, end < 0 ? source.length : end);
      i = end < 0 ? source.length : end;
    } else if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      blank(i, end < 0 ? source.length : end + 2);
      i = end < 0 ? source.length : end + 2;
    } else if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length && source[j] !== quote) j += source[j] === "\\" ? 2 : 1;
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/**
 * A real process is started only through a `child_process` import.
 *
 * Matching the bare call names would count `RE.exec(s)`, a local helper named
 * `spawn`, and every `execFileSync` that is a mock's own type annotation. The
 * import is the fact that decides it — and the NAMES it binds are what the
 * call has to use, so `import { execFileSync as run }` is followed through to
 * `run(` rather than missed.
 */
const CHILD_PROCESS_IMPORT = new RegExp(
  [
    // ESM: `import * as cp from`, `import { a, b as c } from`, `import cp from`
    String.raw`import\s+(?:\*\s+as\s+(?<esmNs>\w+)|\{(?<esmNamed>[^}]*)\}|(?<esmDefault>\w+))\s+from\s+["'](?:node:)?child_process["']`,
    // CJS: `const { a, b: c } = require(...)`, `const cp = require(...)`
    String.raw`(?:const|let|var)\s+(?:\{(?<cjsNamed>[^}]*)\}|(?<cjsNs>\w+))\s*=\s*require\(\s*["'](?:node:)?child_process["']\s*\)`,
  ].join("|"),
  "g",
);
const STARTERS = ["spawnSync", "execFileSync", "execSync", "spawn", "execFile", "fork", "exec"];

/**
 * …and the one form that binds no name at all:
 * `require("child_process").execSync(…)`. `processStarters` has nothing to
 * follow there, so this pattern decides on its own — it already contains the
 * CALL, which is why it can afford to name the starters directly where the
 * bare-name matching the rule above rejects (`RE.exec(s)`, a local helper
 * called `spawn`, a mock's type annotation) cannot reach it.
 *
 * No file in the tree writes this form today, so the real-tree assertions
 * below would pass whether or not it were detected. It is covered by a case of
 * its own for exactly that reason.
 */
const CHILD_PROCESS_DIRECT_CALL = new RegExp(
  String.raw`require\(\s*["'](?:node:)?child_process["']\s*\)\s*\.\s*(?:`
    + STARTERS.join("|")
    + String.raw`)\s*\(`,
);

/** The local names this file can start a process through, or an empty list. */
function processStarters(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(CHILD_PROCESS_IMPORT)) {
    // NAMED groups, not indices: the two alternatives above number their
    // captures differently, and reading the wrong one silently drops a file
    // out of the check — which is the direction that loses the guard.
    const g = m.groups ?? {};
    const namespace = g.esmNs || g.cjsNs || g.esmDefault;
    if (namespace) {
      // `import * as cp` / `const cp = require(...)` / a default import: any
      // starter reached off the module object.
      for (const starter of STARTERS) names.push(`${namespace}.${starter}`);
      continue;
    }
    const named = g.esmNamed || g.cjsNamed;
    if (named) {
      for (const spec of named.split(",")) {
        // `execFileSync as run` in ESM, `execFileSync: run` in CJS.
        const [original, alias] = spec.split(/\s+as\s+|:/).map((x) => x.trim());
        if (STARTERS.includes(original)) names.push(alias || original);
      }
    }
  }
  return names;
}

/** …and one of those bindings is actually called. Async forms included: a test
 * that spawns and awaits is in the same flake class as one that blocks —
 * `run-tunnel.test.ts` polls for up to 5 000 ms on the wait alone. */
function startsAProcess(source: string): boolean {
  if (CHILD_PROCESS_DIRECT_CALL.test(source)) return true;
  return processStarters(source).some((name) =>
    new RegExp(`(?<![\\w.])${name.replace(".", "\\.")}\\s*\\(`).test(source));
}

/**
 * …unless the module is mocked WHOLLY, in which case nothing is spawned.
 *
 * A partial mock does not count, and that distinction is the whole point:
 * `coding-agent-spawn-failure.test.ts` — the file CI flaked on first — mocks
 * `spawn` alone and spreads `importOriginal()` for the rest, precisely so the
 * modules further down the graph keep a real `child_process`. Its six real
 * `git` calls go through the untouched `execFileSync`.
 */
function mocksChildProcessWholly(source: string): boolean {
  const at = source.search(/vi\.mock\(\s*["'](?:node:)?child_process["']/);
  if (at < 0) return false;
  return !/importOriginal|importActual/.test(source.slice(at, at + 500));
}

/** The house form: `vi.setConfig({ testTimeout: …, hookTimeout: … })` at file top. */
function declared(source: string, key: "testTimeout" | "hookTimeout"): number | null {
  const call = /^\s*vi\.setConfig\(\s*\{([\s\S]*?)\}\s*\)/m.exec(code(source));
  if (!call) return null;
  const match = new RegExp(`\\b${key}\\s*:\\s*([0-9_]+)`).exec(call[1]);
  return match ? Number(match[1].replace(/_/g, "")) : null;
}

/**
 * Six real processes in series, with the slowest measured at ~1.5 s each on a
 * saturated runner, is ~9 s. 15 s is the floor that clears it with headroom and
 * still fails a test that has actually hung.
 */
const MIN_TIMEOUT_MS = 15_000;

/**
 * Files that flake for a reason other than a subprocess, named from the CI runs
 * above rather than detected: long `findBy*` waits against a jsdom tree, and a
 * fake-timer probe fan-out whose module imports dominate under load. A pattern
 * broad enough to catch these automatically would catch most of the component
 * suite with it.
 */
const ALSO_REQUIRED = [
  "src/tests/routes/chat/capabilities-parallel.test.ts",
  "src/tests/components/hermes-oauth-inline.test.tsx",
  "src/tests/components/chat-spoken-reply.test.tsx",
  // Starts its processes through @/lib/coding-agent rather than importing
  // child_process itself, so the rule above cannot see it — and CI has seen it
  // both ways in one day: "pauses a live run…" timed out on one PR, and on
  // another every one of 10 906 tests passed while the job exited 1 on an
  // EnvironmentTeardownError originating in this file.
  "src/tests/unit/coding-agent.test.ts",
];

/**
 * Files that carry a bigger budget on every case inline, so a file-level
 * declaration would be a SECOND number disagreeing with the first.
 * `build-typecheck.test.ts` runs `tsc --noEmit`, measured at ~28 s in CI
 * (src/tests/helpers/slow-first-sequencer.ts), and says so with `}, 300_000)`.
 * Listed rather than detected, and checked below so a stale entry fails.
 */
const INLINE_BUDGET: Record<string, number> = {
  "src/tests/unit/build-typecheck.test.ts": 300_000,
};

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

describe("test-timeout hygiene", () => {
  const files = testFiles(ROOT).map((full) => {
    const source = fs.readFileSync(full, "utf-8");
    return { rel: rel(full), source, code: code(source) };
  });
  const spawners = files.filter(
    (f) => startsAProcess(f.code) && !mocksChildProcessWholly(f.code),
  );

  it("finds the test tree at all", () => {
    // A path that resolved to nothing would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(300);
    expect(spawners.length).toBeGreaterThan(50);
  });

  it("counts a require(...) member call, which binds no name", () => {
    // The one starter form processStarters cannot follow: there is no binding
    // to look for, so the file would drop out of the rule below with nothing
    // saying so. Nothing in the tree writes it today, which is precisely why
    // the real-tree assertions cannot cover it — they would pass either way.
    //
    // The require and the member call are joined at RUNTIME on purpose: spelt
    // out whole, this fixture would make THIS file a spawner and the rule
    // below would report it. Which is itself the detector working.
    const req = 'require("child_process")';
    const nodeReq = 'require("node:child_process")';
    expect(startsAProcess(code(`${nodeReq}.execSync("ls");`))).toBe(true);
    expect(startsAProcess(code(`${req} . spawn ( "ls" );`))).toBe(true);
    // A require with no call starts nothing…
    expect(startsAProcess(code(`const cp = ${req};`))).toBe(false);
    // …and a `.exec(` on something that is not child_process is not a starter,
    // which is the false positive the import rule exists to avoid.
    expect(startsAProcess(code('const m = /x/; m.exec("s");'))).toBe(false);
  });

  it("gives every test that starts a real process both ceilings", () => {
    const offenders = spawners
      .filter((f) => !(f.rel in INLINE_BUDGET))
      .filter(
        (f) =>
          (declared(f.source, "testTimeout") ?? 0) < MIN_TIMEOUT_MS
          || (declared(f.source, "hookTimeout") ?? 0) < MIN_TIMEOUT_MS,
      )
      .map((f) => f.rel);

    expect(offenders).toEqual([]);
  });

  it("gives the files seen flaking on long waits both ceilings too", () => {
    const byRel = new Map(files.map((f) => [f.rel, f.source]));
    const offenders = ALSO_REQUIRED.filter((name) => {
      const source = byRel.get(name);
      // A file that has been renamed or deleted is a stale entry here, not a
      // pass: the list would otherwise silently stop guarding anything.
      if (source === undefined) return true;
      return (
        (declared(source, "testTimeout") ?? 0) < MIN_TIMEOUT_MS
        || (declared(source, "hookTimeout") ?? 0) < MIN_TIMEOUT_MS
      );
    });

    expect(offenders).toEqual([]);
  });

  it("keeps the inline-budget exemptions honest", () => {
    // An exemption that stops being true is a silent hole: the file would be
    // skipped by the rule above while running on the default ceiling.
    const byRel = new Map(files.map((f) => [f.rel, f.source]));
    for (const [name, expected] of Object.entries(INLINE_BUDGET)) {
      const source = byRel.get(name);
      expect(source, `${name} is listed as inline-budgeted but does not exist`).toBeDefined();
      const inline = [...code(source!).matchAll(/\}\s*,\s*([0-9_]+)\s*\)/g)]
        .map((m) => Number(m[1].replace(/_/g, "")));
      expect(inline.length, `${name} carries no inline timeout any more`).toBeGreaterThan(0);
      expect(Math.min(...inline)).toBeGreaterThanOrEqual(expected);
    }
  });

  it("excludes a file only when child_process is mocked whole", () => {
    // The one SILENT exclusion in this guard: a file it drops leaves the check
    // with nothing saying so. Pinned rather than trusted, so the day the set
    // grows a human reads the name and decides whether it is really mocked.
    const excluded = files
      .filter((f) => startsAProcess(f.code))
      .filter((f) => mocksChildProcessWholly(f.code))
      .map((f) => f.rel);

    // Empty today: the detection asks whether a child_process BINDING is
    // called, and a file that mocks the module wholly and only reads the mock
    // (system-password.test.ts) starts nothing to begin with, so it is not a
    // spawner rather than an excluded one.
    expect(excluded).toEqual([]);
  });

  it("does not simply raise the defaults for everything", () => {
    // The other half of the ruling. Widening the defaults would hide a unit
    // test that has genuinely hung, which is what they are for. Matched on a
    // comment-stripped form, so the ruling can still be WRITTEN down where a
    // reader would look for it.
    const config = code(fs.readFileSync(path.join(REPO, "vitest.config.ts"), "utf-8"));
    expect(config).not.toMatch(/^\s*(testTimeout|hookTimeout)\s*:/m);
    // …and not through the back door either: a flag on the runner defeats the
    // ruling without touching the config file.
    const pkg = fs.readFileSync(path.join(REPO, "package.json"), "utf-8");
    expect(pkg).not.toMatch(/--(test|hook)Timeout/);
    const workflow = fs.readFileSync(
      path.join(REPO, ".github", "workflows", "pr-tests-coverage.yml"),
      "utf-8",
    );
    expect(workflow).not.toMatch(/--(test|hook)Timeout/);
  });

  it("caps the test job at thirty minutes, so a genuine hang cannot burn a runner", () => {
    // The cheap half of the same ruling. Raising 79 files' budget six-fold
    // makes a real hang six times more expensive to surface, and this job was
    // the only one in the repo with no ceiling at all — GitHub's default is
    // six hours. Every other workflow here caps itself.
    // The `test` job specifically, and the value specifically: `/timeout-minutes:
    // \d+/` anywhere in the file passes when the cap sits on another job, or
    // when it is 360. The job is bounded by the next two-space key after
    // `jobs:`, so a key under `on:` cannot be mistaken for one.
    const workflow = fs.readFileSync(
      path.join(REPO, ".github", "workflows", "pr-tests-coverage.yml"),
      "utf-8",
    );
    const jobsAt = workflow.indexOf("\njobs:\n");
    expect(jobsAt).toBeGreaterThan(-1);
    const headers = [...workflow.slice(jobsAt).matchAll(/^ {2}([\w-]+):$/gm)];
    expect(headers[0]?.[1]).toBe("test");
    const end = headers[1] ? jobsAt + headers[1].index! : workflow.length;
    const testJob = workflow.slice(jobsAt, end);
    const cap = /^\s*timeout-minutes:\s*(\d+)\s*$/m.exec(testJob);
    expect(cap, "the test job has no timeout-minutes").not.toBeNull();
    expect(Number(cap![1])).toBe(30);
  });
});
