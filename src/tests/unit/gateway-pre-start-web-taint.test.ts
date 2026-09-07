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

// Starts a real process (bash / node): vitest's 5 s test and 10 s hook defaults
// are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The gateway boot reconcile that installs the taint-then-approve gate of
// TASK-735 (`clawbox-web-taint`) into the OpenClaw core, enables it, and
// exercises the copy it just made.
//
// It runs the BLOCKS OUT OF THE SHIPPED SCRIPT rather than a copy, like every
// other gateway-pre-start suite, so a drift between the two fails here. The
// shared installer lives in its own section above the path guard's, so the
// program below is the installer plus this plugin's section — the path guard is
// gateway-pre-start-path-guard.test.ts's subject and its warnings would only
// muddy the stderr assertions here.
//
// The three failure shapes it pins:
//
//   probe-once    — ~/.openclaw does not survive a factory reset, so the copy,
//                   the enable and the check all run on EVERY gateway start.
//   false success — `plugins.entries.<id>.enabled: true` says nothing about a
//                   gate that answers "no opinion" to everything. The installed
//                   copy is asked to gate a shell call after a web read, and to
//                   leave a clean turn alone, before this boot claims the path
//                   is closed.
//   false failure — none of it may stop the gateway. This is an ExecStartPre
//                   under `set -euo pipefail`, so every failure above still
//                   leaves exit 0 and a box with an agent.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const REPO = path.resolve(process.cwd());
const PLUGIN_ID = "clawbox-web-taint";

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasBash && hasPython3 ? describe : describe.skip;

/** One section of the shipped script, by its heading and the next heading. */
function section(from: string, to: string): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`${from} is not in gateway-pre-start.sh`);
  return src.slice(start, end);
}

/** The shared installer, then the web-taint section — not the path guard's. */
function block(): string {
  return (
    section(
      "# ── Installing a ClawBox hook plugin into ~/.openclaw/extensions ",
      "# ── The protected-path deny hook ",
    ) + section("# ── The web-taint approval gate ", "# ── The outbound EMAIL:-directive hook plugin ")
  );
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

function sourceFile(name: string): string {
  return path.join(root, "scripts", "openclaw-plugins", PLUGIN_ID, name);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-taint-"));
  root = path.join(dir, "clawbox");
  openclawHome = path.join(dir, ".openclaw");
  configPath = path.join(openclawHome, "openclaw.json");

  // A checkout with just the pieces this block reads.
  cpSync(
    path.join(REPO, "scripts", "openclaw-plugins", PLUGIN_ID),
    path.join(root, "scripts", "openclaw-plugins", PLUGIN_ID),
    { recursive: true },
  );

  mkdirSync(openclawHome, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ plugins: { entries: {} } }, null, 2));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

d("gateway-pre-start.sh — the web-taint approval gate", () => {
  it("installs the plugin and enables it", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(installedFiles()).toEqual(["index.mjs", "openclaw.plugin.json", "package.json", "web-taint.mjs"]);
    expect(enabled()).toBe(true);
    expect(r.stderr).toBe("");
  });

  it("puts it back on the next boot after a factory reset emptied ~/.openclaw", () => {
    run();
    // `removeDirectoryContents(OPENCLAW_DIR)` in setup/reset takes the whole
    // extensions tree; nothing else on the box would restore the gate.
    rmSync(path.join(openclawHome, "extensions"), { recursive: true, force: true });
    writeFileSync(configPath, JSON.stringify({}, null, 2));
    expect(installedFiles()).toEqual([]);

    const r = run();
    expect(r.status).toBe(0);
    expect(installedFiles()).toContain("index.mjs");
    expect(enabled()).toBe(true);
  });

  it("refuses to enable a plugin whose rule module is missing", () => {
    rmSync(sourceFile("web-taint.mjs"));
    const r = run();
    // Never fatal — an ExecStartPre that failed here would cost the box its
    // agent over a gate.
    expect(r.status).toBe(0);
    expect(installedFiles()).toEqual([]);
    expect(enabled()).toBeUndefined();
    expect(r.stderr).toContain("not a complete plugin");
    expect(r.stderr).toContain("WITHOUT asking the owner");
  });

  it("says so when the installed copy does not gate a tainted shell call", () => {
    // A gate whose web-content list no longer contains anything the probe
    // reads: it installs, it enables, it registers both hooks, and it answers
    // "no opinion" to every call. Nothing but exercising the copy that landed
    // tells the difference between that and a working gate.
    const src = readFileSync(sourceFile("web-taint.mjs"), "utf-8").replace(
      '"web_fetch",\n  "web_search",',
      '"never_called_fetch",\n  "never_called_search",',
    );
    writeFileSync(sourceFile("web-taint.mjs"), src);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("did not load or did not gate a shell call after a web read");
  });

  it("says so when the installed copy gates a turn that read nothing", () => {
    // The other direction, and the one a security fix is most tempted to ship:
    // a gate that asks about everything looks safe and is a box whose owner is
    // asked to approve `uptime`.
    const src = readFileSync(sourceFile("index.mjs"), "utf-8").replace(
      "if (!cannotProveClean && sources.length === 0) return undefined;",
      "",
    );
    expect(src).not.toContain("sources.length === 0");
    writeFileSync(sourceFile("index.mjs"), src);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("did not load or did not gate a shell call after a web read");
  });

  it("leaves an installed copy alone when the sources cannot be read", () => {
    run();
    expect(installedFiles()).toContain("index.mjs");

    // The updater rewriting the checkout, or a permission slip: the last copy
    // that worked is better than no gate at all.
    chmodSync(sourceFile("index.mjs"), 0o000);
    try {
      const r = run();
      expect(r.status).toBe(0);
      expect(installedFiles()).toContain("index.mjs");
      expect(r.stderr).toContain("leaving whatever is already installed in place");
    } finally {
      chmodSync(sourceFile("index.mjs"), 0o644);
    }
  });

  it("does not enable a plugin it could not install", () => {
    // A destination that cannot be created: the config must not name a plugin
    // the gateway cannot import.
    writeFileSync(path.join(openclawHome, "extensions"), "not a directory");
    const r = run();
    expect(r.status).toBe(0);
    expect(enabled()).toBeUndefined();
    expect(r.stderr).toContain("could not install");
    expect(r.stderr).toContain("WITHOUT asking the owner");
  });
});
