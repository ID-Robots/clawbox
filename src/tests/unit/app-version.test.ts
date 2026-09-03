import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * The shipped ClawBox version, and the build chain that carries it.
 *
 * `package.json` is the authored source of the release number, and the bump is
 * taken with `npm version <x> --no-git-tag-version`, which rewrites it and the
 * two copies `package-lock.json` keeps of the root version. What this test
 * proves is that the number then REACHES the surface the owner reads:
 *
 *   package.json → scripts/write-build-info.mjs → .next/build-info.json
 *                → collectBuildIdentity() → the About / build-identity panel
 *
 * Not covered here, deliberately. `src/lib/updater.ts` `readClawboxVersion()`
 * re-reads package.json at RUNTIME and prefixes a "v" before it becomes
 * `clawbox.current` on /setup-api/update/status — the prefix that
 * `getVersionInfo`'s `/^(v\d+\.\d+\.\d+)/` baseTag extraction depends on.
 * Driving that hop against the real manifest would need `getVersionInfo()`,
 * which also shells out to `git ls-remote origin` and spawns `openclaw
 * --version`; the existing updater tests reach it only by mocking `readFile`
 * wholesale, which proves the fixture rather than the file. Closing it needs a
 * seam the updater does not have today.
 *
 * `NEXT_PUBLIC_APP_VERSION` is a SEPARATE version surface and is not this
 * number: next.config.ts bakes it from `git describe --tags --always` at build
 * time. It is only a fallback (updater.ts, and SettingsApp when the runtime
 * read is null), and it has already drifted — v3.9.0 is not an ancestor of
 * beta, so a clean clone describes as v3.1.11-<n>-g<sha>. Out of scope here.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");

/**
 * The release this branch ships, pinned on purpose.
 *
 * This is a second place the number is written, and `npm version` does not
 * maintain it: a future `npm version 4.1.0 --no-git-tag-version` turns this
 * suite red until the literal below moves too. That is the intent — the bump
 * is a deliberate release act, and a stamped expectation is what makes an
 * accidental or half-applied one fail loudly instead of shipping a box that
 * announces the previous release. Bumping the version is therefore two edits:
 * `npm version <x> --no-git-tag-version`, then this constant.
 */
const EXPECTED_VERSION = "4.0.0";

function readJson(rel: string): { version?: string; packages?: Record<string, { version?: string }> } {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8"));
}

describe("shipped version", () => {
  it("package.json names the release", () => {
    expect(readJson("package.json").version).toBe(EXPECTED_VERSION);
  });

  // CI and the device both install from bun.lock (`bun install
  // --frozen-lockfile`), which records no root version at all, so this cannot
  // break an install. package-lock.json is kept for Dependabot's security PRs
  // and the dependency graph — and those read the version it reports, so a
  // hand-edit that moves one of its two copies and not the other leaves the
  // repo describing itself inconsistently to everything downstream of it.
  it("package-lock.json agrees, in both places it records the root version", () => {
    const lock = readJson("package-lock.json");
    expect(lock.version).toBe(EXPECTED_VERSION);
    expect(lock.packages?.[""]?.version).toBe(EXPECTED_VERSION);
  });
});

describe("build identity reports the shipped version", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-version-"));
    // The REAL package.json, so this asserts on the shipped file rather than a
    // fixture that can agree with a stale number forever.
    fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(dir, "package.json"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stamps package.json's version into build-info.json", () => {
    const run = spawnSync("node", [path.join(REPO_ROOT, "scripts/write-build-info.mjs")], {
      cwd: dir,
      env: { ...process.env, CLAWBOX_ROOT: dir },
      encoding: "utf-8",
    });
    expect(run.status, run.stderr).toBe(0);

    const info = JSON.parse(fs.readFileSync(path.join(dir, ".next", "build-info.json"), "utf-8"));
    expect(info.packageVersion).toBe(EXPECTED_VERSION);
  });
});
