import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
//
// It covers the tests and their hooks, not the `spawnSync` on the module line
// below: that one runs during COLLECTION, which neither ceiling governs.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

function cleanupBlock(): string {
  const source = readFileSync(SCRIPT, "utf8");
  const start = source.indexOf("# OpenClaw 2 moved/retired");
  const end = source.indexOf("# Model migration:", start);
  if (start < 0 || end < 0) throw new Error("OpenClaw 2 cleanup block not found");
  return source.slice(start, end);
}

const LEGACY_CONFIG = {
  meta: { lastTouchedAt: "2026-01-01T00:00:00Z" },
  commands: { ownerDisplay: "raw" },
  gateway: { tailscale: { resetOnExit: false } },
  agents: { defaults: { compaction: { reserveTokensFloor: 24000 } } },
};

function applyCleanup(v2: boolean): typeof LEGACY_CONFIG {
  const program = [
    "import json, sys",
    "cfg = json.loads(sys.argv[1])",
    `CLAWBOX_OPENCLAW_V2 = ${v2 ? "True" : "False"}`,
    "changed = False",
    cleanupBlock(),
    "print(json.dumps(cfg))",
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-c", program, JSON.stringify(LEGACY_CONFIG)], { encoding: "utf8" }));
}

describe.skipIf(!hasPython3)("gateway pre-start generation-specific cleanup", () => {
  it("gates legacy auth-profile doctor repair to OpenClaw 2", () => {
    const source = readFileSync(SCRIPT, "utf8");
    const start = source.indexOf("# OpenClaw 2 refuses to start while any legacy auth-profiles.json remains");
    const end = source.indexOf("# Patch the installed openclaw deepseek plugin JSON", start);
    const block = source.slice(start, end);
    expect(block).toContain('if [ "$CLAWBOX_OPENCLAW_V2" = "1" ]; then');
  });

  it("preserves settings that are valid on OpenClaw 1", () => {
    expect(applyCleanup(false)).toEqual(LEGACY_CONFIG);
  });

  it("removes retired settings on OpenClaw 2", () => {
    const cleaned = applyCleanup(true);
    expect(cleaned.meta).not.toHaveProperty("lastTouchedAt");
    expect(cleaned.commands).not.toHaveProperty("ownerDisplay");
    expect(cleaned.gateway.tailscale).not.toHaveProperty("resetOnExit");
    expect(cleaned.agents.defaults.compaction).not.toHaveProperty("reserveTokensFloor");
  });
});
