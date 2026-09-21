import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { testEnv } from "@/tests/helpers/env";

// Starts a real process (bash / python3): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * scripts/register-mcp.sh §3 HONOURS the owner's switch for the ClawBox MCP
 * server (Settings → Harness, 2026-09-15).
 *
 * `production-server.js` runs this script at every web-server boot and it
 * used to write `mcp_servers.clawbox` unconditionally — so the boot after
 * `/setup-api/harness/mcp` removed the entry would have put it straight
 * back. Pinned: `clawbox_mcp_enabled: false` in data/config.json removes an
 * existing entry, writes none into a config that has none, and leaves the
 * rest of §3 (the distractor skills, the clarify window) landing as before;
 * the key absent or true registers as it always did, and a store that exists
 * but cannot be read leaves the registration exactly as it is.
 */

const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(REPO, "scripts", "register-mcp.sh");

function have(bin: string, args: string[]): boolean {
  return spawnSync(bin, args, { stdio: "ignore" }).status === 0;
}

const CAN_RUN =
  process.platform !== "win32"
  && have("bash", ["-c", "true"])
  && have("python3", ["-c", "import yaml"]);

const d = CAN_RUN ? describe : describe.skip;

let home: string;
let root: string;
let configPath: string;
let lockPath: string;
let storePath: string;

function run(env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf-8",
    env: testEnv({
      PATH: process.env.PATH ?? "",
      HOME: home,
      CLAWBOX_ROOT: root,
      HERMES_CONFIG: configPath,
      HERMES_BIN: path.join(home, "fake-hermes"),
      BUN_BIN: path.join(home, "fake-bun"),
      CLAWBOX_EDITION_FILE: lockPath,
      ...env,
    }),
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Read the YAML back as JSON so the assertions are about values, not formatting. */
function readConfig(): Record<string, unknown> {
  const out = execFileSync(
    "python3",
    ["-c", "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1])) or {}))", configPath],
    { encoding: "utf-8" },
  );
  return JSON.parse(out);
}

function servers(): Record<string, unknown> | undefined {
  return readConfig().mcp_servers as Record<string, unknown> | undefined;
}

const REGISTERED_YAML = [
  "model:",
  "  default: deepseek-v4-pro",
  "mcp_servers:",
  "  clawbox:",
  "    command: /old/bun",
  "    args: [run, /old/entry.ts]",
  "    enabled: true",
  "  other:",
  "    url: http://example.invalid",
  "",
].join("\n");

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-regsw-home-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-regsw-root-"));
  configPath = path.join(home, ".hermes", "config.yaml");
  lockPath = path.join(home, "edition.env");
  storePath = path.join(root, "data", "config.json");

  fs.mkdirSync(path.join(root, "mcp"), { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "mcp", "clawbox-mcp.ts"), "// stand-in\n");
  for (const bin of ["fake-hermes", "fake-bun"]) {
    const p = path.join(home, bin);
    fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(p, 0o755);
  }
  fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
  fs.writeFileSync(lockPath, "CLAWBOX_EDITION=hermes\n");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

d("register-mcp.sh — the MCP switch", () => {
  it("removes an existing registration when the switch is off, and keeps everything else", () => {
    fs.writeFileSync(configPath, REGISTERED_YAML);
    fs.writeFileSync(storePath, JSON.stringify({ clawbox_mcp_enabled: false }));
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(servers()).toEqual({ other: { url: "http://example.invalid" } });
    expect(readConfig().model).toEqual({ default: "deepseek-v4-pro" });
    expect(r.stdout).toMatch(/switched off in Settings; removed mcp_servers\.clawbox/);
    expect(r.stdout).toMatch(/removed the ClawBox MCP server from the Hermes config/);
    expect(r.stdout).not.toMatch(/registered the ClawBox MCP server/);
  });

  it("writes no registration into a config that has none when the switch is off", () => {
    fs.writeFileSync(configPath, "model:\n  default: deepseek-v4-pro\n");
    fs.writeFileSync(storePath, JSON.stringify({ clawbox_mcp_enabled: false }));
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(servers()?.clawbox).toBeUndefined();
    expect(r.stdout).toMatch(/switched off in Settings; leaving it unregistered/);
  });

  it("still lands the rest of §3 while the switch is off", () => {
    // The distractor skills and the clarify window are not the MCP server's,
    // and an owner who switched the tools off has not asked for the bundled
    // email skills back.
    fs.writeFileSync(configPath, "model:\n  default: deepseek-v4-pro\n");
    fs.writeFileSync(storePath, JSON.stringify({ clawbox_mcp_enabled: false }));
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const cfg = readConfig();
    expect((cfg.skills as { disabled: string[] }).disabled).toContain("himalaya");
    expect((cfg.agent as { clarify_timeout: number }).clarify_timeout).toBe(300);
  });

  it("registers as it always did when the store has no such key", () => {
    fs.writeFileSync(configPath, "model:\n  default: deepseek-v4-pro\n");
    fs.writeFileSync(storePath, JSON.stringify({ setup_complete: true }));
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const entry = servers()?.clawbox as Record<string, unknown>;
    expect(entry.command).toBe(path.join(home, "fake-bun"));
    expect(entry.args).toEqual(["run", path.join(root, "mcp", "clawbox-mcp.ts")]);
    expect(r.stdout).toMatch(/registered the ClawBox MCP server with Hermes/);
  });

  it("registers when the switch is explicitly on, when the store is missing, and for any value but the boolean false", () => {
    for (const store of [JSON.stringify({ clawbox_mcp_enabled: true }), null, JSON.stringify({ clawbox_mcp_enabled: "false" })]) {
      fs.writeFileSync(configPath, "model:\n  default: deepseek-v4-pro\n");
      fs.rmSync(storePath, { force: true });
      if (store !== null) fs.writeFileSync(storePath, store);
      const r = run();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(servers()?.clawbox, `store ${JSON.stringify(store)}`).toBeTruthy();
    }
  });

  it("leaves the registration exactly as it is when the store exists and cannot be read", () => {
    for (const torn of ["{\"clawbox_mcp_enabled\": fal", "[false]"]) {
      // Unregistered stays unregistered: a corrupt store cannot undo an owner's off...
      fs.writeFileSync(configPath, "model:\n  default: deepseek-v4-pro\n");
      fs.writeFileSync(storePath, torn);
      let r = run();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(servers()?.clawbox, `torn ${torn}`).toBeFalsy();
      expect(r.stdout).toMatch(/left exactly as it is/);

      // ...and registered stays registered: nor can it strip a working box.
      fs.rmSync(storePath, { force: true });
      r = run();
      expect(servers()?.clawbox).toBeTruthy();
      fs.writeFileSync(storePath, torn);
      r = run();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(servers()?.clawbox, `torn ${torn}`).toBeTruthy();
    }
  });

  it("puts the entry back on the boot after the switch goes on again", () => {
    // The round trip the route relies on: OFF removes, ON re-registers.
    fs.writeFileSync(configPath, REGISTERED_YAML);
    fs.writeFileSync(storePath, JSON.stringify({ clawbox_mcp_enabled: false }));
    expect(run().status).toBe(0);
    expect(servers()?.clawbox).toBeUndefined();
    fs.writeFileSync(storePath, JSON.stringify({ clawbox_mcp_enabled: true }));
    expect(run().status).toBe(0);
    expect((servers()?.clawbox as Record<string, unknown>).command).toBe(path.join(home, "fake-bun"));
    expect(servers()?.other).toEqual({ url: "http://example.invalid" });
  });
});
