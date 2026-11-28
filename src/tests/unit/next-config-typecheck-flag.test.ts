import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs a real `git grep` over the tree and Next's own config loader in a child
// node: vitest's 5 s test and 10 s hook defaults are not enough on a loaded CI
// runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `next build`'s own type check is 77 s of a 113 s build on an 8 GB board.
 * install.sh's run_next_build puts CLAWBOX_BUILD_SKIP_TYPECHECK=1 on the build
 * command for one tree only — a checkout ON beta or main at origin's fetched
 * tip with nothing changed, a tree whose pull requests CI already type-checked
 * — and =0 on every other build it runs. next.config.ts turns exactly 1, as
 * the build was STARTED with, into Next's `typescript.ignoreBuildErrors`: a
 * line in the checkout's `.env`, which Next loads into the environment before
 * it reads next.config.ts, is not the switch. Everything else that builds the
 * app (CI, the nano lab's force-update.sh, the x64 rebuilds, a developer) puts
 * nothing on its command, so it keeps the check unless an export in the
 * account's own environment says 1: the variable unset is the half these tests
 * pin.
 */

const REPO = path.resolve(__dirname, "../../..");
const FLAG = "CLAWBOX_BUILD_SKIP_TYPECHECK";

/**
 * What `next build` does before it decides on the type check, in a fresh node
 * so @next/env starts as empty as it does in a build: load the `.env` files
 * (Next's own loader; the directory is a scratch one, so the checkout's own
 * files are never read), then load next.config.ts through Next's own config
 * loader, whose env load finds that one already done — as the build's does.
 */
const LOADER = `
const path = require("node:path");
const [repo, envDir] = process.argv.slice(1);
const quiet = { info() {}, warn() {}, error() {} };
require(path.join(repo, "node_modules/@next/env")).loadEnvConfig(envDir, false, quiet);
const loadConfig = require(path.join(repo, "node_modules/next/dist/server/config")).default;
const { PHASE_PRODUCTION_BUILD } = require(path.join(repo, "node_modules/next/constants"));
loadConfig(PHASE_PRODUCTION_BUILD, repo, { silent: true }).then(
  (config) => process.stdout.write(JSON.stringify({ typescript: config.typescript, flag: process.env.${FLAG} ?? null })),
  (err) => { console.error(err); process.exit(2); },
);
`;

let envDir: string;
beforeEach(() => {
  envDir = mkdtempSync(path.join(tmpdir(), "next-config-env-"));
});
afterEach(() => {
  rmSync(envDir, { recursive: true, force: true });
});

/**
 * next.config's typescript block as `next build` reads it, started with
 * `command` (the variable in the build command's own environment, or unset)
 * over a checkout whose `.env` holds `dotenv` (or no such line), and the
 * variable as the build's environment holds it after the `.env` load.
 */
function buildReads(start: { command?: string; dotenv?: string }) {
  if (start.dotenv !== undefined) writeFileSync(path.join(envDir, ".env"), `${FLAG}=${start.dotenv}\n`, "utf-8");
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
  delete env[FLAG];
  if (start.command !== undefined) env[FLAG] = start.command;
  const r = spawnSync(process.execPath, ["-e", LOADER, REPO, envDir], { cwd: REPO, encoding: "utf-8", env });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as {
    typescript: { ignoreBuildErrors?: boolean; tsconfigPath?: string };
    flag: string | null;
  };
}

describe("next.config skips the build's type check only when the build command says 1", () => {
  it("skips it for CLAWBOX_BUILD_SKIP_TYPECHECK=1 on the command, over the same tsconfig", () => {
    const built = buildReads({ command: "1" });
    expect(built.typescript.ignoreBuildErrors).toBe(true);
    expect(built.typescript.tsconfigPath).toBe("tsconfig.build.json");
  });

  it("does not skip it for CLAWBOX_BUILD_SKIP_TYPECHECK=1 in the checkout's .env", () => {
    const built = buildReads({ dotenv: "1" });
    // The line was loaded: the build's environment carries it by now.
    expect(built.flag).toBe("1");
    expect(built.typescript.ignoreBuildErrors ?? false).toBe(false);
    expect(built.typescript.tsconfigPath).toBe("tsconfig.build.json");
  });

  it("goes by the command over the .env either way", () => {
    expect(buildReads({ command: "1", dotenv: "0" }).typescript.ignoreBuildErrors).toBe(true);
    // install.sh's keep path: =0 on the command.
    expect(buildReads({ command: "0", dotenv: "1" }).typescript.ignoreBuildErrors ?? false).toBe(false);
  });

  // Unset is every build outside install.sh's run_next_build, the x64 ones included.
  it.each([["unset", undefined], ["0", "0"], ["true", "true"], ["empty", ""]])(
    "keeps it when the variable is %s",
    (_what, value) => {
      const built = buildReads({ command: value });
      expect(built.typescript.ignoreBuildErrors ?? false).toBe(false);
      expect(built.typescript.tsconfigPath).toBe("tsconfig.build.json");
    },
  );
});

describe("nothing but install.sh's run_next_build sets it", () => {
  it("is named only by next.config.ts, install.sh and the tests", () => {
    // Every tracked file but the x64 installer and its migration scripts,
    // which this change leaves alone. No allowlist beyond that: a workflow,
    // scripts/check-build-isolation.sh, scripts/force-update.sh, playwright or
    // e2e setting it would build without the type check CI is relied on for.
    const r = spawnSync(
      "git",
      ["-C", REPO, "grep", "-l", "-I", "-F", FLAG, "--", ".", ":!install-x64.sh", ":!scripts/x64-migration/"],
      { encoding: "utf-8" },
    );
    // 1 is "no match", which is a finding below, not a crash here.
    expect([0, 1], r.stderr).toContain(r.status);
    const files = r.stdout.split("\n").filter(Boolean);
    expect(files).toContain("next.config.ts");
    expect(files).toContain("install.sh");
    expect(files.filter((f) => f !== "next.config.ts" && f !== "install.sh" && !f.startsWith("src/tests/"))).toEqual([]);
  });

  it("is set inside run_next_build and nowhere else in install.sh, and never exported", () => {
    const installSh = readFileSync(path.join(REPO, "install.sh"), "utf-8");
    const start = installSh.search(/^run_next_build\(\) \{$/m);
    expect(start).toBeGreaterThan(-1);
    const end = installSh.indexOf("\n}", start);
    let offset = 0;
    const outside = installSh.split("\n").flatMap((line) => {
      const at = offset;
      offset += line.length + 1;
      if (!line.includes(FLAG) || line.trim().startsWith("#")) return [];
      return at > start && at < end ? [] : [line.trim()];
    });
    expect(outside).toEqual([]);
    expect(installSh).not.toMatch(new RegExp(`export\\s+${FLAG}`));
  });
});
