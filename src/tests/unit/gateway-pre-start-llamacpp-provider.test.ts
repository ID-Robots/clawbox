import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// A ClawBox whose `agents.defaults.model.primary` names `llamacpp/<model>` while
// `models.providers` has no `llamacpp` entry cannot answer at all. OpenClaw
// ships an `ollama` plugin but no llamacpp one, so `llamacpp/*` resolves ONLY
// through an explicit provider def, and without it every turn ends:
//
//   [model-fallback/decision] decision=candidate_failed
//       requested=llamacpp/gemma4-e2b-it-q4_0 reason=model_not_found next=none
//   Embedded agent failed before reply: Unknown model: llamacpp/gemma4-e2b-it-q4_0
//
// Observed on a freshly-provisioned Orin Nano (TASK-512): `models.providers` was
// `{}` from install onward, and the dead-Anthropic migration then moved
// `primary` onto the local model — swapping one unresolvable id for another.
// That pairing is why both blocks are extracted together below: the repair has
// to hold for the config the migration itself produces.
//
// These run the migration out of the shipped .sh, not a copy, so the test fails
// if the real script drifts. Same approach as
// gateway-pre-start-clawai-images.test.ts.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * Pull the dead-Anthropic model migration AND the llamacpp provider repair that
 * follows it out of the .sh verbatim, as one region.
 */
function extractPolicy(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf("# Model migration: some early ClawBox images/configs");
  const end = src.indexOf("# Model migration: legacy ChatGPT-subscription devices", start);
  if (start < 0 || end < 0) throw new Error("llamacpp provider migration block not found");
  return src.slice(start, end);
}

const POLICY = hasPython3 ? extractPolicy() : "";

let dir: string;
let root: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "llamacpp-provider-"));
  root = path.join(dir, "clawbox");
  mkdirSync(path.join(root, "data"), { recursive: true });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Config = Record<string, unknown>;
type ProviderDef = {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: Array<{ id?: string; name?: string; contextWindow?: number; maxTokens?: number }>;
};

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function writeToken(value: string | null): void {
  if (value === null) return;
  writeFileSync(path.join(root, "data", ".local-ai-token"), value);
}

/**
 * Run the extracted region over a whole openclaw.json.
 *
 * The preamble reproduces only the names the region reads from its surrounding
 * scope, exactly as the real script binds them upstream (`cfg`,
 * `agents_defaults`, `changed`) — mock at that boundary and nothing else, so
 * the logic under test is 100% the shipped bytes.
 */
function migrate(cfg: Config, env: Record<string, string> = {}): { cfg: Config; changed: boolean; log: string } {
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(cfg));
  const program = [
    "import json, os, sys",
    "cfg = json.load(open(sys.argv[1]))",
    'agents_defaults = cfg.setdefault("agents", {}).setdefault("defaults", {})',
    "changed = False",
    POLICY,
    "print(json.dumps({'cfg': cfg, 'changed': changed}))",
  ].join("\n");
  const lines = execFileSync("python3", ["-c", program, file], {
    encoding: "utf-8",
    env: { ...process.env, CLAWBOX_ROOT: root, ...env },
  }).trim().split("\n");
  return { ...JSON.parse(lines[lines.length - 1]), log: lines.slice(0, -1).join("\n") };
}

function llamacppProvider(cfg: Config): ProviderDef {
  const models = (cfg.models ?? {}) as { providers?: Record<string, ProviderDef> };
  return models.providers?.llamacpp ?? {};
}

function primaryOf(cfg: Config): unknown {
  const agents = (cfg.agents ?? {}) as { defaults?: { model?: { primary?: unknown } } };
  return agents.defaults?.model?.primary;
}

describe.skipIf(!hasPython3)("gateway-pre-start.sh — llamacpp primary without a provider def", () => {
  it("registers the provider when the primary names llamacpp and none exists", () => {
    writeToken(TOKEN);
    const { cfg, changed } = migrate({
      models: { providers: {} },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(changed).toBe(true);
    const p = llamacppProvider(cfg);
    expect(p.baseUrl).toBe("http://127.0.0.1/setup-api/local-ai/llamacpp/v1");
    expect(p.api).toBe("openai-completions");
    expect(p.apiKey).toBe(TOKEN);
    expect(p.models?.[0]?.id).toBe("gemma4-e2b-it-q4_0");
    expect(p.models?.[0]?.contextWindow).toBe(131072);
  });

  // The exact hardware sequence: a box on the retired Anthropic id with an empty
  // provider map. The migration moves it to llamacpp; the repair must make that
  // destination resolvable, or the box is mute either way.
  it("leaves the box answerable after the dead-Anthropic migration moves it to llamacpp", () => {
    writeToken(TOKEN);
    const { cfg, changed } = migrate({
      models: { providers: {} },
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-20250514" } } },
    });

    expect(changed).toBe(true);
    expect(primaryOf(cfg)).toBe("llamacpp/gemma4-e2b-it-q4_0");
    expect(llamacppProvider(cfg).models?.[0]?.id).toBe("gemma4-e2b-it-q4_0");
    expect(llamacppProvider(cfg).apiKey).toBe(TOKEN);
  });

  it("repairs from a fallback that names llamacpp, not only the primary", () => {
    writeToken(TOKEN);
    const { cfg } = migrate({
      models: { providers: {} },
      agents: {
        defaults: {
          model: { primary: "clawai/some-cloud-model", fallbacks: ["llamacpp/gemma4-e2b-it-q4_0"] },
        },
      },
    });

    expect(llamacppProvider(cfg).models?.[0]?.id).toBe("gemma4-e2b-it-q4_0");
  });

  it("uses the model id actually configured, not a hardcoded one", () => {
    writeToken(TOKEN);
    const { cfg } = migrate({
      models: { providers: {} },
      agents: { defaults: { model: { primary: "llamacpp/some-other-model-q8" } } },
    });

    expect(llamacppProvider(cfg).models?.[0]?.id).toBe("some-other-model-q8");
    expect(llamacppProvider(cfg).models?.[0]?.name).toBe("some-other-model-q8");
  });

  it("honours LLAMACPP_CONTEXT_WINDOW, and ignores a value below the floor", () => {
    writeToken(TOKEN);
    const big = migrate(
      { models: { providers: {} }, agents: { defaults: { model: { primary: "llamacpp/m" } } } },
      { LLAMACPP_CONTEXT_WINDOW: "32768" },
    );
    expect(llamacppProvider(big.cfg).models?.[0]?.contextWindow).toBe(32768);

    const tooSmall = migrate(
      { models: { providers: {} }, agents: { defaults: { model: { primary: "llamacpp/m" } } } },
      { LLAMACPP_CONTEXT_WINDOW: "128" },
    );
    expect(llamacppProvider(tooSmall.cfg).models?.[0]?.contextWindow).toBe(131072);
  });

  // Writing the entry without the bearer would trade "Unknown model" for a 401
  // on every turn. That is not an improvement, so it must refuse and say so.
  it("refuses to write a provider it cannot authenticate, and says why", () => {
    writeToken(null);
    const { cfg, changed, log } = migrate({
      models: { providers: {} },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(changed).toBe(false);
    expect(llamacppProvider(cfg)).toEqual({});
    expect(log).toContain("Skipped llamacpp provider repair");
    expect(log).toContain(".local-ai-token");
  });

  it("refuses on a truncated token rather than writing a key that cannot work", () => {
    writeToken("tooshort");
    const { changed, log } = migrate({
      models: { providers: {} },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(changed).toBe(false);
    expect(log).toContain("Skipped llamacpp provider repair");
  });

  it("leaves an existing llamacpp provider untouched", () => {
    writeToken(TOKEN);
    const existing = {
      baseUrl: "http://127.0.0.1:8080/v1",
      api: "openai-completions",
      apiKey: "an-operators-own-key",
      models: [{ id: "gemma4-e2b-it-q4_0", name: "gemma4-e2b-it-q4_0" }],
    };
    const { cfg, changed } = migrate({
      models: { providers: { llamacpp: existing } },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(changed).toBe(false);
    expect(llamacppProvider(cfg)).toEqual(existing);
  });

  it("does nothing on a box that does not use llamacpp at all", () => {
    writeToken(TOKEN);
    const { cfg, changed } = migrate({
      models: { providers: { openai: { baseUrl: "https://api.openai.com/v1" } } },
      agents: { defaults: { model: { primary: "openai/gpt-5.5", fallbacks: ["clawai/x"] } } },
    });

    expect(changed).toBe(false);
    expect(llamacppProvider(cfg)).toEqual({});
  });

  // --- CodeRabbit round on #562 ------------------------------------------

  it("repairs a primary carrying stray whitespace", () => {
    // The runtime trims before it checks the prefix, so "  llamacpp/x  " starts
    // the local runtime; without trimming here the repair is skipped and the box
    // stays mute for a reason nothing reports.
    writeToken(TOKEN);
    const { cfg, changed } = migrate({
      models: { providers: {} },
      agents: { defaults: { model: { primary: "  llamacpp/gemma4-e2b-it-q4_0  " } } },
    });

    expect(changed).toBe(true);
    expect(llamacppProvider(cfg).models?.[0]?.id).toBe("gemma4-e2b-it-q4_0");
  });

  it("preserves an existing but EMPTY llamacpp provider entry", () => {
    // {} is falsy, so a .get() check would silently overwrite an operator's
    // deliberate empty entry, contrary to the migration's preservation contract.
    writeToken(TOKEN);
    const { cfg, changed } = migrate({
      models: { providers: { llamacpp: {} } },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(changed).toBe(false);
    expect(llamacppProvider(cfg)).toEqual({});
  });

  it("survives a non-numeric LLAMACPP_CONTEXT_WINDOW instead of aborting pre-start", () => {
    // int("banana") raised ValueError and took gateway pre-start down with it,
    // turning a bad env var into a box that never starts at all.
    writeToken(TOKEN);
    const { cfg, changed } = migrate(
      {
        models: { providers: {} },
        agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
      },
      { LLAMACPP_CONTEXT_WINDOW: "banana" },
    );

    expect(changed).toBe(true);
    const ctx = llamacppProvider(cfg).models?.[0]?.contextWindow;
    expect(typeof ctx).toBe("number");
    expect(ctx).toBeGreaterThan(0);
  });
});
