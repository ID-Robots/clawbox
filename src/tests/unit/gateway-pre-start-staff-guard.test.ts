import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { testEnv } from "@/tests/helpers/env";

// gateway-pre-start.sh installs clawbox-staff-guard (TASK-2444, TASK-2445) the
// way it installs every ClawBox hook plugin — the policy table copied in
// beside it, the plugin enabled by name — and proves the INSTALLED copy loads
// and refuses a staff write outside the member's folder while leaving the
// owner's agent alone. Run on the shipped installer and the staff-guard section
// only, against a checkout holding just the pieces it reads.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const REPO = path.resolve(process.cwd());
const PLUGIN_ID = "clawbox-staff-guard";

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const hasNode = spawnSync("node", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasPython3 && hasNode ? describe : describe.skip;

function slice(from: string, to: string): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`no section between ${from} and ${to}`);
  return src.slice(start, end);
}

/** The installer function and the staff guard's own section, nothing between. */
function block(): string {
  return [
    slice("# ── Installing a ClawBox hook plugin into ~/.openclaw/extensions ", "# ── The protected-path deny hook "),
    slice("# ── The staff guard (TASK-2444, TASK-2445) ", "# ── Field cleanup: retired ClawBox plugins "),
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
  const r = spawnSync("bash", ["-c", program], { encoding: "utf-8", env: testEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin" }), timeout: 60_000 });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-staff-guard-"));
  root = path.join(dir, "clawbox");
  openclawHome = path.join(dir, ".openclaw");
  configPath = path.join(openclawHome, "openclaw.json");
  mkdirSync(path.join(root, "config"), { recursive: true });
  cpSync(path.join(REPO, "scripts", "openclaw-plugins", PLUGIN_ID), path.join(root, "scripts", "openclaw-plugins", PLUGIN_ID), { recursive: true });
  cpSync(path.join(REPO, "config", "org-staff-policy.json"), path.join(root, "config", "org-staff-policy.json"));
  mkdirSync(openclawHome, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ plugins: { entries: {} } }, null, 2));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

d("gateway-pre-start.sh — the staff guard", () => {
  it("installs the plugin with the policy table beside it, enables it, and the installed copy passes its own check", () => {
    const r = run();
    expect(r.status).toBe(0);
    const target = path.join(openclawHome, "extensions", PLUGIN_ID);
    expect(readdirSync(target).sort()).toEqual(["index.mjs", "openclaw.plugin.json", "org-staff-policy.json", "package.json", "staff-guard.mjs"]);
    expect(JSON.parse(readFileSync(configPath, "utf-8")).plugins.entries[PLUGIN_ID].enabled).toBe(true);
    expect(r.stderr).toBe("");
  });

  it("says so, and never stops the gateway, when the table is missing from the checkout", () => {
    rmSync(path.join(root, "config", "org-staff-policy.json"));
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("not a complete plugin");
    expect(existsSync(path.join(openclawHome, "extensions", PLUGIN_ID))).toBe(false);
  });
});
