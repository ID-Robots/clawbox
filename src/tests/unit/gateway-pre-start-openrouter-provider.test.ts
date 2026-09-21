import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// Starts a real process (python3): vitest's 5 s test and 10 s hook defaults are
// not enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The OpenRouter provider-def repair is the llamacpp repair's twin, and the
// TASK-643 review of #562 found the same two failures living on in it:
//
//  - `cfg.setdefault("models", {}).setdefault("providers", {})` raises
//    AttributeError when `models` is a scalar. It runs on EVERY config, not
//    only on OpenRouter boxes, and under `set -euo pipefail` an exception here
//    aborts ExecStartPre — the gateway never reaches ExecStart at all.
//  - a primary of exactly `openrouter/` yields an empty model id, and
//    ModelDefinitionSchema requires id.min(1), so the whole openclaw.json
//    fails validation.
//
// Runs the migration out of the shipped .sh, not a copy, so the test fails if
// the real script drifts.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

function extractPolicy(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf("# Migration: devices that configured OpenRouter before the provider-def");
  const end = src.indexOf('gateway = cfg.setdefault("gateway", {})', start);
  if (start < 0 || end < 0) throw new Error("openrouter provider migration block not found");
  return src.slice(start, end);
}

const POLICY = hasPython3 ? extractPolicy() : "";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "openrouter-provider-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Config = Record<string, unknown>;
type ProviderDef = { baseUrl?: string; models?: Array<{ id?: string; name?: string }> };

function migrate(cfg: Config): { cfg: Config; changed: boolean; log: string } {
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(cfg));
  const program = [
    "import json, os, sys",
    "cfg = json.load(open(sys.argv[1]))",
    "changed = False",
    POLICY,
    "print(json.dumps({'cfg': cfg, 'changed': changed}))",
  ].join("\n");
  const lines = execFileSync("python3", ["-c", program, file], { encoding: "utf-8" })
    .trim().split("\n");
  return { ...JSON.parse(lines[lines.length - 1]), log: lines.slice(0, -1).join("\n") };
}

function openrouterProvider(cfg: Config): ProviderDef {
  const models = (cfg.models ?? {}) as { providers?: Record<string, ProviderDef> };
  return models.providers?.openrouter ?? {};
}

const WITH_AUTH = { auth: { profiles: { "openrouter:default": { key: "sk-or-x" } } } };

describe.skipIf(!hasPython3)("gateway-pre-start.sh — OpenRouter provider def", () => {
  it("registers the provider for a legacy OpenRouter box", () => {
    const { cfg, changed } = migrate({
      ...WITH_AUTH,
      agents: { defaults: { model: { primary: "openrouter/moonshotai/kimi-k2-0905" } } },
    });

    expect(changed).toBe(true);
    expect(openrouterProvider(cfg).baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(openrouterProvider(cfg).models?.[0]?.id).toBe("moonshotai/kimi-k2-0905");
  });

  it("survives a scalar models value instead of aborting ExecStartPre", () => {
    // AttributeError on `"broken".setdefault` took the whole gateway down, and
    // this line runs on every config — an OpenRouter profile is not needed to
    // reach it.
    const { cfg, log } = migrate({ models: "operator-owned-scalar", agents: {} });

    expect(typeof (cfg.models as { providers?: unknown })?.providers).toBe("object");
    expect(log).toContain("models was not an object");
  });

  it("survives models.providers = null", () => {
    const { cfg } = migrate({
      ...WITH_AUTH,
      models: { providers: null },
      agents: { defaults: { model: { primary: "openrouter/moonshotai/kimi-k2-0905" } } },
    });

    expect(openrouterProvider(cfg).models?.[0]?.id).toBe("moonshotai/kimi-k2-0905");
  });

  it("never writes a model row with an empty id", () => {
    // `openrouter/` alone yields "" and ModelDefinitionSchema requires
    // id.min(1): the whole config then fails validation. OpenRouter routes any
    // slug through the same baseUrl and this list is UI-only, so the bundled
    // default is the right thing to fall back to.
    const { cfg } = migrate({
      ...WITH_AUTH,
      agents: { defaults: { model: { primary: "openrouter/" } } },
    });

    expect(openrouterProvider(cfg).models?.[0]?.id).toBe("moonshotai/kimi-k2-0905");
    expect(openrouterProvider(cfg).models?.[0]?.name).toBeTruthy();
  });

  it("trims a primary carrying stray whitespace, as the runtime does", () => {
    const { cfg } = migrate({
      ...WITH_AUTH,
      agents: { defaults: { model: { primary: "  openrouter/z-ai/glm-4.6  " } } },
    });

    expect(openrouterProvider(cfg).models?.[0]?.id).toBe("z-ai/glm-4.6");
  });

  it("leaves an existing OpenRouter provider entry alone", () => {
    const existing = { baseUrl: "https://openrouter.ai/api/v1", models: [{ id: "own/model" }] };
    const { cfg, changed } = migrate({
      ...WITH_AUTH,
      models: { providers: { openrouter: existing } },
      agents: { defaults: { model: { primary: "openrouter/own/model" } } },
    });

    expect(changed).toBe(false);
    expect(openrouterProvider(cfg)).toEqual(existing);
  });

  it("does nothing on a box with no OpenRouter auth profile", () => {
    const { cfg, changed } = migrate({
      agents: { defaults: { model: { primary: "anthropic/claude-opus-5" } } },
    });

    expect(changed).toBe(false);
    expect(openrouterProvider(cfg)).toEqual({});
  });
});
