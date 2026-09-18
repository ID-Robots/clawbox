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
 * already runs on every PR. Npm's FIRST test, not all of them: this is the
 * manifest-versus-root-entry comparison plus the top-level resolved tree
 * (`resolvedTreeOffenders` below), and it is not a substitute for `npm ci`
 * itself, which also verifies integrity hashes and the whole transitive tree.
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
    expect(resolvedTreeOffenders(pkg, lock)).toEqual([]);
  });
});

/**
 * Every top-level dependency whose entry in the resolved tree disagrees with
 * the manifest, or is missing from it.
 *
 * The root entry could agree while the resolved tree lags — which is the other
 * half of what `npm ci` refuses. Checked for the top-level packages only: a
 * transitive range is the lockfile's own business.
 *
 * A dependency with no `node_modules/<name>` entry is an OFFENDER unless the
 * manifest declared it optional. `npm ci` answers "Missing: X from lock file"
 * for that, and skipping it in silence is how a lockfile whose `packages[""]`
 * was hand-edited to agree with `package.json` passes a suite that exists to
 * catch exactly that edit.
 */
function resolvedTreeOffenders(
  pkg: Record<string, unknown>,
  lock: Record<string, unknown>,
): string[] {
  const packages = (lock.packages ?? {}) as Record<string, { version?: string } | undefined>;
  const optional = new Set(Object.keys((pkg.optionalDependencies ?? {}) as Record<string, string>));
  const offenders: string[] = [];
  for (const block of DEPENDENCY_BLOCKS) {
    for (const [name, range] of Object.entries((pkg[block] ?? {}) as Record<string, string>)) {
      const resolved = packages[`node_modules/${name}`]?.version;
      if (!resolved) {
        if (!optional.has(name)) offenders.push(`${name}: ${range} -> missing from the lockfile tree`);
        continue;
      }
      if (!satisfiesSimpleRange(resolved, range)) offenders.push(`${name}: ${range} -> ${resolved}`);
    }
  }
  return offenders;
}

/**
 * The two halves above are only worth what the range judge is worth, and this
 * repo's manifest carries the shapes a hand-rolled caret gets wrong: `^0.11.0`
 * (where the MINOR is the breaking level) and the partial `^2`/`^1`.
 */
describe("the range judge these checks are built on", () => {
  const cases: [version: string, range: string, satisfied: boolean][] = [
    // A caret on a 0.x range stops at the next MINOR, not the next major:
    // `^0.11.0` is `>=0.11.0 <0.12.0`. Both @xterm add-ons are declared this
    // way, so judging them as `<1.0.0` would pass a lockfile npm refuses.
    ["0.11.4", "^0.11.0", true],
    ["0.12.0", "^0.11.0", false],
    ["0.11.9", "^0.12.0", false],
    // `^0.0.x` stops at the next PATCH.
    ["0.0.3", "^0.0.3", true],
    ["0.0.4", "^0.0.3", false],
    // A partial caret — `@noble/ed25519 ^2`, `@noble/hashes ^1`.
    ["2.3.1", "^2", true],
    ["3.0.0", "^2", false],
    ["1.9.9", "^2", false],
    ["1.8.0", "^1.7", true],
    ["1.6.9", "^1.7", false],
    // The ordinary case, and an exact pin (`@novnc/novnc`).
    ["1.63.0", "^1.62.1", true],
    ["1.62.0", "^1.62.1", false],
    ["2.0.0", "^1.62.1", false],
    ["1.7.0", "1.7.0", true],
    ["1.7.1", "1.7.0", false],
  ];
  for (const [version, range, satisfied] of cases) {
    it(`${satisfied ? "accepts" : "refuses"} ${version} for ${range}`, () => {
      expect(satisfiesSimpleRange(version, range)).toBe(satisfied);
    });
  }

  // A shape this judge cannot read is an OFFENDER, not a pass. Passing it was
  // a silent hole for every `~x.y.z`, `>=`, `*` and `npm:` range a future
  // manifest might carry.
  it("refuses a range shape it cannot read rather than waving it through", () => {
    for (const range of ["~1.2.3", ">=1.2.3", "*", "npm:other@^1.0.0", "1.2.3 - 2.0.0", ""]) {
      expect(satisfiesSimpleRange("1.2.3", range), `${range} must not pass`).toBe(false);
    }
  });

  it("refuses a resolved version that is not three numbers", () => {
    expect(satisfiesSimpleRange("1.2.3-beta.1", "^1.2.3")).toBe(false);
    expect(satisfiesSimpleRange("latest", "^1.2.3")).toBe(false);
  });
});

describe("the resolved-tree scan", () => {
  const lockOf = (tree: Record<string, { version: string }>) => ({
    packages: { "": {}, ...Object.fromEntries(Object.entries(tree).map(([n, v]) => [`node_modules/${n}`, v])) },
  });

  it("reports a dependency the tree does not carry at all", () => {
    const offenders = resolvedTreeOffenders({ dependencies: { left: "^1.0.0" } }, lockOf({}));
    expect(offenders).toEqual(["left: ^1.0.0 -> missing from the lockfile tree"]);
  });

  it("does not report an OPTIONAL dependency the tree does not carry", () => {
    const offenders = resolvedTreeOffenders(
      { optionalDependencies: { fsevents: "^2.3.2" } },
      lockOf({}),
    );
    expect(offenders).toEqual([]);
  });

  it("reports a resolved version outside its range", () => {
    const offenders = resolvedTreeOffenders(
      { dependencies: { playwright: "^1.63.0" } },
      lockOf({ playwright: { version: "1.62.1" } }),
    );
    expect(offenders).toEqual(["playwright: ^1.63.0 -> 1.62.1"]);
  });
});

/**
 * Enough of semver for the shapes this manifest uses — `^x[.y[.z]]` and a bare
 * `x.y.z` pin — and FALSE for everything else.
 *
 * A shape it cannot read is refused rather than waved through: this judge is
 * the only thing standing between a hand-edited lockfile and a green suite, so
 * "I don't know" has to read as "look at it", not as "fine". The day the
 * manifest grows a `~x.y.z`, a `>=` or an `npm:` alias, the offender list says
 * so by name and this function gets the case it needs.
 *
 * The caret is npm's, not a major-only approximation: the breaking level is the
 * leftmost NON-ZERO part, so `^0.11.0` is `>=0.11.0 <0.12.0` (both @xterm
 * add-ons are declared that way) and `^0.0.3` is `>=0.0.3 <0.0.4`. A missing
 * part is a zero for the lower bound and an `x` for the upper — `^2` is
 * `>=2.0.0 <3.0.0` (@noble/ed25519, @noble/hashes).
 */
function satisfiesSimpleRange(version: string, range: string): boolean {
  const resolved = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!resolved) return false;
  const parts = /^(\^?)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range);
  if (!parts) return false;
  const [, caret, majorText, minorText, patchText] = parts;
  const major = Number(majorText);
  const minor = minorText === undefined ? 0 : Number(minorText);
  const patch = patchText === undefined ? 0 : Number(patchText);
  const actual: [number, number, number] = [Number(resolved[1]), Number(resolved[2]), Number(resolved[3])];
  const compare = (a: readonly number[], b: readonly number[]) =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

  // An exact pin is an exact pin, and a partial one (`1.7`) is a range this
  // judge does not read.
  if (!caret) return minorText !== undefined && patchText !== undefined && compare(actual, [major, minor, patch]) === 0;

  if (compare(actual, [major, minor, patch]) < 0) return false;
  let upper: [number, number, number];
  if (major > 0) upper = [major + 1, 0, 0];
  else if (minorText === undefined) upper = [1, 0, 0];
  else if (minor > 0) upper = [0, minor + 1, 0];
  else if (patchText === undefined) upper = [0, 1, 0];
  else upper = [0, 0, patch + 1];
  return compare(actual, upper) < 0;
}
