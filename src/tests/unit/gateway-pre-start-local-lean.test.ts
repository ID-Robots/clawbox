import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";

// Starts a real process (bash / python3 / node): see test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The gateway boot step that installs `clawbox-local-lean` — the OpenClaw
// plugin giving turns on the on-device model a short prompt and six tools —
// enables it, and writes the core's grant its prompt hook needs
// (`plugins.entries.<id>.hooks.allowConversationAccess: true`). Run out of the
// SHIPPED script (the shared installer, then this plugin's section), on every
// boot, never fatal.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const REPO = path.resolve(process.cwd());
const PLUGIN_ID = "clawbox-local-lean";

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasPython3 && hasBash ? describe : describe.skip;

function section(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`${from.trim()} is not in gateway-pre-start.sh`);
  return src.slice(start, end);
}

/** The shared installer (its function only) and this plugin's section. */
function block(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  return [
    section(src, "# ── Installing a ClawBox hook plugin into ~/.openclaw/extensions ", "# ── The protected-path deny hook "),
    // Up to the NEXT section heading, whichever it is: naming the section that
    // follows today breaks this test the day that section moves or goes.
    section(src, "# ── Lean mode for the on-device model ", "\n# ── "),
  ].join("\n");
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

const entries = () => JSON.parse(readFileSync(configPath, "utf-8")).plugins?.entries ?? {};
const installed = () => {
  const target = path.join(openclawHome, "extensions", PLUGIN_ID);
  return existsSync(target) ? readdirSync(target).sort() : [];
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-local-lean-"));
  root = path.join(dir, "clawbox");
  openclawHome = path.join(dir, ".openclaw");
  configPath = path.join(openclawHome, "openclaw.json");
  cpSync(path.join(REPO, "scripts", "openclaw-plugins", PLUGIN_ID), path.join(root, "scripts", "openclaw-plugins", PLUGIN_ID), { recursive: true });
  mkdirSync(openclawHome, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ plugins: { entries: { "clawbox-path-guard": { enabled: true } } } }, null, 2));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

d("the local lean-mode plugin install", () => {
  it("copies the plugin, enables it with the conversation-access grant, and proves the copy loads", () => {
    const r = run();
    expect(r.status).toBe(0);
    // The node self-check found nothing to complain about.
    expect(r.stderr).toBe("");
    expect(installed()).toEqual(["index.mjs", "local-lean.mjs", "openclaw.plugin.json", "package.json"]);
    expect(entries()[PLUGIN_ID]).toEqual({ enabled: true, hooks: { allowConversationAccess: true } });
    // Only this plugin asked for the grant.
    expect(entries()["clawbox-path-guard"]).toEqual({ enabled: true });
  });

  it("writes nothing on the next boot", () => {
    expect(run().status).toBe(0);
    const before = statSync(configPath).mtimeMs;
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already enabled");
    expect(statSync(configPath).mtimeMs).toBe(before);
  });

  it("says so when the installed copy would take the full prompt from a cloud turn", () => {
    const logic = path.join(root, "scripts", "openclaw-plugins", PLUGIN_ID, "local-lean.mjs");
    writeFileSync(logic, readFileSync(logic, "utf-8").replace(
      "return turnProvider(ctx, cfg) === LOCAL_PROVIDER;",
      "return true;",
    ));
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING: the installed clawbox-local-lean plugin did not load/);
  });

  it("never stops the gateway: a missing plugin file is said, and nothing is enabled for it", () => {
    rmSync(path.join(root, "scripts", "openclaw-plugins", PLUGIN_ID, "local-lean.mjs"));
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING: .*local-lean\.mjs is missing/);
    expect(entries()[PLUGIN_ID]).toBeUndefined();
  });
});
