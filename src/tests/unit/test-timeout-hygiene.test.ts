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
 * Where a `/` can begin a REGEX rather than a division.
 *
 * The walker has to know, and it is not decoration: a regex containing an odd
 * number of quotes — `/["\']/`, which this very file writes — puts a quote-only
 * walker into "inside a string" state and it stays desynced until the next
 * matching quote, then desynced the OTHER way inside a real string. Both
 * directions were reproduced and both are SILENT: a commented-out
 * `vi.setConfig` is read as a declaration, and a real `execFileSync(` gets
 * blanked as part of a "comment" the walker found inside `"https://…"`.
 *
 * The rule is the classic one every lexer uses: a `/` after a value (an
 * identifier, a literal, a closing bracket) is division; after an operator,
 * punctuation, the start of input, or one of these keywords, it opens a regex.
 */
const REGEX_MAY_FOLLOW = /(?:^|[^\w$)\]}'"`])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$|[(,=:[!&|?{};+\-*%~^<>]$|^$/;

/**
 * Comments blanked, length and newlines preserved. Strings and regexes are
 * WALKED but kept.
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
 * `//` inside a URL cannot be mistaken for the start of a comment — and so is a
 * regex literal, for the reason above it.
 */
function code(source: string): string {
  const out = source.split("");
  let i = 0;
  let prev = "";
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
      prev = quote;
    } else if (source[i] === "/" && REGEX_MAY_FOLLOW.test(prev)) {
      // A regex body, character classes included: `/[/]/` is legal and the `/`
      // inside the class does not close it.
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n") {
        const c = source[j];
        if (c === "\\") { j += 2; continue; }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        j++;
      }
      i = j + 1;
      prev = "/";
    } else {
      if (!/\s/.test(source[i])) prev = (prev + source[i]).slice(-24);
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
    // ESM: `import * as cp from`, `import { a, b as c } from`, `import cp from`,
    // and `import cp, { a } from` — the last one bound nothing before, because
    // the alternation had no branch for a default clause FOLLOWED by a named
    // one, so a file writing the two together dropped out of the check.
    String.raw`import\s+(?:\*\s+as\s+(?<esmNs>\w+)|(?:(?<esmDefaultNamed>\w+)\s*,\s*)?\{(?<esmNamed>[^}]*)\}|(?<esmDefault>\w+))\s+from\s+["'](?:node:)?child_process["']`,
    // CJS and DYNAMIC: `const { a, b: c } = require(...)`, `const cp = require(...)`,
    // `const { execFileSync } = await import("node:child_process")`. The dynamic
    // form is not hypothetical — it is already the house style for a value
    // import in this tree (`routes/hermes/oauth-wizard-handoff.test.ts`,
    // `unit/instrumentation-terminal-server.test.ts`), and a new suite written
    // that way with nothing mocked would have got no ceiling and no complaint.
    String.raw`(?:const|let|var)\s+(?:\{(?<cjsNamed>[^}]*)\}|(?<cjsNs>\w+))\s*=\s*(?:await\s+)?(?:require|import)\(\s*["'](?:node:)?child_process["']\s*\)`,
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
    // A default clause beside a named one binds the module object too, and its
    // named specifiers are read below in the same pass.
    if (g.esmDefaultNamed) for (const starter of STARTERS) names.push(`${g.esmDefaultNamed}.${starter}`);
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
  // The FACTORY'S SHAPE, not an identifier. Asking whether `importOriginal` or
  // `importActual` appears nearby reads the author's choice of parameter name:
  // `gateway-restart-hermes.test.ts` and `gateway-restart-readiness.test.ts`
  // both write `async (orig) => ({ ...(await orig()), … })`, which spreads the
  // real module and is emphatically not whole — and both were called whole.
  // vitest 4's `vi.mock(path, { spy: true })` is the same trap with no factory
  // function at all: the real implementations still run.
  //
  // So: whole ONLY when the call has no second argument. Anything else keeps
  // some of the original as far as this guard is concerned, which errs toward
  // counting a file as a spawner — the over-report direction, where the cost is
  // a ceiling a file did not need and the alternative is a silent hole.
  return new RegExp(String.raw`vi\.mock\(\s*["'](?:node:)?child_process["']\s*\)`).test(source);
}

/** The house form: `vi.setConfig({ testTimeout: …, hookTimeout: … })` at file top. */
function declared(stripped: string, key: "testTimeout" | "hookTimeout"): number | null {
  // Takes the ALREADY-stripped form, like its two neighbours above. It used to
  // take the raw source and re-run `code()` itself — a third convention one
  // screenful from the other two, and passing `f.source` to `startsAProcess` by
  // the same reflex silently over-reports.
  const call = /^\s*vi\.setConfig\(\s*\{([\s\S]*?)\}\s*\)/m.exec(stripped);
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
/**
 * ...and the SIBLING ceiling, named so nobody has to rediscover it: Testing
 * Library's `asyncUtilTimeout` (`src/tests/setup.ts`) bounds a SINGLE `findBy*`
 * wait at 5 s, and nothing here raises it. That is deliberate rather than
 * missed. The failures this file is about report vitest's own "Test timed out
 * in 5000ms", which is several sub-5 s waits in series and is exactly what
 * `testTimeout` governs; a single wait that needed longer would fail with
 * "Unable to find an element…" instead. Raising `asyncUtilTimeout` to 15 s was
 * tried on this branch and REVERTED — the same cases still failed, one at
 * 15.5 s and one on an outright assertion at 387 ms — so under heavy parallel
 * load something is not arriving at all, which no budget fixes. Its own card.
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
  // Starts no process at all: it parses ~270 files with the TypeScript compiler
  // in ONE case, and v8 coverage instrumentation multiplies that by ~7. Measured
  // 2026-09-05 — 426 ms of parse uninstrumented, 2 874 ms under
  // `test:coverage:ci` on an idle machine, and 5 318 ms on a four-worker CI
  // runner, where it failed with vitest's "Test timed out in 5000ms".
  "src/tests/unit/state-updater-purity.test.ts",
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

  // Every fixture below joins the module specifier to the rest at RUNTIME.
  // `code()` deliberately KEEPS strings, so a spelled-out
  // `from "child_process"` anywhere in this file — inside a string literal
  // included — would make the guard file itself a spawner and report itself as
  // an offender. Which is the detector working, and a confusing way to find out.
  const CP = '"node:child_process"';

  it("is not thrown off by a regex literal containing a quote", () => {
    // The walker knows strings and comments; a regex is neither, and
    // `/["\']/` — which this very file writes — puts a quote-only walker into
    // "inside a string" state until the next matching quote, then leaves it
    // desynced the OTHER way inside a real string. Both directions are silent,
    // which is why they get a case each.
    const spawner = `import { execFileSync } from ${CP};`;
    const quoteRegex = 'const QUOTED = /["\']/;';

    // A: a commented-out declaration must not read as a declaration. This is
    // the exact thing `code()`'s docblock says it exists to prevent.
    const commentedOut = [
      spawner,
      quoteRegex,
      "/*",
      "vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });",
      "*/",
      'execFileSync("git", ["--version"]);',
    ].join("\n");
    expect(declared(code(commentedOut), "testTimeout")).toBeNull();
    expect(startsAProcess(code(commentedOut))).toBe(true);

    // B: a real call must not be blanked. Desynced into "code" state inside a
    // string, the walker read the `//` of a URL as a comment and blanked the
    // rest of the line — the spawner call with it.
    const urlThenCall = [
      spawner,
      quoteRegex,
      'const url = "https://example.com"; execFileSync("git", ["--version"]);',
    ].join("\n");
    expect(startsAProcess(code(urlThenCall))).toBe(true);
  });

  it("follows a dynamic import, and a default clause beside a named one", () => {
    // `const { execFileSync } = await import(…)` is already the house form for a
    // value import in this tree, and `import cp, { execFileSync } from …` had no
    // branch in the alternation at all. A new suite in either style would have
    // got no ceiling and no complaint.
    const dynamic = [
      `const { execFileSync } = await import(${CP});`,
      'execFileSync("git", ["--version"]);',
    ].join("\n");
    expect(startsAProcess(code(dynamic))).toBe(true);

    const dynamicNs = [
      `const cp = await import(${CP});`,
      'cp.execFileSync("git", ["--version"]);',
    ].join("\n");
    expect(startsAProcess(code(dynamicNs))).toBe(true);

    const defaultAndNamed = [
      `import cp, { execFileSync } from ${CP};`,
      'execFileSync("git", ["--version"]);',
    ].join("\n");
    expect(startsAProcess(code(defaultAndNamed))).toBe(true);

    // …and the default binding of that same import is followed too.
    const defaultAndNamedNs = [
      `import cp, { spawnSync } from ${CP};`,
      'cp.execFileSync("git", ["--version"]);',
    ].join("\n");
    expect(startsAProcess(code(defaultAndNamedNs))).toBe(true);
  });

  it("calls a mock whole only when it replaces the module outright", () => {
    // A factory that spreads the original leaves the real `execFileSync` in
    // place, and two files in this tree write exactly that with the parameter
    // named `orig` — so a check keyed on the words `importOriginal`/
    // `importActual` called both of them whole. So does vitest 4's
    // `vi.mock(path, { spy: true })`, which has no factory function at all.
    const whole = `vi.mock(${CP});`;
    expect(mocksChildProcessWholly(code(whole))).toBe(true);

    for (const partial of [
      `vi.mock(${CP}, async (orig) => ({ ...(await orig()), spawn: vi.fn() }));`,
      `vi.mock(${CP}, async (importOriginal) => ({ ...(await importOriginal()) }));`,
      `vi.mock(${CP}, { spy: true });`,
      `vi.mock(${CP}, () => ({ spawn: vi.fn() }));`,
    ]) {
      expect(mocksChildProcessWholly(code(partial)), partial).toBe(false);
    }

    // …and a mock written inside a comment excludes nothing at all.
    expect(mocksChildProcessWholly(code(`// vi.mock(${CP});`))).toBe(false);
  });

  it("gives every test that starts a real process both ceilings", () => {
    const offenders = spawners
      .filter((f) => !(f.rel in INLINE_BUDGET))
      .filter(
        (f) =>
          (declared(f.code, "testTimeout") ?? 0) < MIN_TIMEOUT_MS
          || (declared(f.code, "hookTimeout") ?? 0) < MIN_TIMEOUT_MS,
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
        (declared(code(source), "testTimeout") ?? 0) < MIN_TIMEOUT_MS
        || (declared(code(source), "hookTimeout") ?? 0) < MIN_TIMEOUT_MS
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
      // Anchored to the END of a statement, which is where an `it(…, timeout)`
      // budget sits — `/\}\s*,\s*(\d+)\s*\)/` alone also matches any helper
      // called as `foo({…}, 5)`. And the MAXIMUM, not the minimum: the claim is
      // "this file carries a bigger budget inline", and a second deliberately
      // short case would otherwise turn a still-valid exemption red.
      const inline = [...code(source!).matchAll(/\}\s*,\s*([0-9_]+)\s*\)\s*;?\s*$/gm)]
        .map((m) => Number(m[1].replace(/_/g, "")));
      expect(inline.length, `${name} carries no inline timeout any more`).toBeGreaterThan(0);
      expect(Math.max(...inline)).toBeGreaterThanOrEqual(expected);
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
    // No `^\s*` anchor: `test: { clearMocks: true, testTimeout: 30_000 }` on one
    // line defeats a line-anchored pattern, and it is the same ruling broken.
    const KEY_ANYWHERE = /[\s,{](testTimeout|hookTimeout)\s*:/;
    const config = code(fs.readFileSync(path.join(REPO, "vitest.config.ts"), "utf-8"));
    expect(config).not.toMatch(KEY_ANYWHERE);
    // …and not through a SETUP FILE either. vitest's own runner comment names
    // that as the place a user calls `vi.setConfig` globally, and this repo
    // gives the `components` project one — a declaration there raises the
    // ceiling for every component test with nothing else noticing.
    for (const setup of [...config.matchAll(/["']([^"']*src\/tests\/[^"']*setup[^"']*)["']/g)].map((m) => m[1])) {
      const file = path.join(REPO, setup);
      if (!fs.existsSync(file)) continue;
      expect(code(fs.readFileSync(file, "utf-8")), `${setup} raises a global ceiling`)
        .not.toMatch(/vi\.setConfig\([\s\S]*?(testTimeout|hookTimeout)/);
    }
    // …and not through the runner's CLI either. cac camel-cases every parsed
    // option, so `--test-timeout=30000` reaches vitest as `testTimeout` and a
    // camelCase-only pattern waves it straight through.
    const CLI_FLAG = /--(test|hook)-?[Tt]imeout/;
    const pkg = fs.readFileSync(path.join(REPO, "package.json"), "utf-8");
    expect(pkg).not.toMatch(CLI_FLAG);
    const workflow = fs.readFileSync(
      path.join(REPO, ".github", "workflows", "pr-tests-coverage.yml"),
      "utf-8",
    );
    expect(workflow).not.toMatch(CLI_FLAG);
  });

  it("caps the test job at thirty minutes, so a genuine hang cannot burn a runner", () => {
    // The cheap half of the same ruling. Raising eighty-odd files' budget
    // six-fold makes a real hang six times more expensive to surface, and this
    // job — the only one in the repo that runs the whole suite — had no ceiling
    // at all, so GitHub's six-hour default applied.
    // The `test` job specifically, and the value specifically: `/timeout-minutes:
    // \d+/` anywhere in the file passes when the cap sits on another job, or
    // when it is 360. The job is bounded by the NEXT two-space key after its
    // own, so a key under `on:` cannot be mistaken for one — and the job is
    // found BY NAME, because pinning it to the first position would fail this
    // assertion, over a message about a timeout, the day someone adds a `lint:`
    // job above it.
    const workflow = fs.readFileSync(
      path.join(REPO, ".github", "workflows", "pr-tests-coverage.yml"),
      "utf-8",
    );
    const jobsAt = workflow.indexOf("\njobs:\n");
    expect(jobsAt).toBeGreaterThan(-1);
    const headers = [...workflow.slice(jobsAt).matchAll(/^ {2}([\w-]+):$/gm)];
    const at = headers.findIndex((h) => h[1] === "test");
    expect(at, "no `test` job in pr-tests-coverage.yml").toBeGreaterThan(-1);
    const start = jobsAt + headers[at].index!;
    const end = headers[at + 1] ? jobsAt + headers[at + 1].index! : workflow.length;
    const testJob = workflow.slice(start, end);
    const cap = /^\s*timeout-minutes:\s*(\d+)\s*$/m.exec(testJob);
    expect(cap, "the test job has no timeout-minutes").not.toBeNull();
    expect(Number(cap![1])).toBe(30);
  });
});
