import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";

// Starts a real process (bash / python3): see test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// `clawbox-backup-scope`: a manifest-only OpenClaw plugin whose
// `backupResources` tell `openclaw backup create` which state and agent
// folders it may leave out and rebuild — ClawKeep's snapshot is that command.
// The manifest is checked against the core's documented contract for the field
// (docs/plugins/manifest/surfaces.md in the pinned 2026.10.3 core), and the
// SHIPPED boot step is run to see it installed and enabled on a 2026.10 core
// and left alone on an older one.

const REPO = path.resolve(process.cwd());
const SCRIPT = path.join(REPO, "scripts/gateway-pre-start.sh");
const PLUGIN_ID = "clawbox-backup-scope";
const PLUGIN_DIR = path.join(REPO, "scripts", "openclaw-plugins", PLUGIN_ID);

interface BackupResource {
  disposition: string;
  scope: string;
  relativePath: string;
}

const manifest = () => JSON.parse(readFileSync(path.join(PLUGIN_DIR, "openclaw.plugin.json"), "utf-8"));

describe("the clawbox-backup-scope manifest", () => {
  it("declares only closed, strictly relative backup resources, as the core requires", () => {
    const resources: BackupResource[] = manifest().backupResources;
    expect(resources.length).toBeGreaterThan(0);
    for (const r of resources) {
      expect(Object.keys(r).sort()).toEqual(["disposition", "relativePath", "scope"]);
      expect(["include", "regenerable"]).toContain(r.disposition);
      expect(["state", "agent"]).toContain(r.scope);
      // Not empty or absolute; no backslash, NUL, empty segment, `.` or `..`,
      // drive, UNC or URI-like prefix — the planner rejects any of them.
      expect(r.relativePath).toMatch(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/);
      for (const segment of r.relativePath.split("/")) expect([".", ".."]).not.toContain(segment);
      expect(r.relativePath).not.toMatch(/^[A-Za-z]:|:\/\//);
    }
    const keys = resources.map((r) => `${r.scope}:${r.relativePath}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("leaves out update downloads, the box's own archives and the Codex caches — and nothing a restore needs", () => {
    const regenerable = (manifest().backupResources as BackupResource[])
      .filter((r) => r.disposition === "regenerable")
      .map((r) => `${r.scope}:${r.relativePath}`);
    expect(regenerable).toEqual(expect.arrayContaining([
      "state:upgrades",
      "state:backups",
      "agent:codex-home/.cache",
      "agent:codex-home/cache",
      "agent:codex-home/log",
    ]));
    for (const kept of ["state:agents", "state:workspace", "state:credentials", "state:state", "state:extensions",
      "agent:codex-home", "agent:codex-home/sessions", "agent:codex-home/auth.json", "agent:openclaw-agent.sqlite"]) {
      expect(regenerable).not.toContain(kept);
    }
  });

  it("is a plugin the loader accepts: its id everywhere, a default export with register()", async () => {
    const pkg = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "package.json"), "utf-8"));
    expect(manifest().id).toBe(PLUGIN_ID);
    expect(pkg.name).toBe(PLUGIN_ID);
    expect(pkg.openclaw.extensions).toEqual(["./index.mjs"]);
    const plugin = (await import(path.join(PLUGIN_DIR, "index.mjs"))).default;
    expect(plugin.id).toBe(PLUGIN_ID);
    expect(typeof plugin.register).toBe("function");
    expect(() => plugin.register({ on: () => { throw new Error("registers nothing"); } })).not.toThrow();
  });
});

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
    section(src, "# ── What a backup can leave out ", "# ── Default skills ("),
  ].join("\n");
}

let dir: string;
let root: string;
let openclawHome: string;
let configPath: string;

function run(core2026_10: "0" | "1"): { status: number; stdout: string; stderr: string } {
  const program = [
    "set -euo pipefail",
    `CLAWBOX_ROOT=${JSON.stringify(root)}`,
    `OPENCLAW_CONFIG=${JSON.stringify(configPath)}`,
    `OPENCLAW_HOME_DIR=${JSON.stringify(openclawHome)}`,
    `CLAWBOX_OPENCLAW_2026_10=${core2026_10}`,
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

d("the boot step that installs clawbox-backup-scope", () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "clawbox-backup-scope-"));
    root = path.join(dir, "clawbox");
    openclawHome = path.join(dir, ".openclaw");
    configPath = path.join(openclawHome, "openclaw.json");
    cpSync(PLUGIN_DIR, path.join(root, "scripts", "openclaw-plugins", PLUGIN_ID), { recursive: true });
    mkdirSync(openclawHome, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ plugins: { entries: { "clawbox-path-guard": { enabled: true } } } }, null, 2));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("copies the plugin and enables it on a 2026.10 core, and leaves the other entries alone", () => {
    const r = run("1");
    expect(r.status).toBe(0);
    expect(installed()).toEqual(["index.mjs", "openclaw.plugin.json", "package.json"]);
    expect(entries()[PLUGIN_ID]).toEqual({ enabled: true });
    expect(entries()["clawbox-path-guard"]).toEqual({ enabled: true });
    expect(readFileSync(path.join(openclawHome, "extensions", PLUGIN_ID, "openclaw.plugin.json"), "utf-8"))
      .toBe(readFileSync(path.join(PLUGIN_DIR, "openclaw.plugin.json"), "utf-8"));

    // Every boot: a second pass changes nothing.
    const before = readFileSync(configPath, "utf-8");
    expect(run("1").status).toBe(0);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("hands an older core no manifest it may not read", () => {
    const before = readFileSync(configPath, "utf-8");
    const r = run("0");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/not installed — the core predates 2026\.10/);
    expect(installed()).toEqual([]);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });
});
