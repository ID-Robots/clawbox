#!/usr/bin/env node
/**
 * Stamp the build with the commit it was produced from.
 *
 * `next build` already writes `.next/BUILD_ID`, but that value is an opaque
 * random-ish string: it proves two asset sets are *different*, never which
 * source they came from. A ClawBox that serves a build from one commit while
 * its checkout sits on another therefore had no way to say so — the box on
 * which this was first found served routes that existed in no commit on its
 * branch, and 404'd two features whose source was on disk.
 *
 * So the build records its own identity, next to the build, at build time:
 *   .next/build-info.json                      (canonical)
 *   .next/standalone/.next/build-info.json     (copied by the postbuild step —
 *                                               that is the tree the server
 *                                               actually runs from)
 *
 * `buildId` is recorded INSIDE the file so a reader can tell whether the stamp
 * belongs to the assets sitting next to it. Without that cross-check the file
 * is just another out-of-band claim, which is exactly what it replaces.
 *
 * Never fails the build: a file with nulls is still useful (it dates the build
 * and proves the stamp ran), and a git failure on a customer device must not
 * turn a working update into a red one. CI asserts on the CONTENT — see
 * scripts/verify-build-identity.sh — so a null commit is caught there.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const projectDir = process.env.CLAWBOX_ROOT || process.cwd();
const nextDir = path.join(projectDir, ".next");

/**
 * git output, or null if the command FAILED. Empty output is not failure —
 * `git status --porcelain` answers "" on a clean tree, and folding that into
 * null recorded every healthy build as `dirty: null` ("could not tell").
 */
function git(...args) {
  try {
    return execFileSync("git", ["-c", `safe.directory=${projectDir}`, "-C", projectDir, ...args], {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** git output where an empty answer is as useless as a failure (a SHA, a branch name). */
function gitValue(...args) {
  return git(...args) || null;
}

function readFirstLine(file) {
  try {
    return fs.readFileSync(file, "utf-8").trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

/**
 * The Hermes agent pin lives in install.sh (see HERMES_PIN_COMMIT, PR #431).
 * Read it rather than duplicating the SHA here — a second copy is a second
 * thing to forget to bump.
 */
function readHermesPin() {
  try {
    const raw = fs.readFileSync(path.join(projectDir, "install.sh"), "utf-8");
    return raw.match(/^HERMES_PIN_COMMIT="\$\{HERMES_PIN_COMMIT:-([0-9a-fA-F]{40})\}"/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

const commit = gitValue("rev-parse", "HEAD");
// `dirty` answers exactly one question: were the TRACKED files this build was
// compiled from the ones the commit above describes? So it is sampled with
// --untracked-files=no.
//
// It used to be plain --porcelain, which counts untracked files too, and on a
// real device that made the flag useless: a QA operator's stray `.deployed-sha`
// in the project root stamped `dirty: true` on two consecutive builds made from
// provably clean trees (hwtest-round1, 2026-08-24). A flag that is true on
// healthy builds teaches operators to ignore it.
//
// Untracked files are still reported — as their own count, in their own field —
// because an untracked file under src/app/ IS a route the next build would
// serve. That is a different statement from "this build does not match its
// commit", and it now reads as one. The drift engine
// (src/lib/build-identity.ts) keeps counting untracked files in the CHECKOUT's
// dirtiness; that is a deliberate, separate choice about the tree on disk now,
// not about the tree this build came from.
const status = git("status", "--porcelain", "--untracked-files=no");
const untrackedOut = git("ls-files", "--others", "--exclude-standard");
const untracked = untrackedOut === null
  ? null
  : (untrackedOut ? untrackedOut.split("\n").filter(Boolean).length : 0);

const info = {
  commit,
  shortCommit: commit ? commit.slice(0, 7) : null,
  branch: gitValue("rev-parse", "--abbrev-ref", "HEAD"),
  dirty: status === null ? null : status.length > 0,
  /** How many untracked files sat in the tree at build time. Not part of `dirty` — see above. */
  untracked,
  committedAt: gitValue("log", "-1", "--format=%cI"),
  builtAt: new Date().toISOString(),
  buildId: readFirstLine(path.join(nextDir, "BUILD_ID")),
  node: process.version,
  bun: process.versions.bun ?? null,
  packageVersion: (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf-8")).version ?? null;
    } catch {
      return null;
    }
  })(),
  hermesPin: readHermesPin(),
  openclawPin: readFirstLine(path.join(projectDir, "config", "openclaw-target.txt")),
};

fs.mkdirSync(nextDir, { recursive: true });
const target = path.join(nextDir, "build-info.json");
fs.writeFileSync(target, `${JSON.stringify(info, null, 2)}\n`);
console.log(
  `  build-info.json: commit=${info.shortCommit ?? "unknown"} branch=${info.branch ?? "unknown"}` +
  `${info.dirty ? " (dirty)" : ""}${info.untracked ? ` (${info.untracked} untracked)` : ""}` +
  ` buildId=${info.buildId ?? "unknown"}`,
);
