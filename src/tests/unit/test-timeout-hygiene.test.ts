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
 * A real process is started only through a `child_process` import.
 *
 * Matching the bare call names would count `RE.exec(s)`, a local helper named
 * `spawn`, and every `execFileSync` that is a mock's own type annotation. The
 * import is the fact that decides it.
 */
const IMPORTS_CHILD_PROCESS =
  /import\s+(?:\*\s+as\s+\w+|\{[^}]*\}|\w+)\s+from\s+["'](?:node:)?child_process["']|require\(\s*["'](?:node:)?child_process["']\s*\)/;
/** …and one of its process starters is actually called. Async forms included:
 * a test that spawns and awaits is in the same flake class as one that blocks —
 * `run-tunnel.test.ts` polls for up to 5 000 ms on the wait alone. */
const STARTS_A_PROCESS = /\b(spawnSync|execFileSync|execSync|spawn|execFile|fork|exec)\s*\(/;

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

/**
 * Comments stripped before any pattern is read.
 *
 * Without this a file passes on a commented-out declaration — and the rule
 * would have been satisfied by the prose in this very file.
 */
function code(source: string): string {
  // Only comments that OWN their line, and that restraint is load-bearing: a
  // blunt `/\*[\s\S]*?\*\//` eats from the `/*` inside a `"**/node_modules/**"`
  // glob to the `*/` inside the next one and takes the whole file with it,
  // which is how this helper first reported that vitest.config.ts had no
  // projects at all. A commented-out declaration — the hole this exists to
  // close — owns its line by convention.
  return source
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, "")
    .replace(/^[ \t]*\/\/[^\n]*$/gm, "");
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
  const files = testFiles(ROOT).map((full) => ({
    rel: rel(full),
    source: fs.readFileSync(full, "utf-8"),
  }));
  const spawners = files.filter(
    (f) =>
      IMPORTS_CHILD_PROCESS.test(f.source)
      && STARTS_A_PROCESS.test(f.source)
      && !mocksChildProcessWholly(f.source),
  );

  it("finds the test tree at all", () => {
    // A path that resolved to nothing would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(300);
    expect(spawners.length).toBeGreaterThan(50);
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
      .filter((f) => IMPORTS_CHILD_PROCESS.test(f.source) && STARTS_A_PROCESS.test(f.source))
      .filter((f) => mocksChildProcessWholly(f.source))
      .map((f) => f.rel);

    expect(excluded).toEqual(["src/tests/unit/system-password.test.ts"]);
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

  it("caps the test job, so a genuine hang cannot burn a runner", () => {
    // The cheap half of the same ruling. Raising 79 files' budget six-fold
    // makes a real hang six times more expensive to surface, and this job was
    // the only one in the repo with no ceiling at all — GitHub's default is
    // six hours. Every other workflow here caps itself.
    const workflow = fs.readFileSync(
      path.join(REPO, ".github", "workflows", "pr-tests-coverage.yml"),
      "utf-8",
    );
    expect(workflow).toMatch(/^\s*timeout-minutes:\s*\d+/m);
  });
});
