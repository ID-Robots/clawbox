import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";

// Starts a real process (bash / python3 / node): vitest's 5 s test and 10 s
// hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The gateway boot reconcile that installs the protected-path deny hook of
// TASK-605 into the OpenClaw core (`clawbox-path-guard`), enables it, and
// exercises the copy it just made.
//
// It runs the BLOCK OUT OF THE SHIPPED SCRIPT rather than a copy, like every
// other gateway-pre-start suite, so a drift between the two fails here.
//
// The three failure shapes it pins:
//
//   probe-once    — ~/.openclaw does not survive a factory reset, so the copy,
//                   the enable and the check all run on EVERY gateway start.
//   false success — `plugins.entries.<id>.enabled: true` says nothing about a
//                   guard whose rule table did not arrive. The config is
//                   written only after the files are on disk, and the installed
//                   copy is asked to refuse a model-folder delete before this
//                   boot claims the box is protected.
//   false failure — none of it may stop the gateway. This is an ExecStartPre
//                   under `set -euo pipefail`, so every failure above still
//                   leaves exit 0 and a box with an agent.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const REPO = path.resolve(process.cwd());
const PLUGIN_ID = "clawbox-path-guard";
const TABLE_REL = path.join("config", "protected-paths.json");

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasPython3 && hasBash ? describe : describe.skip;

/** The shipped installer and the path-guard section that follows it. */
function block(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const from = "# ── Installing a ClawBox hook plugin into ~/.openclaw/extensions ";
  const to = "# ── The outbound EMAIL:-directive hook plugin ";
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error("the path-guard install block is not in gateway-pre-start.sh");
  return src.slice(start, end);
}

let dir: string;
let root: string;
let openclawHome: string;
let configPath: string;

function run(): { status: number; stdout: string; stderr: string } {
  const program = [
    "set -euo pipefail",
    `CLAWBOX_ROOT=${JSON.stringify(root)}`,
    `OPENCLAW_CONFIG=${JSON.stringify(configPath)}`,
    `OPENCLAW_HOME_DIR=${JSON.stringify(openclawHome)}`,
    block(),
  ].join("\n");
  const r = spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin" }),
    timeout: 60_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function installedFiles(): string[] {
  const target = path.join(openclawHome, "extensions", PLUGIN_ID);
  return existsSync(target) ? readdirSync(target).sort() : [];
}

function enabled(): unknown {
  const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
  return cfg.plugins?.entries?.[PLUGIN_ID]?.enabled;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-guard-"));
  root = path.join(dir, "clawbox");
  openclawHome = path.join(dir, ".openclaw");
  configPath = path.join(openclawHome, "openclaw.json");

  // A checkout with just the pieces this block reads.
  mkdirSync(path.join(root, "config"), { recursive: true });
  cpSync(
    path.join(REPO, "scripts", "openclaw-plugins", PLUGIN_ID),
    path.join(root, "scripts", "openclaw-plugins", PLUGIN_ID),
    { recursive: true },
  );
  cpSync(path.join(REPO, TABLE_REL), path.join(root, TABLE_REL));

  mkdirSync(openclawHome, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ plugins: { entries: {} } }, null, 2));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

d("gateway-pre-start.sh — the protected-path deny hook", () => {
  it("installs the plugin with its rule table and enables it", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(installedFiles()).toEqual([
      "index.mjs",
      "openclaw.plugin.json",
      "package.json",
      "path-guard.mjs",
      "protected-paths.json",
    ]);
    expect(enabled()).toBe(true);
    expect(r.stderr).toBe("");
  });

  it("puts it back on the next boot after a factory reset emptied ~/.openclaw", () => {
    run();
    // `removeDirectoryContents(OPENCLAW_DIR)` in setup/reset takes the whole
    // extensions tree; nothing else on the box would restore the guard.
    rmSync(path.join(openclawHome, "extensions"), { recursive: true, force: true });
    writeFileSync(configPath, JSON.stringify({}, null, 2));
    expect(installedFiles()).toEqual([]);

    const r = run();
    expect(r.status).toBe(0);
    expect(installedFiles()).toContain("protected-paths.json");
    expect(enabled()).toBe(true);
  });

  it("refuses to enable a plugin whose rule table is missing", () => {
    rmSync(path.join(root, TABLE_REL));
    const r = run();
    // Never fatal — an ExecStartPre that failed here would cost the box its
    // agent over a guard.
    expect(r.status).toBe(0);
    expect(installedFiles()).toEqual([]);
    expect(enabled()).toBeUndefined();
    expect(r.stderr).toContain("not a complete plugin");
    expect(r.stderr).toContain("NOT protected");
  });

  it("says so when the installed copy does not refuse a model-folder delete", () => {
    // A table that parses and protects nothing: the enable would still succeed
    // and the boot log would still be clean if nothing exercised the copy.
    writeFileSync(
      path.join(root, TABLE_REL),
      JSON.stringify({
        pathRoots: [],
        pathTerminators: "/ ",
        verbFirstTokens: ["rm "],
        pathFirstTokens: ["rm "],
        redirectionPrefixes: [">~"],
      }),
    );
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("did not load or did not refuse a model-folder delete");
  });

  it("leaves an installed copy alone when the sources cannot be read", () => {
    run();
    expect(installedFiles()).toContain("index.mjs");

    // The updater rewriting the checkout, or a permission slip: the last copy
    // that worked is better than no guard at all.
    const source = path.join(root, "scripts", "openclaw-plugins", PLUGIN_ID, "index.mjs");
    chmodSync(source, 0o000);
    try {
      const r = run();
      expect(r.status).toBe(0);
      expect(installedFiles()).toContain("index.mjs");
      expect(r.stderr).toContain("leaving whatever is already installed in place");
    } finally {
      chmodSync(source, 0o644);
    }
  });

  it("is a no-op on the config once the plugin is enabled", () => {
    run();
    const first = readFileSync(configPath, "utf-8");
    const r = run();
    expect(r.stdout).toContain("already enabled");
    expect(readFileSync(configPath, "utf-8")).toBe(first);
  });
});
