/**
 * A coding team's last check before it may say "done": the project's OWN test
 * suite, run on the MERGED result (TASK-1321).
 *
 * The harness runs it because nobody else does. A team finished "done" — its
 * visible checks passed, its final review accepted — while the project it
 * delivered failed 11 of its own 56 unittests ("AssertionError: 1 != 0 :
 * 1.609344"; nano-lab1, 2026-09-30, team-59631zvn). Its workers were accepted
 * "by rule; the team's final review checks the merged result", and the final
 * reviewer is a READ-ONLY run: it may not run anything, so it never ran them.
 *
 * Detection is small on purpose, and a project with no suite is left exactly
 * as it was:
 *   - a `test_*.py` at the top, or a `tests/` folder holding a `test*.py` →
 *     `python3 -m unittest discover` — with `-s tests` when `tests/` is not a
 *     package, since discovery from the top only walks into packages and would
 *     find nothing there;
 *   - a `package.json` whose `test` script is a real one (npm's placeholder
 *     that only says "no test specified" is not) → that script, through bun
 *     when the project is locked with bun and through npm otherwise.
 * Each command found runs, in that order, in the harness's own sandbox and
 * inside SUITE_TIMEOUT_MS; the first red one is the verdict.
 *
 * RED: the command ran and exited non-zero, or it was still going at the
 * deadline — a hung suite is not a passing one, as a hung deliverable command
 * is not. NOT JUDGED, which changes nothing about the team: no sandbox on the
 * box, a runner the box does not have (exit 127), a Python suite in which no
 * test ran, and one whose only failures are test modules importing pytest,
 * which unittest cannot run and this box does not have. What was not judged is
 * said on the board; it is never a pass and never a rejection.
 */

import type { Dirent } from "fs";
import fs from "fs/promises";
import path from "@/lib/runtime-path";
import { DELIVERABLE_COMMAND_TIMEOUT_MS, runSandboxed, type DeliverableSandbox, type SandboxedOutcome } from "@/lib/coding-deliverable-check";

/** How long one test command gets: the deliverable command's box, measured on the Orin for real suites. */
export const SUITE_TIMEOUT_MS = DELIVERABLE_COMMAND_TIMEOUT_MS;
/** How much of a suite's output is kept to read the failures from — its tail, where the summary is. */
const SUITE_OUTPUT_CHARS = 64_000;
/** How many failing tests a rejection names; the rest are counted. */
export const MAX_NAMED_TESTS = 10;
/** How much of the first failure's own words a rejection quotes. */
const EXCERPT_CHARS = 400;
/** A board note is one line, cut at 600 characters (`postNote`). */
const NOTE_CHARS = 590;

export type SuiteVerdict =
  /** No suite in the project: nothing ran and nothing changes. */
  | { kind: "none" }
  | { kind: "pass"; command: string; summary: string }
  | {
    kind: "fail";
    command: string;
    /** The runner's own count, e.g. "Ran 56 tests, FAILED (failures=11)". */
    summary: string;
    /** The failing tests by name, in the order the output gave them, each once. */
    failing: string[];
    /** Project-relative files the failure names — a traceback's frames, a failing spec's path. */
    files: string[];
    /** The first failure's own words, or the output's last lines when no failure could be picked out. */
    excerpt: string;
  }
  | { kind: "unjudged"; command: string; reason: string };

// ─── Detection ───────────────────────────────────────────────────────────────

/** npm init's `test` script, which tests nothing. */
const NPM_PLACEHOLDER = /no test specified/i;

/** The test commands this project answers to, in the order they run; empty when it has no suite. */
export async function detectSuites(directory: string): Promise<string[]> {
  const top = await entries(directory);
  const commands = await pythonSuites(directory, top);
  const node = await packageSuite(directory, top);
  if (node) commands.push(node);
  return commands;
}

async function pythonSuites(directory: string, top: Dirent[]): Promise<string[]> {
  const atTop = top.some((e) => e.isFile() && /^test_.*\.py$/.test(e.name));
  let inTests = false;
  let testsIsPackage = false;
  if (top.some((e) => e.isDirectory() && e.name === "tests")) {
    const tests = path.join(directory, "tests");
    const inside = await entries(tests);
    testsIsPackage = inside.some((e) => e.isFile() && e.name === "__init__.py");
    inTests = inside.some((e) => e.isFile() && isPythonTest(e.name));
    // One level down (tests/unit/test_x.py) and no further: small, not a walk.
    for (const sub of inside.filter((e) => e.isDirectory()).slice(0, 20)) {
      if (inTests) break;
      inTests = (await entries(path.join(tests, sub.name))).some((e) => e.isFile() && isPythonTest(e.name));
    }
  }
  if (inTests && !testsIsPackage) {
    // Discovery from the top never enters a folder that is not a package, so
    // `tests/` gets its own start; the top's own test files, if any, theirs.
    return atTop ? ["python3 -m unittest discover", "python3 -m unittest discover -s tests"] : ["python3 -m unittest discover -s tests"];
  }
  return atTop || inTests ? ["python3 -m unittest discover"] : [];
}

/** unittest's own default pattern, `test*.py`. */
function isPythonTest(name: string): boolean {
  return /^test.*\.py$/.test(name);
}

async function packageSuite(directory: string, top: Dirent[]): Promise<string | null> {
  if (!top.some((e) => e.isFile() && e.name === "package.json")) return null;
  let pkg: unknown;
  try {
    pkg = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const scripts = pkg && typeof pkg === "object" ? (pkg as { scripts?: unknown }).scripts : null;
  const test = scripts && typeof scripts === "object" ? (scripts as Record<string, unknown>).test : null;
  if (typeof test !== "string" || !test.trim() || NPM_PLACEHOLDER.test(test)) return null;
  const bun = top.some((e) => e.isFile() && (e.name === "bun.lock" || e.name === "bun.lockb"));
  return bun ? "bun run test" : "npm test";
}

async function entries(directory: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

// ─── Running ─────────────────────────────────────────────────────────────────

/**
 * The project's suite, run on what is in `directory` now. The sandbox is asked
 * for only once there is a suite to run, so a project without one costs a
 * directory listing and nothing else. Never throws.
 */
export async function runProjectSuite(
  directory: string,
  sandbox: () => Promise<DeliverableSandbox | null>,
  timeoutMs: number = SUITE_TIMEOUT_MS,
): Promise<SuiteVerdict> {
  const commands = await detectSuites(directory);
  if (!commands.length) return { kind: "none" };
  let box: DeliverableSandbox | null;
  try {
    box = await sandbox();
  } catch {
    box = null;
  }
  if (!box) return { kind: "unjudged", command: commands.join("; "), reason: "this box has no sandbox (setpriv) to run them in" };
  // A runner prints paths from its own working directory, which the kernel
  // gives it resolved: a folder reached through a symlink is named by its real path.
  const roots = [directory, await fs.realpath(directory).catch(() => directory)];
  const settled: Array<Extract<SuiteVerdict, { kind: "pass" | "unjudged" }>> = [];
  for (const command of commands) {
    let ran: SandboxedOutcome;
    try {
      ran = await runSandboxed(directory, command, box, { timeoutMs, keepChars: SUITE_OUTPUT_CHARS });
    } catch (err) {
      ran = { code: null, output: "", timedOut: false, error: err instanceof Error ? err.message : String(err) };
    }
    const verdict = readSuiteOutput(command, ran, roots, timeoutMs);
    if (verdict.kind === "fail") return verdict;
    if (verdict.kind !== "none") settled.push(verdict);
  }
  const passed = settled.filter((v) => v.kind === "pass");
  if (!passed.length) return settled[0] ?? { kind: "none" };
  // Every command said its piece: a pass, with anything that was not judged beside it.
  return {
    kind: "pass",
    command: passed.map((v) => v.command).join("; "),
    summary: settled.map((v) => (v.kind === "pass" ? (settled.length > 1 ? `${v.command}: ${v.summary}` : v.summary) : `${v.command}: not judged — ${v.reason}`)).join("; "),
  };
}

/** One command's outcome, read, for the project at `directory` (or any of its names). Pure — the tests feed it output. */
export function readSuiteOutput(command: string, ran: SandboxedOutcome, directory: string | readonly string[], timeoutMs: number = SUITE_TIMEOUT_MS): SuiteVerdict {
  const output = ran.output;
  const python = command.startsWith("python3 ");
  if (ran.error !== null) return { kind: "unjudged", command, reason: `it could not be started: ${ran.error}` };
  if (ran.timedOut) {
    return {
      kind: "fail",
      command,
      summary: `did not finish within ${timeoutMs >= 60_000 ? plural(Math.round(timeoutMs / 60_000), "minute") : plural(Math.round(timeoutMs / 1000), "second")}`,
      failing: failingTests(output),
      files: namedFiles(output, directory),
      excerpt: tailLines(output),
    };
  }
  // 127 is the shell's "command not found": the box has no runner for this
  // suite (no python3, a script's tool never installed) — not the team's
  // code failing, and nothing a worker could see from its worktree either.
  if (ran.code === 127) return { kind: "unjudged", command, reason: `the box could not run it (exit 127${lastLine(output) ? `: ${lastLine(output)}` : ""})` };
  if (python && (/^Ran 0 tests\b/m.test(output) || /^NO TESTS RAN\b/m.test(output))) {
    return { kind: "unjudged", command, reason: "no test ran (unittest found no TestCase — tests written for pytest are not run)" };
  }
  if (ran.code === 0) return { kind: "pass", command, summary: passSummary(output, python) };
  if (python && onlyPytestImports(output)) {
    return { kind: "unjudged", command, reason: "the tests are written for pytest, which this box does not have" };
  }
  return {
    kind: "fail",
    command,
    summary: failSummary(output, python, ran.code),
    failing: failingTests(output),
    files: namedFiles(output, directory),
    excerpt: firstFailure(output) || tailLines(output),
  };
}

// ─── Reading the output ──────────────────────────────────────────────────────

/** unittest's failure header: `FAIL: test_x (pkg.mod.Case.test_x) (pair='a')` (3.11+) or `FAIL: test_x (pkg.mod.Case)` (3.10). */
const UNITTEST_FAILURE = /^(?:FAIL|ERROR): (\S+) \(([^)\s]+)\)/;

/**
 * The failing tests' names, in the order the output gave them, each once: a
 * unittest id as `python3 -m unittest <id>` takes it (the 3.10 and the 3.11+
 * headers alike; a subtest counts as its test; a module that could not be
 * imported is named as such), or a JavaScript runner's failing test — vitest's
 * `FAIL file > name`, a `×`/`✗`/`✕`/`✖` line, jest's `●`, TAP's `not ok`.
 */
export function failingTests(output: string): string[] {
  const names: string[] = [];
  const add = (name: string) => {
    const clean = name.trim();
    if (clean && !names.includes(clean)) names.push(clean);
  };
  const marked: string[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const unit = UNITTEST_FAILURE.exec(line);
    if (unit) {
      const [, method, where] = unit;
      if (where.includes("_FailedTest")) add(`${method} (could not be imported)`);
      else add(where === method || where.endsWith(`.${method}`) ? where : `${where}.${method}`);
      continue;
    }
    const vitest = /^FAIL\s+(\S+)\s+>\s+(.+)$/.exec(line);
    if (vitest) { add(`${vitest[1]} > ${stripDuration(vitest[2])}`); continue; }
    const cross = /^[×✗✕✖]\s+(.+)$/.exec(line);
    // node:test's spec reporter heads its recap with a crossed-out "failing tests:".
    if (cross) { if (!/^failing tests:?$/i.test(cross[1].trim())) marked.push(stripDuration(cross[1])); continue; }
    const jest = /^●\s+(.+)$/.exec(line);
    if (jest && !/^Test suite failed to run/.test(jest[1])) { add(jest[1]); continue; }
    const tap = /^not ok \d+\s+-?\s*(.+?)(?:\s+#.*)?$/.exec(line);
    if (tap) add(tap[1]);
  }
  // A crossed-out name vitest also gave with its file is not said twice.
  for (const name of marked) {
    if (!names.some((n) => n.endsWith(` > ${name}`))) add(name);
  }
  return names;
}

function stripDuration(text: string): string {
  return text.replace(/\s+\(?\d+(?:\.\d+)?\s?m?s\)?$/, "").trim();
}

/**
 * Files inside the project the failure names: every absolute path under
 * `directory` — or any other name of it, its real path — in the output (a
 * Python traceback's `File "…"`, a stack frame's `(…:12:5)`), and a JavaScript
 * runner's relative `FAIL path` / `❯ path:line`. Project-relative, each once;
 * nothing under node_modules or a virtualenv.
 */
export function namedFiles(output: string, directory: string | readonly string[]): string[] {
  const roots = [...new Set((typeof directory === "string" ? [directory] : directory).map((d) => d.replace(/\/+$/, "")).filter(Boolean))];
  const files: string[] = [];
  const add = (rel: string) => {
    const clean = rel.replace(/^\.\//, "").replace(/:\d+(?::\d+)?$/, "");
    if (!clean || clean.startsWith("../") || /(^|\/)(node_modules|\.venv|venv|site-packages)\//.test(clean)) return;
    if (!files.includes(clean)) files.push(clean);
  };
  // The longest name first: a root that is a prefix of another must not claim its paths.
  const escaped = roots.sort((a, b) => b.length - a.length).map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length) {
    for (const m of output.matchAll(new RegExp(`(?:${escaped.join("|")})/([^\\s"'():,]+)`, "g"))) add(m[1]);
  }
  for (const m of output.matchAll(/^\s*(?:FAIL|❯)\s+([^\s>]+\.[cm]?[jt]sx?)(?::\d+(?::\d+)?)?/gm)) {
    if (!m[1].startsWith("/")) add(m[1]);
  }
  return files;
}

/** The first failure's own words: an assertion or error line, bounded. */
function firstFailure(output: string): string {
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    // `AssertionError: 1 != 0 : 1.609344`, `ValueError: boom`, node's `AssertionError [ERR_ASSERTION]: …`.
    if (/^[\w.]*(?:Error|Exception)(?:\s*\[[^\]]*\])?(?::|$)/.test(line) && !/^ImportError: Failed to import test module/.test(line)) {
      return clip(line, EXCERPT_CHARS);
    }
  }
  return "";
}

/** unittest's summary lines, or the runner's line that counts passes/failures, or its last line. */
function passSummary(output: string, python: boolean): string {
  if (python) {
    const ran = /^Ran \d+ tests? in [\d.]+s$/m.exec(output)?.[0];
    const ok = /^OK\b.*$/m.exec(output)?.[0];
    if (ran) return `${ran.replace(/ in [\d.]+s$/, "")}${ok ? `, ${ok}` : ""}`;
  }
  return countLine(output, /\b\d+\s+(?:passed|passing|pass)\b|\bpass\s+\d+\b/i) || lastLine(output) || "exit 0";
}

function failSummary(output: string, python: boolean, code: number | null): string {
  if (python) {
    const ran = /^Ran \d+ tests? in [\d.]+s$/m.exec(output)?.[0];
    const failed = /^FAILED \(.*\)$/m.exec(output)?.[0];
    if (ran || failed) return [ran?.replace(/ in [\d.]+s$/, ""), failed].filter(Boolean).join(", ");
  }
  const counted = countLine(output, /\b\d+\s+(?:failed|failing|fail)\b|\bfail\s+\d+\b/i);
  return counted ? `${counted} (exit ${code ?? "without a code"})` : `exit ${code ?? "without a code"}`;
}

/** The LAST line matching `pattern` — runners print their totals at the end. */
function countLine(output: string, pattern: RegExp): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (pattern.test(lines[i])) return clip(lines[i].replace(/\s{2,}/g, " "), 200);
  }
  return "";
}

/**
 * Every failure is a test module that could not import pytest: tests written
 * for pytest, which unittest cannot run, on a box without it. Anything else —
 * a real failure beside them, a module of the project's own that is missing —
 * is red.
 */
function onlyPytestImports(output: string): boolean {
  const headers = output.split("\n").filter((l) => UNITTEST_FAILURE.test(l.trim()));
  if (!headers.length || !headers.every((h) => h.includes("_FailedTest"))) return false;
  const missing = [...output.matchAll(/No module named '([^']+)'/g)].map((m) => m[1].split(".")[0]);
  return missing.length >= headers.length && missing.every((m) => m === "pytest" || m === "_pytest");
}

function lastLine(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? clip(lines[lines.length - 1], 200) : "";
}

/** The output's last few lines on one line, bounded: what is left to quote when no failure could be picked out. */
function tailLines(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean).slice(-6);
  return clip(lines.join(" | "), EXCERPT_CHARS);
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ─── Words ───────────────────────────────────────────────────────────────────

/** The failing tests, named up to MAX_NAMED_TESTS and the rest counted. */
export function namedTests(failing: string[]): string {
  const named = failing.slice(0, MAX_NAMED_TESTS);
  const more = failing.length - named.length;
  return `${named.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

/** `command` — summary: failing, … — the red suite in one breath. */
function redLine(v: Extract<SuiteVerdict, { kind: "fail" }>): string {
  return `${v.command} — ${v.summary}${v.failing.length ? `. Failing: ${namedTests(v.failing)}` : ""}`;
}

/**
 * A red suite as a task's rejection — what its next attempt reads first
 * ("A previous attempt was rejected: …"): the command, the count, the failing
 * tests by name and the first failure's words, and what to do about it.
 */
export function suiteRejection(v: Extract<SuiteVerdict, { kind: "fail" }>): string {
  return [
    `The project's own tests fail on the merged result: ${redLine(v)}.`,
    v.excerpt ? `First failure: ${v.excerpt}` : "",
    `Make the suite pass by fixing what is wrong — never by deleting or weakening a test that checks the goal — and run \`${v.command}\` yourself before you finish.`,
  ].filter(Boolean).join(" ");
}

/** The words a team fails with when its suite is still red and no task is left to offer it to. */
export function suiteFailure(v: Extract<SuiteVerdict, { kind: "fail" }>): string {
  return `The project's own tests fail on the merged result: ${redLine(v)}.${v.excerpt ? ` First failure: ${v.excerpt}` : ""}`;
}

/** The one line the board gets about the suite; `reoffered` names the tasks a red one went back to. */
export function suiteNote(v: Exclude<SuiteVerdict, { kind: "none" }>, reoffered: string[] = []): string {
  switch (v.kind) {
    case "pass":
      return clip(`The project's own tests pass on the merged result: ${v.command} — ${v.summary}.`, NOTE_CHARS);
    case "unjudged":
      return clip(`The project's own tests were not judged (${v.command}): ${v.reason}.`, NOTE_CHARS);
    case "fail": {
      const next = reoffered.length ? ` Offered once more: ${reoffered.join(", ")}.` : "";
      // The re-offer is said even when the names are cut: it is what happens next.
      return `${clip(`The project's own tests fail on the merged result: ${redLine(v)}.`, NOTE_CHARS - next.length)}${next}`;
    }
  }
}
