import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { LEAN_TOOLS } from "../../../scripts/openclaw-plugins/clawbox-local-lean/local-lean.mjs";

// Starts a real process (python3): see test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// OpenClaw 2026.11.5 keeps every tool of the agent's catalog active when the
// lean hook narrows a turn with `toolsAllow`, and sizes the turn from that
// whole catalog: every turn on the on-device model ended "Context overflow"
// before the model was asked. The boot pass narrows the llamacpp provider's
// tools by the core's own config instead (`tools.byProvider.llamacpp.allow`).
// Run out of the SHIPPED script.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

function region(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf("# The on-device model's six tools, by config (OpenClaw 2026.11.5+).");
  const end = src.indexOf("# Reconciliation: OpenClaw's Tool Search vs a primary on the on-device model.", start);
  if (start < 0 || end < 0) throw new Error("the on-device tool list block was not found in gateway-pre-start.sh");
  return src.slice(start, end);
}

const REGION = hasPython3 ? region() : "";
let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "local-lean-tools-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Config = Record<string, unknown>;

function run(cfg: unknown, core2026_11_5 = true): { cfg: Config; changed: boolean; log: string } {
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(cfg));
  const program = [
    "import json, sys",
    "cfg = json.load(open(sys.argv[1]))",
    `CLAWBOX_OPENCLAW_2026_11_5 = ${core2026_11_5 ? "True" : "False"}`,
    "changed = False",
    REGION,
    "print(json.dumps({'cfg': cfg, 'changed': changed}))",
  ].join("\n");
  const lines = execFileSync("python3", ["-c", program, file], { encoding: "utf-8" }).trim().split("\n");
  return { ...JSON.parse(lines[lines.length - 1]), log: lines.slice(0, -1).join("\n") };
}

const SIX = { allow: [...LEAN_TOOLS] };
const primary = (model: string) => ({ agents: { defaults: { model: { primary: model, fallbacks: [] } } } });

describe.skipIf(!hasPython3)("gateway-pre-start.sh — the on-device model's tools by config", () => {
  it("writes the plugin's own six, in its order", () => {
    const { cfg } = run(primary("llamacpp/gemma4-e2b-it-q4_0"));
    expect((cfg.tools as Config).byProvider).toEqual({ llamacpp: SIX });
    expect(LEAN_TOOLS).toHaveLength(6);
  });

  it("narrows the llamacpp provider on a 2026.11.5 core, keeping the rest of the tools block", () => {
    const saved = { ...primary("llamacpp/gemma4-e2b-it-q4_0"), tools: { toolSearch: { enabled: false }, byProvider: { openai: { profile: "coding" } } } };
    const { cfg, changed, log } = run(saved);
    expect(changed).toBe(true);
    expect(cfg.tools).toEqual({ toolSearch: { enabled: false }, byProvider: { openai: { profile: "coding" }, llamacpp: SIX } });
    expect(log).toContain("tools.byProvider.llamacpp");
  });

  it("does not follow the primary: a cloud box gets it too, and it touches no cloud turn", () => {
    const { cfg, changed } = run(primary("deepseek/deepseek-v4-flash"));
    expect(changed).toBe(true);
    expect(cfg.tools).toEqual({ byProvider: { llamacpp: SIX } });
    expect(run({}).cfg).toEqual({ tools: { byProvider: { llamacpp: SIX } } });
  });

  it("is idempotent", () => {
    const first = run(primary("llamacpp/gemma4-e2b-it-q4_0"));
    const second = run(first.cfg);
    expect(second.changed).toBe(false);
    expect(second.cfg).toEqual(first.cfg);
  });

  it("never touches an owner's own entry for the provider, on either core", () => {
    const owners = [
      { allow: ["read"] },
      { allow: [...LEAN_TOOLS, "exec"] },
      { allow: [...LEAN_TOOLS], deny: ["write"] },
      { profile: "minimal" },
      { deny: ["exec"] },
      null,
    ];
    for (const llamacpp of owners) {
      for (const core of [true, false]) {
        const saved = { tools: { byProvider: { llamacpp } } };
        const { cfg, changed } = run(saved, core);
        expect(changed, `${JSON.stringify(llamacpp)} core2026_11_5=${core}`).toBe(false);
        expect(cfg).toEqual(saved);
      }
    }
  });

  it("writes nothing on an older core, which narrows through the hook alone", () => {
    const saved = { ...primary("llamacpp/gemma4-e2b-it-q4_0"), tools: { toolSearch: { enabled: false } } };
    expect(run(saved, false)).toMatchObject({ cfg: saved, changed: false });
  });

  it("takes exactly its own value back off an older core", () => {
    const alone = run({ tools: { profile: "full", byProvider: { llamacpp: SIX } } }, false);
    expect(alone.changed).toBe(true);
    expect(alone.cfg).toEqual({ tools: { profile: "full" } });
    expect(alone.log).toContain("Removed the on-device model's config tool list");
    const shared = run({ tools: { byProvider: { llamacpp: SIX, openai: { deny: ["exec"] } } } }, false);
    expect(shared.cfg).toEqual({ tools: { byProvider: { openai: { deny: ["exec"] } } } });
  });

  it("survives malformed tools blocks without aborting pre-start", () => {
    for (const tools of ["x", ["not", "an", "object"], { byProvider: "x" }, { byProvider: ["llamacpp"] }]) {
      const saved = { tools };
      expect(run(saved), JSON.stringify(tools)).toMatchObject({ cfg: saved, changed: false });
    }
    // A null block reads as no block, as the Tool Search rule reads it.
    expect(run({ tools: null }).cfg).toEqual({ tools: { byProvider: { llamacpp: SIX } } });
  });
});
