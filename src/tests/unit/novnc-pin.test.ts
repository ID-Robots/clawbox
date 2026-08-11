import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * @novnc/novnc is consumed through deep subpath imports — `@novnc/novnc/lib/rfb`
 * in VNCApp and `@novnc/novnc/lib/input/keysymdef` in src/lib/vnc-keys.ts.
 * Those subpaths are not a stable public API:
 *
 *   - 1.6.0 ships `lib/` and declares no `exports` field, so any file inside the
 *     package is importable.
 *   - 1.7.0 moves `lib/` to `core/` AND adds `"exports": "./core/rfb.js"` — a
 *     single-entry map. Under that map every subpath is refused with
 *     ERR_PACKAGE_PATH_NOT_EXPORTED, including the rewritten `core/...` path, so
 *     there is no drop-in specifier to move to.
 *
 * vnc-keys.ts is pulled into the unit suite, so an unusable @novnc/novnc does not
 * merely break VNC — it stops the whole build and test run. bun.lock pins 1.6.0,
 * but a RANGE in package.json would let `bun update`, or any npm-based install,
 * pick 1.7.0 up on the next resolve. These tests fail if the pin is loosened, if
 * the installed copy drifts, or if the source grows a subpath import the
 * installed copy cannot serve.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PACKAGE = "@novnc/novnc";

// The last version that ships `lib/` with no `exports` map. Written literally
// rather than read back from package.json, so loosening the pin cannot make
// this test vacuously agree with itself.
const PINNED_VERSION = "1.6.0";

// Resolve exactly the way the app does — from the repo root, against the
// installed tree. require.resolve honours `exports`, so it refuses on 1.7.0.
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));

function readJson(...segments: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, ...segments), "utf8"));
}

// Application sources only. src/tests is skipped deliberately: this very file
// names both specifiers in its comments, and vnc-app.test.tsx names one in a
// vi.mock call, so scanning the tests would let the suite satisfy its own
// "still deep-imports" guard after the real imports were gone.
const TESTS_DIR = path.join(REPO_ROOT, "src", "tests");

function sourceFiles(dir: string): string[] {
  if (dir === TESTS_DIR) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

// Discover the specifiers rather than hard-coding them, so a newly added deep
// import is covered by these tests the day it lands instead of the day it breaks.
// Only quoted specifiers count — a module-specifier position in an import, an
// import(), or a `declare module` — so prose mentioning a path cannot stand in
// for code importing it.
const SUBPATH_SPECIFIERS = [
  ...new Set(
    sourceFiles(path.join(REPO_ROOT, "src")).flatMap((file) => [
      ...readFileSync(file, "utf8").matchAll(/["'](@novnc\/novnc\/[\w./-]+)["']/g),
    ].map((match) => match[1])),
  ),
].sort();

describe("@novnc/novnc pin", () => {
  it("pins an exact version in package.json", () => {
    const dependencies = readJson("package.json").dependencies as Record<string, string>;

    // A range here is the whole bug: bun.lock would still say 1.6.0 until the
    // next resolve, and then quietly move to a version that cannot be imported.
    expect(dependencies[PACKAGE]).toBe(PINNED_VERSION);
  });

  it("records the same exact version in bun.lock", () => {
    const declared = readFileSync(path.join(REPO_ROOT, "bun.lock"), "utf8");

    expect(declared).toContain(`"${PACKAGE}": "${PINNED_VERSION}"`);
  });

  it("has the pinned version installed", () => {
    const installed = readJson("node_modules", "@novnc", "novnc", "package.json");

    expect(installed.version).toBe(PINNED_VERSION);
  });

  it("still deep-imports the package", () => {
    // Guards the test below from passing vacuously: if the source stops using
    // subpath imports there is nothing left to protect and this file should go.
    expect(SUBPATH_SPECIFIERS).toContain(`${PACKAGE}/lib/input/keysymdef`);
    expect(SUBPATH_SPECIFIERS).toContain(`${PACKAGE}/lib/rfb`);
  });

  it.each(SUBPATH_SPECIFIERS)("resolves %s against the installed copy", (specifier) => {
    // Resolution only — importing lib/rfb for real would need browser globals.
    // Resolution is the property 1.7.0 breaks, so it is the property to assert.
    expect(() => requireFromRepo.resolve(specifier)).not.toThrow();
  });
});
