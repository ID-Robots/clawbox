import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `package-lock.json` must still describe `package.json`.
 *
 * Nothing in this repo installs from it: CI and `install.sh` both build with
 * `bun install --frozen-lockfile`, and `grep -rn "npm ci"` over `.github/`
 * finds nothing. Dependabot does not maintain it either — the npm ecosystem is
 * `open-pull-requests-limit: 0` in `.github/dependabot.yml`, so a grouped bun
 * bump moves `package.json` and `bun.lock` and leaves this file where it was.
 *
 * It still has to be right. It is the manifest GitHub's dependency graph reads,
 * so most of the repository's Dependabot alerts are filed against it — a copy
 * that no longer matches `package.json` makes those verdicts describe a tree
 * nobody ships. And a contributor who reaches for npm gets nothing but
 *
 *   npm error `npm ci` can only install packages when your package.json and
 *   npm error package-lock.json or npm-shrinkwrap.json are in sync.
 *
 * which is the state beta was in on 2026-09-18: `package.json` asked for
 * playwright ^1.63.0, `bun.lock` carried 1.63.0, this file still said ^1.62.1.
 *
 * The check is npm's own first test — the root package entry, `packages[""]`,
 * carries a copy of the three dependency blocks and `npm ci` compares them —
 * so it catches the drift at the same place npm does, in a unit suite that
 * already runs on every PR.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, name), "utf8"));
}

const DEPENDENCY_BLOCKS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

describe("package-lock.json agrees with package.json", () => {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  const root = (lock.packages as Record<string, Record<string, unknown>>)[""];

  it("has a root package entry to compare against", () => {
    expect(root).toBeTypeOf("object");
  });

  for (const block of DEPENDENCY_BLOCKS) {
    it(`declares the same ${block}`, () => {
      // Absent on both sides is agreement; `{}` and undefined are not the same
      // to toEqual, so normalise before comparing.
      expect(root[block] ?? {}).toEqual(pkg[block] ?? {});
    });
  }

  it("pins the same name and version as the manifest", () => {
    expect(root.name).toBe(pkg.name);
    expect(root.version).toBe(pkg.version);
    expect(lock.name).toBe(pkg.name);
    expect(lock.version).toBe(pkg.version);
  });

  it("resolves every package.json dependency to a version inside its declared range", () => {
    // The root entry could agree while the resolved tree lags — which is the
    // other half of what `npm ci` refuses. Checked for the top-level packages
    // only: a transitive range is the lockfile's own business.
    const packages = lock.packages as Record<string, { version?: string }>;
    const offenders: string[] = [];
    for (const block of DEPENDENCY_BLOCKS) {
      for (const [name, range] of Object.entries((pkg[block] ?? {}) as Record<string, string>)) {
        const resolved = packages[`node_modules/${name}`]?.version;
        if (!resolved) continue; // an optional dependency the tree does not carry
        if (!satisfiesSimpleRange(resolved, range)) offenders.push(`${name}: ${range} -> ${resolved}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Enough of semver for the ranges this manifest actually uses — `^x.y.z` and a
 * bare `x.y.z` pin. A range in any other shape is not judged here rather than
 * judged wrongly; the root-entry comparison above still covers it.
 */
function satisfiesSimpleRange(version: string, range: string): boolean {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10));
  if (/^\d+\.\d+\.\d+$/.test(range)) return version === range;
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!caret) return true;
  const [major, minor, patch] = caret.slice(1).map(Number);
  const [vMajor, vMinor, vPatch] = parse(version);
  if (!Number.isFinite(vMajor) || !Number.isFinite(vMinor) || !Number.isFinite(vPatch)) return true;
  if (vMajor !== major) return false;
  if (vMinor !== minor) return vMinor > minor;
  return vPatch >= patch;
}
