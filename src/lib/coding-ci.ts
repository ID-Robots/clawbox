/**
 * A pull request's FAILED CI, read — what a single run's "Fix CI"
 * continuation and a coding team's re-offer are told (owner's brief,
 * 2026-10-11).
 *
 * "3 of 5 checks failed" is a fact about the pull request, not something a
 * run can act on: the failing jobs' logs are, and what is worth handing over
 * from them is which tests failed, which files the failure names, and the
 * tail where the error is. The fetching is coding-review.ts's
 * (`readFailedCheckLogs`: one bounded `gh run view --log-failed` per workflow
 * run, at most a handful, the tail kept); everything here is pure, so the
 * tests feed it real Actions output.
 *
 * And it is BOUNDED: a run gets MAX_CI_FIX_ATTEMPTS continuations for one
 * pull request, a team MAX_TEAM_CI_ROUNDS rounds — never a loop that pushes
 * fixes at a red CI for ever.
 */

import { failingTests } from "@/lib/coding-team-suite";
import type { FailedCheckLog } from "@/lib/coding-review-state";

export { MAX_CI_FIX_ATTEMPTS, MAX_TEAM_CI_ROUNDS } from "@/lib/coding-ci-limits";
/** At most this many failing tests are named. */
export const MAX_CI_TESTS = 12;
/** At most this many files the failure names are kept. */
export const MAX_CI_FILES = 20;
/** The tail of the failed logs handed over, in characters. */
export const CI_EXCERPT_CHARS = 2_400;

/** A failed CI, read: what failed, which tests, which files, and the end of the log. */
export interface CiFailure {
  prNumber: number;
  /** When it was read (ms). */
  at: number;
  /** The failing checks' names. */
  checks: string[];
  /** The failing tests' names, as the runner printed them. */
  tests: string[];
  /** The files the failure names, relative to the repository. */
  files: string[];
  /** The tail of the failed jobs' logs. */
  excerpt: string;
  /** Failing checks whose log could not be read (no Actions URL, an expired log). */
  unread: string[];
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** `2026-10-11T10:00:00.1234567Z ` — the timestamp Actions puts on every log line. */
const STAMP = /^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

/**
 * `gh run view --log-failed` without its bookkeeping: each line comes as
 * `<job>\t<step>\t<timestamp> <text>`, coloured; what a reader (and
 * `failingTests`) wants is the text.
 */
export function cleanActionsLog(raw: string): string {
  return raw
    .split("\n")
    .map((line) => {
      const cols = line.split("\t");
      const text = cols.length >= 3 ? cols.slice(2).join("\t") : line;
      return text.replace(STAMP, "").replace(ANSI, "").replace(/\r$/, "");
    })
    .join("\n");
}

/**
 * A runner's checkout prefix: `/home/runner/work/<repo>/<repo>/` on a hosted
 * runner, `/__w/<repo>/<repo>/` in a container job. What follows is the path
 * in the repository.
 */
const CHECKOUT = /^(?:\/home\/runner\/work|\/__w|\/github\/workspace)\/(?:[^/\s]+\/[^/\s]+\/)?/;
const SOURCE_PATH = /(?:^|[\s("'`[=])((?:\/|\.{1,2}\/)?(?:[\w@.+-]+\/)+[\w@.+-]+\.[A-Za-z][A-Za-z0-9]{0,5})(?::\d+){0,2}/g;
const PY_FRAME = /\bFile "([^"]+\.py)"/g;
/** A test runner's own line naming a file — vitest's `FAIL app.test.js > …`, `❯ app.js:3:1` — root-level files included. */
const RUNNER_FILE = /^\s*(?:FAIL|❯|×|✗|✕)\s+([^\s>]+\.[A-Za-z][A-Za-z0-9]{0,5})(?::\d+){0,2}(?:\s|$)/;
/** A file at the repository's root, named with a line number: `app.js:3`, `(convert.py:12)`. */
const ROOT_FILE_LINE = /(?:^|[\s("'`[])([\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,5}):\d+/g;

/**
 * The files a CI log names, relative to the repository, in order, each once:
 * a test file in a runner's FAIL line, a frame of a stack or a traceback.
 * A runner's checkout prefix is taken off; a path anywhere else on the runner
 * (a toolchain, node_modules, a URL) is not the repository's and is left out.
 */
export function ciFiles(text: string): string[] {
  const files: string[] = [];
  const add = (raw: string) => {
    let p = raw.trim();
    if (!p || /^[a-z]+:\/\//i.test(p) || p.includes("://")) return;
    if (p.startsWith("/")) {
      const m = CHECKOUT.exec(p);
      if (!m) return;
      p = p.slice(m[0].length);
    }
    p = p.replace(/^(\.\/)+/, "");
    if (!p || p.startsWith("../") || /(^|\/)(node_modules|\.venv|venv|site-packages|dist-packages)\//.test(p)) return;
    if (!files.includes(p)) files.push(p);
  };
  for (const line of text.split("\n")) {
    for (const m of line.matchAll(PY_FRAME)) add(m[1]);
    const runner = RUNNER_FILE.exec(line);
    if (runner) add(runner[1]);
    for (const m of line.matchAll(SOURCE_PATH)) {
      // A URL's path part is not a file in the repository.
      const before = line.slice(0, m.index ?? 0);
      if (/https?:\/\/\S*$/.test(before)) continue;
      add(m[1]);
    }
    for (const m of line.matchAll(ROOT_FILE_LINE)) {
      // A version (`node:20.11`) or a host (`localhost:3000`) is not a file.
      if (/^\d|^(?:localhost|node|python|https?)\b/i.test(m[1])) continue;
      add(m[1]);
    }
    if (files.length >= MAX_CI_FILES) break;
  }
  return files.slice(0, MAX_CI_FILES);
}

/** The tail of a log, cut at a line boundary, at most `max` characters. */
function tail(text: string, max: number): string {
  const trimmed = text.replace(/\n{3,}/g, "\n\n").trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(trimmed.length - max);
  const nl = cut.indexOf("\n");
  return `…${nl >= 0 ? cut.slice(nl) : cut}`;
}

/** What failed on pull request `prNumber`, from the failing checks' logs. */
export function readCiFailure(prNumber: number, logs: readonly FailedCheckLog[], now = Date.now()): CiFailure {
  const checks = [...new Set(logs.map((l) => l.check.name).filter(Boolean))];
  const unread = [...new Set(logs.filter((l) => !l.log).map((l) => l.check.name))];
  // One log per workflow run is fetched and shared by the checks it covers:
  // read once.
  const texts = [...new Set(logs.map((l) => l.log).filter((l): l is string => Boolean(l)))].map(cleanActionsLog);
  const text = texts.join("\n");
  return {
    prNumber,
    at: now,
    checks,
    tests: failingTests(text).slice(0, MAX_CI_TESTS),
    files: ciFiles(text),
    excerpt: tail(text, CI_EXCERPT_CHARS),
    unread,
  };
}

/** One line of what failed — the board's, the feed's, the status tool's. */
export function ciFailureLine(failure: Pick<CiFailure, "prNumber" | "checks" | "tests">): string {
  const checks = failure.checks.length ? failure.checks.join(", ") : "its checks";
  const tests = failure.tests.length ? `; failing tests: ${failure.tests.slice(0, 5).join(", ")}${failure.tests.length > 5 ? `, and ${failure.tests.length - 5} more` : ""}` : "";
  return `CI failed on pull request #${failure.prNumber}: ${checks}${tests}`;
}

/**
 * What the run that fixes it is told — appended to a "Fix CI" continuation's
 * task, or the notes a team's re-offered task goes back with. `push`: a single
 * run pushes its own branch (the pull request updates); a team's worker never
 * pushes — the orchestrator does, once the team has the fix.
 */
export function ciFixNotes(failure: CiFailure, opts: { push: boolean; excerptChars?: number }): string {
  const lines = [`${ciFailureLine(failure)}.`];
  if (failure.tests.length) lines.push(`Failing tests:\n${failure.tests.map((t) => `- ${t}`).join("\n")}`);
  if (failure.files.length) lines.push(`Files the failure names: ${failure.files.join(", ")}`);
  if (failure.unread.length) lines.push(`No log could be read for: ${failure.unread.join(", ")} — look at those checks on GitHub with \`gh pr checks ${failure.prNumber}\`.`);
  const excerpt = opts.excerptChars !== undefined ? tail(failure.excerpt, opts.excerptChars) : failure.excerpt;
  if (excerpt) lines.push(`The failed jobs' log ends:\n${excerpt}`);
  lines.push(opts.push
    ? `Fix what makes these checks fail — run the failing tests yourself where you can — then commit and push the branch so pull request #${failure.prNumber} updates. Fix the cause, not the test.`
    : "Fix what makes these checks fail — run the failing tests yourself where you can — and commit in your own folder. Do not push: the team's orchestrator pushes the fix and watches the checks again. Fix the cause, not the test.");
  return lines.join("\n\n");
}

/**
 * Does a team's goal ask for a pull request? Its words, not a guess: "open a
 * PR", "a pull request", or a merge — which needs one. A team whose goal says
 * nothing of it leaves its work on the team's branch, as every team did.
 */
export function goalWantsPullRequest(goal: string): boolean {
  return /\bpull[\s-]?requests?\b/i.test(goal) || /\bPRs?\b/.test(goal) || goalWantsMerge(goal);
}

/**
 * Does a team's goal ask for its pull request to be MERGED? "…and merge it",
 * "merge when green" — but not "do not merge", "without merging", "leave it
 * unmerged" or "for review only". Only then does the orchestrator merge, and
 * only once every task is accepted, the suite is green, the final review
 * passed and every check on the pull request passes.
 */
export function goalWantsMerge(goal: string): boolean {
  if (!/\bmerg(?:e|es|ed|ing)\b|\bauto-?merge\b/i.test(goal)) return false;
  if (/\b(?:do\s+not|don['’]?t|never|without|no|not|nor|but\s+not)\s+(?:\w+\s+){0,3}?merg/i.test(goal)) return false;
  if (/\bunmerged\b|\bfor\s+review\s+only\b|\bleave\s+(?:it|the\s+(?:pr|pull\s+request))\s+open\b/i.test(goal)) return false;
  // About the pull request, never any merge: "merge the two config files"
  // is a task for the code, and reading it as consent to merge would publish
  // a team's work nobody asked to publish.
  return MERGE_ASKS.some((re) => re.test(goal));
}

/** The ways a goal asks for its pull request's merge. */
const MERGE_ASKS: readonly RegExp[] = [
  /\bmerge\s+(?:it|this|them|that|my\s+(?:pr|pull\s+request)|the\s+(?:pr|pull\s+request|branch|changes?|work|fix(?:es)?))\b/i,
  /\bmerge\b[^.;\n]*\b(?:pr|pull\s+request)\b/i,
  /\b(?:pr|pull\s+request)\b[^.;\n]*\bmerged?\b/i,
  /\bmerge\s+(?:it\s+)?(?:when|once|after|if)\s+(?:it['’]?s\s+|the\s+|all\s+)?(?:green|ci|checks?|tests?|everything|it\s+passes)\b/i,
  /\b(?:and|then)\s+merge(?:\s+it)?\s*(?:[.!,;]|$)/i,
  /\bauto-?merge\b/i,
];
