import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { LOCAL_TOOL_SEARCH_OFF } from "@/lib/local-tool-search";

// Starts a real process (python3): see test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The boot half of "Tool Search follows the primary" (src/lib/local-tool-search.ts):
// a box already on the on-device model when this shipped, or moved onto it by
// a migration earlier in the same pass, gets Tool Search off; a box back on a
// cloud primary gets OpenClaw's default back. Run out of the SHIPPED script.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

function region(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf("# Reconciliation: OpenClaw's Tool Search vs a primary on the on-device model.");
  const end = src.indexOf("\nif isinstance(ds_models, list):\n", start);
  if (start < 0 || end < 0) throw new Error("Tool Search reconciliation not found in gateway-pre-start.sh");
  return src.slice(start, end);
}

const REGION = hasPython3 ? region() : "";
let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "local-tool-search-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Config = Record<string, unknown>;

function reconcile(cfg: Config, core2026_10 = true): { cfg: Config; changed: boolean; log: string } {
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(cfg));
  const program = [
    "import json, sys",
    "cfg = json.load(open(sys.argv[1]))",
    `CLAWBOX_OPENCLAW_2026_10 = ${core2026_10 ? "True" : "False"}`,
    "changed = False",
    REGION,
    "print(json.dumps({'cfg': cfg, 'changed': changed}))",
  ].join("\n");
  const lines = execFileSync("python3", ["-c", program, file], { encoding: "utf-8" }).trim().split("\n");
  return { ...JSON.parse(lines[lines.length - 1]), log: lines.slice(0, -1).join("\n") };
}

const onPrimary = (primary: unknown, tools?: unknown): Config => ({
  agents: { defaults: { model: typeof primary === "string" ? { primary, fallbacks: [] } : primary } },
  ...(tools === undefined ? {} : { tools }),
});

describe.skipIf(!hasPython3)("gateway-pre-start.sh — Tool Search vs the on-device primary", () => {
  it("writes the same value the routes write", () => {
    expect(REGION).toContain('_LOCAL_TOOL_SEARCH_OFF = {"enabled": False}');
    expect(LOCAL_TOOL_SEARCH_OFF).toEqual({ enabled: false });
  });

  it("turns Tool Search off on a box whose primary is the on-device model", () => {
    const { cfg, changed, log } = reconcile(onPrimary("llamacpp/gemma4-e2b-it-q4_0", { profile: "full" }));
    expect(changed).toBe(true);
    expect((cfg.tools as Config).toolSearch).toEqual({ enabled: false });
    expect((cfg.tools as Config).profile).toBe("full");
    expect(log).toContain("Turned OpenClaw's Tool Search off");
  });

  it("creates the tools block when there is none, and reads a bare-string model", () => {
    const { cfg, changed } = reconcile(onPrimary("llamacpp/gemma4-e2b-it-q4_0"));
    expect(changed).toBe(true);
    expect(cfg.tools).toEqual({ toolSearch: { enabled: false } });
    expect(reconcile({ agents: { defaults: { model: "llamacpp/x" } } }).cfg.tools).toEqual({ toolSearch: { enabled: false } });
  });

  it("is idempotent", () => {
    const first = reconcile(onPrimary("llamacpp/gemma4-e2b-it-q4_0"));
    const second = reconcile(first.cfg);
    expect(second.changed).toBe(false);
    expect(second.cfg).toEqual(first.cfg);
  });

  it("gives a cloud primary OpenClaw's default back", () => {
    const { cfg, changed, log } = reconcile(onPrimary("deepseek/deepseek-v4-flash", { toolSearch: { enabled: false }, profile: "full" }));
    expect(changed).toBe(true);
    expect(cfg.tools).toEqual({ profile: "full" });
    expect(log).toContain("Restored OpenClaw's Tool Search default");
  });

  it("never touches an owner's own setting, on either side", () => {
    for (const toolSearch of [false, true, { enabled: false, mode: "tools" }, { mode: "directory" }]) {
      for (const primary of ["llamacpp/gemma4-e2b-it-q4_0", "deepseek/deepseek-v4-flash"]) {
        const saved = onPrimary(primary, { toolSearch });
        const { cfg, changed } = reconcile(saved);
        expect(changed, `${primary} ${JSON.stringify(toolSearch)}`).toBe(false);
        expect(cfg).toEqual(saved);
      }
    }
  });

  it("leaves a cloud box with no setting exactly as OpenClaw ships it", () => {
    const saved = onPrimary("deepseek/deepseek-v4-flash", { profile: "full" });
    expect(reconcile(saved)).toMatchObject({ cfg: saved, changed: false });
  });

  it("writes nothing an older core could refuse", () => {
    const saved = onPrimary("llamacpp/gemma4-e2b-it-q4_0");
    expect(reconcile(saved, false)).toMatchObject({ cfg: saved, changed: false });
  });

  it("survives malformed agents and tools blocks without aborting pre-start", () => {
    expect(reconcile({ agents: null, tools: "x" }).changed).toBe(false);
    expect(reconcile({ agents: { defaults: { model: null } } }).changed).toBe(false);
    expect(reconcile(onPrimary("llamacpp/x", ["not", "an", "object"])).changed).toBe(false);
  });
});
