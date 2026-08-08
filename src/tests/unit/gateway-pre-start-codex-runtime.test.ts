import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// `agents.defaults.models["codex/*"].agentRuntime = {"id":"codex"}` is what
// routes a codex turn through the Codex app-server harness. WITHOUT it core
// uses its generic HTTP responses transport, which posts to
// https://chatgpt.com/backend-api/responses — a browser endpoint Cloudflare
// managed-challenges — and every turn fails with "the provider returned an HTML
// error page". Proven on a live box on 2026-07-28: with the key `CODEX OK`;
// remove it, restart, same box, HTML challenge.
//
// ClawBox used to delete this key unconditionally (it broke strict validation
// on an older pinned core). This exercises the real policy block out of the
// shipped script so that deletion can never come back for codex models.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/** Pull the agentRuntime policy block out of the .sh verbatim. */
function extractPolicy(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf("agents_models = agents_defaults.get(\"models\")");
  const end = src.indexOf("# Security migration:", start);
  if (start < 0 || end < 0) throw new Error("agentRuntime policy block not found");
  return src.slice(start, end);
}

const POLICY = hasPython3 ? extractPolicy() : "";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codex-runtime-policy-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the extracted policy against a config and return the resulting models map. */
function applyPolicy(config: Record<string, any>): Record<string, any> {
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(config));
  const program = [
    "import json, sys",
    "cfg = json.load(open(sys.argv[1]))",
    "changed = False",
    "agents_defaults = cfg.setdefault('agents', {}).setdefault('defaults', {})",
    "model_defaults = agents_defaults.setdefault('model', {})",
    POLICY,
    "print(json.dumps(agents_defaults.get('models') or {}))",
  ].join("\n");
  return JSON.parse(
    execFileSync("python3", ["-c", program, file], { encoding: "utf-8" }).trim(),
  );
}

describe.skipIf(!hasPython3)("gateway-pre-start.sh agentRuntime policy", () => {
  it("sets agentRuntime on the configured codex primary", () => {
    const models = applyPolicy({
      agents: { defaults: { model: { primary: "codex/gpt-5.5", fallbacks: [] } } },
    });
    expect(models["codex/gpt-5.5"].agentRuntime).toEqual({ id: "codex" });
  });

  it("sets agentRuntime on codex fallbacks too", () => {
    const models = applyPolicy({
      agents: {
        defaults: {
          model: { primary: "deepseek/deepseek-v4-flash", fallbacks: ["codex/gpt-5.5"] },
        },
      },
    });
    expect(models["codex/gpt-5.5"].agentRuntime).toEqual({ id: "codex" });
  });

  it("never strips agentRuntime from a codex model", () => {
    const models = applyPolicy({
      agents: {
        defaults: {
          model: { primary: "codex/gpt-5.5" },
          models: { "codex/gpt-5.5": { agentRuntime: { id: "codex" } } },
        },
      },
    });
    expect(models["codex/gpt-5.5"].agentRuntime).toEqual({ id: "codex" });
  });

  it("repairs a codex entry whose agentRuntime was removed", () => {
    const models = applyPolicy({
      agents: {
        defaults: {
          model: { primary: "codex/gpt-5.5" },
          models: { "codex/gpt-5.5": {} },
        },
      },
    });
    expect(models["codex/gpt-5.5"].agentRuntime).toEqual({ id: "codex" });
  });

  it("still strips an orphaned agentRuntime from a non-codex model", () => {
    // The original reason the strip existed: a newer-than-pinned plugin wrote
    // the key, a downgrade orphaned it, and strict validation bricked the page.
    const models = applyPolicy({
      agents: {
        defaults: {
          model: { primary: "deepseek/deepseek-v4-flash" },
          models: { "deepseek/deepseek-v4-flash": { agentRuntime: { id: "codex" } } },
        },
      },
    });
    expect(models["deepseek/deepseek-v4-flash"].agentRuntime).toBeUndefined();
  });

  it("preserves other per-model settings while adding agentRuntime", () => {
    const models = applyPolicy({
      agents: {
        defaults: {
          model: { primary: "codex/gpt-5.5" },
          models: { "codex/gpt-5.5": { params: { thinking: "high" } } },
        },
      },
    });
    expect(models["codex/gpt-5.5"].params).toEqual({ thinking: "high" });
    expect(models["codex/gpt-5.5"].agentRuntime).toEqual({ id: "codex" });
  });

  it("does nothing when no codex model is configured", () => {
    const models = applyPolicy({
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });
    expect(models).toEqual({});
  });
});
