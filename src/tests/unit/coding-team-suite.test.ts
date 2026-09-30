/**
 * The project's own test suite, run on a coding team's merged result before
 * the team may say "done" (src/lib/coding-team-suite.ts, TASK-1321): what
 * counts as a suite, how a runner's output is read — the failing tests by
 * name, the files the failure points at — what is red and what is merely not
 * judged, and the words a rejection carries. The runs are real: python3
 * through `env` standing in for `setpriv`, as in coding-deliverable-check.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { DeliverableSandbox, SandboxedOutcome } from "@/lib/coding-deliverable-check";
import {
  detectSuites,
  failingTests,
  MAX_NAMED_TESTS,
  namedFiles,
  namedTests,
  readSuiteOutput,
  runProjectSuite,
  suiteFailure,
  suiteNote,
  suiteRejection,
  type SuiteVerdict,
} from "@/lib/coding-team-suite";

// Real python3 runs, one of them waiting out a deadline.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-team-suite-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function write(files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
}

function sandbox(): DeliverableSandbox {
  return { bin: "/usr/bin/env", args: ["PYTHONDONTWRITEBYTECODE=1"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir } };
}

const ran = (over: Partial<SandboxedOutcome>): SandboxedOutcome => ({ code: 1, output: "", timedOut: false, error: null, ...over });
type Red = Extract<SuiteVerdict, { kind: "fail" }>;

describe("what counts as a suite", () => {
  it("finds nothing in a folder with no tests — a static site, an empty folder", async () => {
    expect(await detectSuites(dir)).toEqual([]);
    write({ "index.html": "<!doctype html>", "app.js": "", "test.html": "" });
    expect(await detectSuites(dir)).toEqual([]);
    expect(await detectSuites(path.join(dir, "no-such-folder"))).toEqual([]);
  });

  it("runs unittest from the top for a test_*.py there, or a tests/ package", async () => {
    write({ "test_calc.py": "" });
    expect(await detectSuites(dir)).toEqual(["python3 -m unittest discover"]);
    fs.rmSync(path.join(dir, "test_calc.py"));
    write({ "tests/__init__.py": "", "tests/test_calc.py": "" });
    expect(await detectSuites(dir)).toEqual(["python3 -m unittest discover"]);
  });

  it("starts discovery IN tests/ when it is not a package — from the top, unittest would find nothing there", async () => {
    write({ "tests/test_calc.py": "" });
    expect(await detectSuites(dir)).toEqual(["python3 -m unittest discover -s tests"]);
    write({ "test_top.py": "" });
    expect(await detectSuites(dir)).toEqual(["python3 -m unittest discover", "python3 -m unittest discover -s tests"]);
  });

  it("looks one folder into tests/, and not for a tests/ that holds no Python test", async () => {
    write({ "tests/unit/test_calc.py": "" });
    expect(await detectSuites(dir)).toEqual(["python3 -m unittest discover -s tests"]);
    fs.rmSync(path.join(dir, "tests"), { recursive: true });
    write({ "tests/app.test.js": "", "tests/helpers.py": "" });
    expect(await detectSuites(dir)).toEqual([]);
  });

  it("runs a package.json's real test script — through bun when bun locks the project — and never npm's placeholder", async () => {
    write({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
    expect(await detectSuites(dir)).toEqual([]);
    write({ "package.json": JSON.stringify({ scripts: { build: "tsc" } }) });
    expect(await detectSuites(dir)).toEqual([]);
    write({ "package.json": "{ not json" });
    expect(await detectSuites(dir)).toEqual([]);
    write({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) });
    expect(await detectSuites(dir)).toEqual(["npm test"]);
    write({ "bun.lock": "" });
    expect(await detectSuites(dir)).toEqual(["bun run test"]);
  });

  it("runs both when a project has both, Python first", async () => {
    write({ "test_api.py": "", "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
    expect(await detectSuites(dir)).toEqual(["python3 -m unittest discover", "npm test"]);
  });
});

describe("reading unittest's output", () => {
  const ROOT = "/home/clawbox/Projects/units";
  // Python 3.12, as on this runner: the header carries the whole id, a subtest its parameters.
  const PY312 = [
    "EF.FF",
    "======================================================================",
    "ERROR: test_err (test_conv.TestConv.test_err)",
    "----------------------------------------------------------------------",
    "Traceback (most recent call last):",
    `  File "${ROOT}/tests/test_conv.py", line 10, in test_err`,
    "    total = conv.km_to_mi(None)",
    `  File "${ROOT}/conv.py", line 2, in km_to_mi`,
    "    return x * 1.609344",
    "TypeError: unsupported operand type(s) for *: 'NoneType' and 'float'",
    "",
    "======================================================================",
    "FAIL: test_pairs (test_conv.TestConv.test_pairs) (pair='a')",
    "----------------------------------------------------------------------",
    "Traceback (most recent call last):",
    `  File "${ROOT}/tests/test_conv.py", line 9, in test_pairs`,
    "    self.assertEqual(1, 0, \"1.609344\")",
    "AssertionError: 1 != 0 : 1.609344",
    "",
    "======================================================================",
    "FAIL: test_pairs (test_conv.TestConv.test_pairs) (pair='b')",
    "----------------------------------------------------------------------",
    "AssertionError: 1 != 0 : 1.609344",
    "",
    "----------------------------------------------------------------------",
    "Ran 56 tests in 0.004s",
    "",
    "FAILED (failures=11, errors=1)",
  ].join("\n");

  it("names every failing test once — a subtest as its test — with the count, the files and the first failure's words", () => {
    const v = readSuiteOutput("python3 -m unittest discover -s tests", ran({ output: PY312 }), ROOT) as Red;
    expect(v).toEqual({
      kind: "fail",
      command: "python3 -m unittest discover -s tests",
      summary: "Ran 56 tests, FAILED (failures=11, errors=1)",
      failing: ["test_conv.TestConv.test_err", "test_conv.TestConv.test_pairs"],
      files: ["tests/test_conv.py", "conv.py"],
      excerpt: "TypeError: unsupported operand type(s) for *: 'NoneType' and 'float'",
    });
  });

  it("reads Python 3.10's headers — the box's own — into the same ids", () => {
    const out = [
      "FAIL: test_km (tests.test_conv.TestConv)",
      "AssertionError: 1 != 0 : 1.609344",
      "FAIL: test_pairs (tests.test_conv.TestConv) (pair='km')",
      "ERROR: test_convert (unittest.loader._FailedTest)",
      "ImportError: Failed to import test module: test_convert",
      "ModuleNotFoundError: No module named 'convert'",
      "Ran 3 tests in 0.001s",
      "FAILED (failures=2, errors=1)",
    ].join("\n");
    const v = readSuiteOutput("python3 -m unittest discover", ran({ output: out }), ROOT) as Red;
    expect(v.failing).toEqual(["tests.test_conv.TestConv.test_km", "tests.test_conv.TestConv.test_pairs", "test_convert (could not be imported)"]);
    expect(v.excerpt).toBe("AssertionError: 1 != 0 : 1.609344");
  });

  it("is red when a test module cannot import the project's own code", () => {
    const out = "ERROR: test_calc (unittest.loader._FailedTest.test_calc)\nImportError: Failed to import test module: test_calc\nModuleNotFoundError: No module named 'calc'\nRan 1 test in 0.000s\nFAILED (errors=1)";
    const v = readSuiteOutput("python3 -m unittest discover", ran({ output: out }), ROOT) as Red;
    expect(v).toMatchObject({ kind: "fail", failing: ["test_calc (could not be imported)"], excerpt: "ModuleNotFoundError: No module named 'calc'" });
  });

  it("does not judge a suite written for pytest on a box without it, nor one where no test ran", () => {
    const pytest = "ERROR: test_calc (unittest.loader._FailedTest.test_calc)\nImportError: Failed to import test module: test_calc\nModuleNotFoundError: No module named 'pytest'\nRan 1 test in 0.000s\nFAILED (errors=1)";
    expect(readSuiteOutput("python3 -m unittest discover", ran({ output: pytest }), ROOT)).toMatchObject({ kind: "unjudged", reason: expect.stringContaining("pytest") });
    // …but a real failure beside it is still red.
    const mixed = `FAIL: test_add (test_calc.TestCalc.test_add)\nAssertionError: 3 != 4\n${pytest}`;
    expect(readSuiteOutput("python3 -m unittest discover", ran({ output: mixed }), ROOT)).toMatchObject({ kind: "fail", failing: ["test_calc.TestCalc.test_add", "test_calc (could not be imported)"] });
    // 3.12 says NO TESTS RAN and exits 5; 3.10 exits 0.
    expect(readSuiteOutput("python3 -m unittest discover", ran({ code: 5, output: "Ran 0 tests in 0.000s\n\nNO TESTS RAN" }), ROOT)).toMatchObject({ kind: "unjudged", reason: expect.stringContaining("no test ran") });
    expect(readSuiteOutput("python3 -m unittest discover", ran({ code: 0, output: "Ran 0 tests in 0.000s\n\nOK" }), ROOT)).toMatchObject({ kind: "unjudged" });
  });

  it("passes on exit 0 with the runner's own count", () => {
    expect(readSuiteOutput("python3 -m unittest discover", ran({ code: 0, output: "........\nRan 56 tests in 0.020s\n\nOK (skipped=2)" }), ROOT)).toEqual({
      kind: "pass",
      command: "python3 -m unittest discover",
      summary: "Ran 56 tests, OK (skipped=2)",
    });
  });
});

describe("what is red and what is not judged", () => {
  it("counts a suite still going at the deadline as red — a hung suite is not a passing one", () => {
    const v = readSuiteOutput("npm test", ran({ code: null, timedOut: true, output: "> test\n> node --test\nwaiting on port 3000" }), "/p");
    expect(v).toMatchObject({ kind: "fail", summary: "did not finish within 5 minutes", excerpt: "> test | > node --test | waiting on port 3000" });
  });

  it("does not judge a runner the box does not have (exit 127) or a command that could not start", () => {
    expect(readSuiteOutput("npm test", ran({ code: 127, output: "sh: 1: vitest: not found" }), "/p")).toEqual({ kind: "unjudged", command: "npm test", reason: "the box could not run it (exit 127: sh: 1: vitest: not found)" });
    expect(readSuiteOutput("npm test", ran({ code: null, error: "spawn /usr/bin/setpriv ENOENT" }), "/p")).toMatchObject({ kind: "unjudged", reason: "it could not be started: spawn /usr/bin/setpriv ENOENT" });
  });
});

describe("reading a JavaScript runner's output", () => {
  it("vitest: each failing test with its file, once, and the count", () => {
    const out = [
      " ❯ src/convert.test.ts (3 tests | 1 failed) 12ms",
      "   × convert > km to mi 5ms",
      "",
      " FAIL  src/convert.test.ts > convert > km to mi",
      "AssertionError: expected 1.609344 to be 0.621371",
      " ❯ src/convert.test.ts:8:30",
      "",
      " Test Files  1 failed (1)",
      "      Tests  1 failed | 2 passed (3)",
    ].join("\n");
    const v = readSuiteOutput("npm test", ran({ output: out }), "/p") as Red;
    expect(v.failing).toEqual(["src/convert.test.ts > convert > km to mi"]);
    expect(v.files).toEqual(["src/convert.test.ts"]);
    expect(v.summary).toBe("Tests 1 failed | 2 passed (3) (exit 1)");
    expect(v.excerpt).toBe("AssertionError: expected 1.609344 to be 0.621371");
  });

  it("jest's ● headers, node:test's ✖ lines and TAP's not ok, with absolute paths under the project", () => {
    expect(failingTests("  ● convert › km to mi\n\n    expect(received).toBe(expected)\n  ● Test suite failed to run")).toEqual(["convert › km to mi"]);
    expect(failingTests("✖ km to mi (1.2ms)\n✖ failing tests:\n✖ km to mi (1.2ms)")).toEqual(["km to mi"]);
    expect(failingTests("TAP version 13\nok 1 - mi to km\nnot ok 2 - km to mi # time=1ms\n1..2")).toEqual(["km to mi"]);
    expect(namedFiles("    at TestContext.<anonymous> (/p/test/convert.test.js:12:5)\n    at /p/node_modules/x/index.js:1:1", "/p")).toEqual(["test/convert.test.js"]);
    expect(readSuiteOutput("npm test", ran({ output: "AssertionError [ERR_ASSERTION]: 1.609344 == 0.621371\n# fail 1" }), "/p")).toMatchObject({
      excerpt: "AssertionError [ERR_ASSERTION]: 1.609344 == 0.621371",
      summary: "# fail 1 (exit 1)",
    });
  });

  it("names files by the project's real path too, and never one outside it", () => {
    const out = 'File "/real/units/tests/test_a.py", line 3\nFile "/home/me/units/conv.py", line 1\nFile "/usr/lib/python3.10/unittest/case.py", line 59\nFile "/real/units2/x.py", line 1';
    expect(namedFiles(out, ["/home/me/units", "/real/units"])).toEqual(["tests/test_a.py", "conv.py"]);
  });
});

describe("running the project's suite", () => {
  const TESTS = [
    "import unittest",
    "from calc import add",
    "",
    "class TestCalc(unittest.TestCase):",
    "    def test_add(self):",
    "        self.assertEqual(add(1, 2), 3)",
    "",
    "    def test_add_negative(self):",
    "        self.assertEqual(add(-1, -2), -3)",
    "",
  ].join("\n");

  it("runs nothing and asks for no sandbox when the project has no suite", async () => {
    write({ "index.html": "<!doctype html>" });
    const box = vi.fn(async () => sandbox());
    expect(await runProjectSuite(dir, box)).toEqual({ kind: "none" });
    expect(box).not.toHaveBeenCalled();
  });

  it("does not run a suite it has no sandbox for", async () => {
    write({ "test_calc.py": TESTS });
    expect(await runProjectSuite(dir, async () => null)).toMatchObject({ kind: "unjudged", reason: expect.stringContaining("no sandbox") });
  });

  it("is red on the merged tree with the failing test named and its file pointed at", async () => {
    write({ "calc.py": "def add(a, b):\n    return a - b\n", "tests/test_calc.py": TESTS });
    const v = await runProjectSuite(dir, async () => sandbox());
    expect(v).toMatchObject({
      kind: "fail",
      command: "python3 -m unittest discover -s tests",
      summary: "Ran 2 tests, FAILED (failures=2)",
      failing: ["test_calc.TestCalc.test_add", "test_calc.TestCalc.test_add_negative"],
      files: ["tests/test_calc.py"],
      excerpt: "AssertionError: -1 != 3",
    });
    // The run left no bytecode behind in the team's checkout.
    expect(fs.existsSync(path.join(dir, "tests", "__pycache__"))).toBe(false);
  });

  it("passes when the suite does", async () => {
    write({ "calc.py": "def add(a, b):\n    return a + b\n", "tests/test_calc.py": TESTS });
    expect(await runProjectSuite(dir, async () => sandbox())).toEqual({ kind: "pass", command: "python3 -m unittest discover -s tests", summary: "Ran 2 tests, OK" });
  });

  it("ends a suite that outlives its time box, and calls it red", async () => {
    write({ "test_slow.py": "import time, unittest\n\nclass TestSlow(unittest.TestCase):\n    def test_slow(self):\n        time.sleep(20)\n" });
    const started = Date.now();
    const v = await runProjectSuite(dir, async () => sandbox(), 1_000);
    expect(v).toMatchObject({ kind: "fail", summary: "did not finish within 1 second" });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("says a pass beside what it could not judge", async () => {
    write({ "calc.py": "def add(a, b):\n    return a + b\n", "tests/test_calc.py": TESTS, "package.json": JSON.stringify({ scripts: { test: "no-such-runner-xyz" } }) });
    const v = await runProjectSuite(dir, async () => sandbox());
    expect(v).toMatchObject({ kind: "pass", command: "python3 -m unittest discover -s tests" });
    expect((v as { summary: string }).summary).toMatch(/^python3 -m unittest discover -s tests: Ran 2 tests, OK; npm test: not judged — the box could not run it \(exit 127/);
  });
});

describe("the words", () => {
  const red: Red = {
    kind: "fail",
    command: "python3 -m unittest discover -s tests",
    summary: "Ran 56 tests, FAILED (failures=11)",
    failing: Array.from({ length: 11 }, (_, i) => `test_convert.TestConvert.test_pair_${i + 1}`),
    files: ["tests/test_convert.py"],
    excerpt: "AssertionError: 1 != 0 : 1.609344",
  };

  it("a rejection names the command, the count, the failing tests and the first failure, and says how to check", () => {
    const text = suiteRejection(red);
    expect(text).toContain("The project's own tests fail on the merged result: python3 -m unittest discover -s tests — Ran 56 tests, FAILED (failures=11).");
    expect(text).toContain("Failing: test_convert.TestConvert.test_pair_1, ");
    expect(text).toContain(`test_convert.TestConvert.test_pair_${MAX_NAMED_TESTS}, and 1 more.`);
    expect(text).toContain("First failure: AssertionError: 1 != 0 : 1.609344");
    expect(text).toContain("never by deleting or weakening a test");
    expect(text).toContain("run `python3 -m unittest discover -s tests` yourself before you finish.");
    expect(text.length).toBeLessThan(2_000);
    expect(suiteFailure(red)).toMatch(/^The project's own tests fail on the merged result: .* First failure: AssertionError: 1 != 0 : 1\.609344$/);
    expect(namedTests(["a"])).toBe("a");
  });

  it("the board's note is one line that always says what happens next", () => {
    const long: Red = { ...red, failing: red.failing.map((n) => `${n}_${"x".repeat(80)}`) };
    const note = suiteNote(long, ["t1", "t2"]);
    expect(note).not.toContain("\n");
    expect(note.length).toBeLessThanOrEqual(600);
    expect(note.endsWith(" Offered once more: t1, t2.")).toBe(true);
    expect(suiteNote({ kind: "pass", command: "npm test", summary: "Tests 3 passed (3)" })).toBe("The project's own tests pass on the merged result: npm test — Tests 3 passed (3).");
    expect(suiteNote({ kind: "unjudged", command: "npm test", reason: "the box could not run it (exit 127)" })).toBe("The project's own tests were not judged (npm test): the box could not run it (exit 127).");
  });
});
