import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// Starts a real process (bash / python3): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * The MCP registration block of scripts/gateway-pre-start.sh HONOURS the
 * owner's switch (Settings → Harness, 2026-09-15).
 *
 * `/setup-api/harness/mcp` removes `mcp.servers.clawbox` from openclaw.json
 * when the owner switches the assistant's device tools off — and this block
 * runs at EVERY gateway start and used to write the entry back
 * unconditionally, so the next reboot would have quietly undone the owner's
 * off. Pinned: with `clawbox_mcp_enabled: false` in data/config.json the block
 * removes an existing entry and writes none, keeps every other key, and says
 * so in one line; with the key absent, true, or the store unreadable it
 * registers exactly as it always did.
 */

const PRE_START = readFileSync(path.resolve(process.cwd(), "scripts/gateway-pre-start.sh"), "utf-8");

const canRun =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0
  && spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/** Slice a region of the shipped script by its first and last line. */
function block(fromLine: string, toLine: string): string {
  const start = PRE_START.indexOf(fromLine);
  if (start < 0) throw new Error(`slice start not found: ${fromLine}`);
  const end = PRE_START.indexOf(toLine, start);
  if (end < 0) throw new Error(`slice end not found: ${toLine}`);
  return PRE_START.slice(start, end + toLine.length);
}

let root: string;
let home: string;
let configPath: string;
let storePath: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "clawbox-mcp-switch-"));
  home = path.join(root, "home");
  mkdirSync(path.join(home, ".openclaw"), { recursive: true });
  mkdirSync(path.join(root, "clawbox", "data"), { recursive: true });
  configPath = path.join(home, ".openclaw", "openclaw.json");
  storePath = path.join(root, "clawbox", "data", "config.json");
});

afterEach(() => {
  try { chmodSync(storePath, 0o644); } catch { /* not every case writes one */ }
  rmSync(root, { recursive: true, force: true });
});

const TOKEN = "a".repeat(64);

function run(): { status: number | null; out: string } {
  const file = path.join(root, "block.sh");
  writeFileSync(file, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `CLAWBOX_ROOT=${JSON.stringify(path.join(root, "clawbox"))}`,
    `CLAWBOX_HOME_DIR=${JSON.stringify(home)}`,
    "CLAWBOX_PORT=80",
    `OPENCLAW_CONFIG=${JSON.stringify(configPath)}`,
    `export CLAWBOX_DEVICE_STORE=${JSON.stringify(storePath)}`,
    `export CLAWBOX_MCP_TOKEN_VAL=${JSON.stringify(TOKEN)}`,
    block('export CLAWBOX_BUN_BIN="${CLAWBOX_BUN_BIN:-', "unset CLAWBOX_MCP_TOKEN_VAL"),
    'echo "REACHED_END=1"',
  ].join("\n") + "\n");
  chmodSync(file, 0o755);
  const r = spawnSync("bash", [file], { encoding: "utf-8", timeout: 30_000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
}

function servers(): Record<string, unknown> | undefined {
  const mcp = readConfig().mcp as { servers?: Record<string, unknown> } | undefined;
  return mcp?.servers;
}

const REGISTERED = {
  gateway: { port: 18789 },
  mcp: { servers: { clawbox: { command: "/old/bun", args: ["run", "/old/entry.ts"] }, other: { url: "http://example.invalid" } } },
};

describe.skipIf(!canRun)("gateway-pre-start.sh — the MCP switch", () => {
  it("removes an existing registration when the switch is off, and keeps everything else", () => {
    writeFileSync(configPath, JSON.stringify(REGISTERED, null, 2));
    writeFileSync(storePath, JSON.stringify({ clawbox_mcp_enabled: false }));
    const r = run();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("REACHED_END=1");
    expect(servers()).toEqual({ other: { url: "http://example.invalid" } });
    expect(readConfig().gateway).toEqual({ port: 18789 });
    // One line, saying why, and no WARN: this is the owner's decision.
    expect(r.out).toMatch(/switched off in Settings; removed/);
    expect(r.out).not.toMatch(/WARN/);
  });

  it("writes nothing when the switch is off and there is nothing to remove", () => {
    const before = JSON.stringify({ gateway: { port: 18789 } }, null, 2);
    writeFileSync(configPath, before);
    writeFileSync(storePath, JSON.stringify({ clawbox_mcp_enabled: false }));
    const r = run();
    expect(r.status, r.out).toBe(0);
    // Byte for byte: no write at all, not a re-serialised no-op.
    expect(readFileSync(configPath, "utf-8")).toBe(before);
    expect(r.out).toMatch(/switched off in Settings; leaving it unregistered/);
  });

  it("registers as it always did when the store has no such key", () => {
    writeFileSync(configPath, JSON.stringify({ gateway: { port: 18789 } }));
    writeFileSync(storePath, JSON.stringify({ setup_complete: true }));
    const r = run();
    expect(r.status, r.out).toBe(0);
    const entry = servers()?.clawbox as { command: string; args: string[]; env: Record<string, string> };
    expect(entry.command).toBe(path.join(home, ".bun", "bin", "bun"));
    expect(entry.args).toEqual(["run", path.join(root, "clawbox", "mcp", "clawbox-mcp.ts")]);
    expect(entry.env.CLAWBOX_MCP_TOKEN).toBe(TOKEN);
    expect(r.out).toMatch(/Updated MCP server registration/);
  });

  it("registers when the switch is explicitly on", () => {
    writeFileSync(configPath, "{}");
    writeFileSync(storePath, JSON.stringify({ clawbox_mcp_enabled: true }));
    const r = run();
    expect(r.status, r.out).toBe(0);
    expect(servers()?.clawbox).toBeTruthy();
  });

  it("reads only the boolean false as off — a string, null or 0 still registers", () => {
    for (const value of ["false", null, 0]) {
      writeFileSync(configPath, "{}");
      writeFileSync(storePath, JSON.stringify({ clawbox_mcp_enabled: value }));
      const r = run();
      expect(r.status, r.out).toBe(0);
      expect(servers()?.clawbox, `value ${JSON.stringify(value)}`).toBeTruthy();
    }
  });

  it("registers when the store is missing or unreadable — a failed read never costs the box its tools", () => {
    writeFileSync(configPath, "{}");
    // No store at all.
    let r = run();
    expect(r.status, r.out).toBe(0);
    expect(servers()?.clawbox).toBeTruthy();
    // A torn store.
    writeFileSync(configPath, "{}");
    writeFileSync(storePath, "{\"clawbox_mcp_enabled\": fal");
    r = run();
    expect(r.status, r.out).toBe(0);
    expect(servers()?.clawbox).toBeTruthy();
    // A store that is not an object.
    writeFileSync(configPath, "{}");
    writeFileSync(storePath, "[false]");
    r = run();
    expect(r.status, r.out).toBe(0);
    expect(servers()?.clawbox).toBeTruthy();
  });

  it("honours the off switch even on a boot with no bearer", () => {
    // The token gate used to be the block's first exit; an owner's off must
    // hold whether or not this boot minted a token.
    writeFileSync(configPath, JSON.stringify(REGISTERED));
    writeFileSync(storePath, JSON.stringify({ clawbox_mcp_enabled: false }));
    const file = path.join(root, "block.sh");
    writeFileSync(file, [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `CLAWBOX_ROOT=${JSON.stringify(path.join(root, "clawbox"))}`,
      `CLAWBOX_HOME_DIR=${JSON.stringify(home)}`,
      "CLAWBOX_PORT=80",
      `OPENCLAW_CONFIG=${JSON.stringify(configPath)}`,
      `export CLAWBOX_DEVICE_STORE=${JSON.stringify(storePath)}`,
      "export CLAWBOX_MCP_TOKEN_VAL=''",
      block('export CLAWBOX_BUN_BIN="${CLAWBOX_BUN_BIN:-', "unset CLAWBOX_MCP_TOKEN_VAL"),
    ].join("\n") + "\n");
    chmodSync(file, 0o755);
    const r = spawnSync("bash", [file], { encoding: "utf-8", timeout: 30_000 });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(servers()).toEqual({ other: { url: "http://example.invalid" } });
  });
});
