#!/usr/bin/env node
// Both lockfiles still describe package.json — in seconds, with no install.
//
//   node scripts/check-lockfiles.mjs            # the working tree
//   node scripts/check-lockfiles.mjs --staged   # what `git commit` is about to record
//
// A change to package.json that does not carry its lockfiles with it used to
// be found by src/tests/unit/lockfiles-in-sync.test.ts — minutes into a vitest
// shard, after every runner had installed and started the suite (TASK-1401).
// This is the same first comparison, run where it is cheap: as the first step
// of the CI jobs (pr-tests-coverage.yml) and as a pre-commit hook
// (scripts/hooks/pre-commit). The vitest case stays; it also checks the
// resolved tree, which this does not.
//
//   bun.lock           workspaces[""] carries the manifest's dependency blocks.
//                      `bun install --frozen-lockfile` refuses the install
//                      when they differ, which is what CI and install.sh run.
//   package-lock.json  packages[""] carries them too, plus name and version —
//                      npm's own first test before `npm ci`. Nothing installs
//                      from it, but it is the manifest GitHub's dependency
//                      graph (and so Dependabot's alerts) reads.
//
// The fix it prints for either: `bun install` and
// `npm install --package-lock-only --ignore-scripts`, then commit both files.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staged = process.argv.includes("--staged");
const BLOCKS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function read(name) {
  if (staged) {
    // The index, not the working tree: a fix made but not `git add`ed is not
    // in the commit, and a check that read the disk would pass it anyway.
    return execFileSync("git", ["show", `:${name}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }
  return readFileSync(path.join(ROOT, name), "utf8");
}

/** bun.lock is JSON with trailing commas. */
function parseJsonc(text) {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
}

/** Same keys, same values — order does not matter, `{}` and absent are the same. */
function blockDiff(want = {}, got = {}) {
  const out = [];
  for (const key of new Set([...Object.keys(want), ...Object.keys(got)])) {
    if (want[key] !== got[key]) out.push(`${key}: package.json ${want[key] ?? "(absent)"}, lockfile ${got[key] ?? "(absent)"}`);
  }
  return out;
}

const problems = [];
const pkg = JSON.parse(read("package.json"));

const bunRoot = parseJsonc(read("bun.lock")).workspaces?.[""];
if (!bunRoot) problems.push("bun.lock: no root workspace entry (workspaces[\"\"])");
else {
  for (const block of BLOCKS) {
    for (const d of blockDiff(pkg[block], bunRoot[block])) problems.push(`bun.lock ${block} — ${d}`);
  }
}

const lock = JSON.parse(read("package-lock.json"));
const npmRoot = lock.packages?.[""];
if (!npmRoot) problems.push("package-lock.json: no root package entry (packages[\"\"])");
else {
  for (const block of BLOCKS.filter((b) => b !== "peerDependencies")) {
    for (const d of blockDiff(pkg[block], npmRoot[block])) problems.push(`package-lock.json ${block} — ${d}`);
  }
  for (const [where, value] of [["packages[\"\"].name", npmRoot.name], ["name", lock.name]]) {
    if (value !== pkg.name) problems.push(`package-lock.json ${where} is ${value}, package.json says ${pkg.name}`);
  }
  for (const [where, value] of [["packages[\"\"].version", npmRoot.version], ["version", lock.version]]) {
    if (value !== pkg.version) problems.push(`package-lock.json ${where} is ${value}, package.json says ${pkg.version}`);
  }
}

if (problems.length) {
  const gha = process.env.GITHUB_ACTIONS === "true";
  for (const p of problems) console.error(gha ? `::error title=Lockfile out of sync::${p}` : `  ${p}`);
  console.error(
    `\nThe lockfiles do not match package.json${staged ? " (as staged)" : ""}. Run\n`
    + "  bun install\n"
    + "  npm install --package-lock-only --ignore-scripts\n"
    + "and commit package.json, bun.lock and package-lock.json together.",
  );
  process.exit(1);
}
console.log(`lockfiles in sync with package.json${staged ? " (staged)" : ""}`);
