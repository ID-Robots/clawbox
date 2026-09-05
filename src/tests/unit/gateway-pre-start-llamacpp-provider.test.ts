import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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
  models?: Array<{ id?: string; name?: string; baseUrl?: string; contextWindow?: number; maxTokens?: number }>;
};

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** Tuning the block reads from the environment; never inherited (see migrate). */
const AMBIENT_KEYS = [
  "LLAMACPP_CONTEXT_WINDOW",
  "LLAMACPP_MAX_TOKENS",
  "CLAWBOX_LOCAL_AI_PROXY_BASE_URL",
  "CLAWBOX_PORT",
  "PORT",
] as const;

function writeToken(value: string | null): void {
  if (value === null) return;
  writeFileSync(path.join(root, "data", ".local-ai-token"), value);
}

/** The shipped `$CLAWBOX_ROOT/.env` that install.sh's ensure_env_setting writes. */
function writeEnvFile(body: string): void {
  writeFileSync(path.join(root, ".env"), body);
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
  // The block reads its tuning from the environment, so a developer or CI job
  // that happens to export LLAMACPP_CONTEXT_WINDOW would fail every
  // default-asserting case here while the script is perfectly correct. Drop
  // the ambient values and let each case state its own — the same reason
  // gateway-pre-start-clawai-images.test.ts clears its override.
  const inherited = { ...process.env };
  for (const key of AMBIENT_KEYS) delete inherited[key];
  const lines = execFileSync("python3", ["-c", program, file], {
    encoding: "utf-8",
    env: { ...inherited, CLAWBOX_ROOT: root, ...env },
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

  it("uses the configured x64 UI port for the local proxy", () => {
    writeToken(TOKEN);
    const { cfg } = migrate(
      {
        models: { providers: {} },
        agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
      },
      { CLAWBOX_PORT: "3005" },
    );

    expect(llamacppProvider(cfg).baseUrl)
      .toBe("http://127.0.0.1:3005/setup-api/local-ai/llamacpp/v1");
  });

  it("preserves the explicit local-AI proxy authority on x64", () => {
    writeToken(TOKEN);
    const { cfg } = migrate(
      {
        models: { providers: {} },
        agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
      },
      {
        CLAWBOX_PORT: "3005",
        CLAWBOX_LOCAL_AI_PROXY_BASE_URL: "http://10.42.0.1:8080/",
      },
    );

    expect(llamacppProvider(cfg).baseUrl)
      .toBe("http://10.42.0.1:8080/setup-api/local-ai/llamacpp/v1");
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
    expect(log).toContain("is missing or too short");
    // ...and the journal says what the skip costs: the entry is left with no
    // provider baseUrl, which OpenClaw's schema requires for llamacpp, so
    // ExecStart refuses the whole config rather than merely losing a model.
    expect(log).toContain("gateway will refuse this config");
  });

  it("completes the entry when a row names THIS box rather than another host", () => {
    // Loopback and our own proxy are where the bearer already goes. Refusing
    // there buys no security and costs a gateway: the entry is left with no
    // provider baseUrl, which OpenClaw's schema requires for llamacpp, so
    // ExecStart refuses the config outright.
    writeToken(TOKEN);
    const { cfg, changed, log } = migrate({
      models: {
        providers: {
          llamacpp: {
            api: "openai-completions",
            models: [
              { id: "own-server", name: "own-server", baseUrl: "http://127.0.0.1:8080/v1" },
              {
                id: "gemma4-e2b-it-q4_0",
                name: "gemma4-e2b-it-q4_0",
                baseUrl: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
              },
            ],
          },
        },
      },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(changed).toBe(true);
    expect(llamacppProvider(cfg).baseUrl).toBe("http://127.0.0.1/setup-api/local-ai/llamacpp/v1");
    expect(llamacppProvider(cfg).apiKey).toBe(TOKEN);
    expect(log).not.toContain("another host");
  });

  it("ignores a row OpenClaw's own schema rejects when deciding that", () => {
    // A row with no id is dropped by this very repair and rejected by
    // `ModelDefinitionSchema`, so it can never route a turn — letting it veto
    // the repair would be the same false failure one shape over.
    writeToken(TOKEN);
    const { cfg, changed } = migrate({
      models: {
        providers: {
          llamacpp: {
            api: "openai-completions",
            models: [{ name: "no id here", baseUrl: "https://models.example.net/v1" }],
          },
        },
      },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(changed).toBe(true);
    expect(llamacppProvider(cfg).baseUrl).toBe("http://127.0.0.1/setup-api/local-ai/llamacpp/v1");
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

  it("does not write this box's local-AI token beside a model row that routes itself", () => {
    // The bearer is PROVIDER-WIDE: OpenClaw resolves a row's endpoint as
    // `model.baseUrl ?? provider.baseUrl` and has no per-model credential slot,
    // so pointing the entry at our proxy and writing our token beside a row
    // that keeps its own baseUrl mails that token to that host on every turn of
    // the row. ClawBox writes the endpoint on the PROVIDER and never on a row,
    // so a row that names one is per-row routing we did not build — leave the
    // entry alone and say why. The same rule the TypeScript half of this repair
    // applies in `ensureLocalAiProxyUrls`.
    writeToken(TOKEN);
    const existing = {
      api: "openai-completions",
      models: [{
        id: "gemma4-e2b-it-q4_0",
        name: "gemma4-e2b-it-q4_0",
        baseUrl: "https://models.example.net/v1",
      }],
    };

    const { cfg, changed, log } = migrate({
      models: { providers: { llamacpp: existing } },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(llamacppProvider(cfg)).toEqual(existing);
    expect(changed).toBe(false);
    // Named by its own sentence, not by the shared prefix: the empty-id skip
    // and the missing-token skip open with the same words, so a prefix match
    // would pass if a regression fired the wrong branch.
    expect(log).toContain("names its own baseUrl on another host");
    // ...and the journal says what the skip costs, because the entry it
    // declines to complete has no provider baseUrl and OpenClaw's schema
    // requires one for llamacpp — the gateway refuses the whole config.
    expect(log).toContain("gateway will refuse this config");
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

  it("does not touch a malformed models value when llama.cpp is unused", () => {
    writeToken(TOKEN);
    const { cfg, changed } = migrate({
      models: "operator-owned-scalar",
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    });

    expect(changed).toBe(false);
    expect(cfg.models).toBe("operator-owned-scalar");
  });

  it("repairs malformed models and providers containers only when needed", () => {
    writeToken(TOKEN);
    const scalarModels = migrate({
      models: "broken",
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });
    const scalarProviders = migrate({
      models: { providers: "broken" },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(llamacppProvider(scalarModels.cfg).models?.[0]?.id)
      .toBe("gemma4-e2b-it-q4_0");
    expect(llamacppProvider(scalarProviders.cfg).models?.[0]?.id)
      .toBe("gemma4-e2b-it-q4_0");
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

  it("completes an existing but EMPTY llamacpp entry instead of leaving a config the gateway rejects", () => {
    // Key presence alone treated `{}` as a deliberate operator choice, but
    // OpenClaw's ModelDefinitionSchema requires a baseUrl and at least one
    // model on a custom provider: an empty entry fails validation outright, so
    // preserving it leaves a box whose gateway cannot load its config at all —
    // strictly worse than the "Unknown model" this migration exists to fix.
    writeToken(TOKEN);
    const { cfg, changed } = migrate({
      models: { providers: { llamacpp: {} } },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(changed).toBe(true);
    const p = llamacppProvider(cfg);
    expect(p.baseUrl).toBe("http://127.0.0.1/setup-api/local-ai/llamacpp/v1");
    expect(p.apiKey).toBe(TOKEN);
    expect(p.models?.[0]?.id).toBe("gemma4-e2b-it-q4_0");
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

  // --- TASK-643: the review findings on #562 -----------------------------

  it("refuses a bare `llamacpp/` ref rather than writing a model row with an empty id", () => {
    // ModelDefinitionSchema requires id.min(1). Writing {id:"",name:""} makes
    // the WHOLE openclaw.json fail validation, so a box that merely could not
    // answer ends up with a gateway that cannot load at all.
    writeToken(TOKEN);
    const { cfg, changed, log } = migrate({
      models: { providers: {} },
      agents: { defaults: { model: { primary: "llamacpp/" } } },
    });

    expect(changed).toBe(false);
    expect(llamacppProvider(cfg)).toEqual({});
    expect(log).toContain("Skipped llamacpp provider repair");
  });

  it("skips an empty id but still repairs a usable one beside it", () => {
    writeToken(TOKEN);
    const { cfg, changed } = migrate({
      models: { providers: {} },
      agents: { defaults: { model: { primary: "llamacpp/", fallbacks: ["llamacpp/gemma4-e2b-it-q4_0"] } } },
    });

    expect(changed).toBe(true);
    expect(llamacppProvider(cfg).models?.map((m) => m.id)).toEqual(["gemma4-e2b-it-q4_0"]);
  });

  it("registers a row for every distinct llamacpp id, not only the first", () => {
    // A second llamacpp id in the fallbacks stays "Unknown model" — the exact
    // failure this migration exists to remove.
    writeToken(TOKEN);
    const { cfg } = migrate({
      models: { providers: {} },
      agents: {
        defaults: {
          model: {
            primary: "llamacpp/gemma4-e2b-it-q4_0",
            fallbacks: ["llamacpp/qwen3-1.7b-q4", "clawai/x", " llamacpp/gemma4-e2b-it-q4_0 "],
          },
        },
      },
    });

    expect(llamacppProvider(cfg).models?.map((m) => m.id))
      .toEqual(["gemma4-e2b-it-q4_0", "qwen3-1.7b-q4"]);
  });

  it("reads the tuning from the shipped .env, which the gateway unit does not load", () => {
    // clawbox-gateway.service loads network.env and discord.env only, while
    // install.sh's ensure_env_setting writes LLAMACPP_* into
    // $CLAWBOX_ROOT/.env. Read from os.environ alone, the repair ALWAYS wrote
    // 131072 while llama-server (started under clawbox-setup, which does load
    // .env) ran at the configured size: compaction never fires and long
    // sessions die with context-exceeded.
    writeToken(TOKEN);
    writeEnvFile("LLAMACPP_CONTEXT_WINDOW=32768\nLLAMACPP_MAX_TOKENS=4096\n");
    const { cfg } = migrate({
      models: { providers: {} },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(llamacppProvider(cfg).models?.[0]?.contextWindow).toBe(32768);
    expect(llamacppProvider(cfg).models?.[0]?.maxTokens).toBe(4096);
  });

  it("lets the process environment win over the .env file", () => {
    writeToken(TOKEN);
    writeEnvFile("LLAMACPP_CONTEXT_WINDOW=32768\n");
    const { cfg } = migrate(
      {
        models: { providers: {} },
        agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
      },
      { LLAMACPP_CONTEXT_WINDOW: "65536" },
    );

    expect(llamacppProvider(cfg).models?.[0]?.contextWindow).toBe(65536);
  });

  it("takes the local-AI proxy authority from the .env too", () => {
    writeToken(TOKEN);
    writeEnvFile('CLAWBOX_LOCAL_AI_PROXY_BASE_URL="http://10.42.0.1:8080/"\n');
    const { cfg } = migrate({
      models: { providers: {} },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(llamacppProvider(cfg).baseUrl)
      .toBe("http://10.42.0.1:8080/setup-api/local-ai/llamacpp/v1");
  });

  it("honours LLAMACPP_MAX_TOKENS the way src/lib/llamacpp.ts does", () => {
    writeToken(TOKEN);
    const explicit = migrate(
      { models: { providers: {} }, agents: { defaults: { model: { primary: "llamacpp/m" } } } },
      { LLAMACPP_CONTEXT_WINDOW: "32768", LLAMACPP_MAX_TOKENS: "2048" },
    );
    expect(llamacppProvider(explicit.cfg).models?.[0]?.maxTokens).toBe(2048);

    // Unusable value falls back to the context window, as getLlamaCppMaxTokens does.
    const junk = migrate(
      { models: { providers: {} }, agents: { defaults: { model: { primary: "llamacpp/m" } } } },
      { LLAMACPP_CONTEXT_WINDOW: "32768", LLAMACPP_MAX_TOKENS: "nope" },
    );
    expect(llamacppProvider(junk.cfg).models?.[0]?.maxTokens).toBe(32768);
  });

  it("accepts the numeric spellings the TypeScript side accepts", () => {
    // Number("32768.0") and Number("1e5") both start llama-server at that size
    // on the TS path; python int() raises on both, the except swallowed it and
    // the provider silently got 131072 instead.
    writeToken(TOKEN);
    const dotted = migrate(
      { models: { providers: {} }, agents: { defaults: { model: { primary: "llamacpp/m" } } } },
      { LLAMACPP_CONTEXT_WINDOW: "32768.0" },
    );
    expect(llamacppProvider(dotted.cfg).models?.[0]?.contextWindow).toBe(32768);

    const exponent = migrate(
      { models: { providers: {} }, agents: { defaults: { model: { primary: "llamacpp/m" } } } },
      { LLAMACPP_CONTEXT_WINDOW: "1e5" },
    );
    expect(llamacppProvider(exponent.cfg).models?.[0]?.contextWindow).toBe(100000);
  });

  it("survives models.providers = null instead of aborting ExecStartPre", () => {
    // set -euo pipefail: a TypeError here means the gateway never reaches
    // ExecStart at all.
    writeToken(TOKEN);
    const { cfg, changed } = migrate({
      models: { providers: null },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(changed).toBe(true);
    expect(llamacppProvider(cfg).models?.[0]?.id).toBe("gemma4-e2b-it-q4_0");
  });

  it("leaves a usable operator entry alone but completes a half-written one", () => {
    writeToken(TOKEN);
    const partial = migrate({
      models: { providers: { llamacpp: { baseUrl: "http://127.0.0.1:8080/v1", apiKey: "operators-own" } } },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    // The operator's own baseUrl and key survive; only the schema-required
    // models list is filled in, so the config validates.
    expect(partial.changed).toBe(true);
    expect(llamacppProvider(partial.cfg).baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(llamacppProvider(partial.cfg).apiKey).toBe("operators-own");
    expect(llamacppProvider(partial.cfg).models?.[0]?.id).toBe("gemma4-e2b-it-q4_0");
  });

  // --- TASK-643 review round -------------------------------------------

  it("survives a .env byte that is not UTF-8 instead of killing the gateway", () => {
    // .env is clawbox-writable and one latin-1 byte in an operator's value
    // raised UnicodeDecodeError out of the heredoc — which under
    // `set -euo pipefail` fails ExecStartPre, and Restart=always then spends
    // StartLimitBurst. No gateway, no chat, over one byte.
    writeToken(TOKEN);
    writeFileSync(
      path.join(root, ".env"),
      Buffer.concat([
        Buffer.from("LLAMACPP_CONTEXT_WINDOW=32768\nSOME_VALUE="),
        Buffer.from([0xe9]),
        Buffer.from("\n"),
      ]),
    );

    const { cfg, changed } = migrate({
      models: { providers: {} },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(changed).toBe(true);
    expect(llamacppProvider(cfg).models?.[0]?.contextWindow).toBe(32768);
  });

  it("fills a model row's missing name, which the schema requires as much as the id", () => {
    // ModelDefinitionSchema is id.min(1) AND name.min(1). A row with an id and
    // no name looked usable, was left alone, and the whole config still failed
    // validation — the outcome this migration exists to prevent.
    writeToken(TOKEN);
    const { cfg, changed } = migrate({
      models: {
        providers: {
          llamacpp: {
            baseUrl: "http://127.0.0.1:8080/v1",
            models: [{ id: "gemma4-e2b-it-q4_0" }],
          },
        },
      },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(changed).toBe(true);
    expect(llamacppProvider(cfg).models?.[0]?.name).toBe("gemma4-e2b-it-q4_0");
  });

  it("registers a referenced id the existing entry does not list, keeping the rows it has", () => {
    // The entry looked complete, so nothing ran and nothing was said, while the
    // box answered every turn with "Unknown model".
    writeToken(TOKEN);
    const { cfg, changed } = migrate({
      models: {
        providers: {
          llamacpp: {
            baseUrl: "http://127.0.0.1:8080/v1",
            models: [{ id: "qwen3-1.7b-q4", name: "qwen3-1.7b-q4" }],
          },
        },
      },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(changed).toBe(true);
    expect(llamacppProvider(cfg).models?.map((m) => m.id))
      .toEqual(["qwen3-1.7b-q4", "gemma4-e2b-it-q4_0"]);
  });

  it("leaves an entry OpenClaw already accepts alone, api or no api", () => {
    // `api` and `apiKey` are .optional() in ModelProviderSchema. Treating them
    // as required rewrote configs that were already valid — and injecting `api`
    // into one an operator left api-less changes how it routes.
    writeToken(TOKEN);
    const existing = {
      baseUrl: "http://127.0.0.1:8080/v1",
      models: [{ id: "gemma4-e2b-it-q4_0", name: "gemma4-e2b-it-q4_0" }],
    };
    const { cfg, changed } = migrate({
      models: { providers: { llamacpp: existing } },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(changed).toBe(false);
    expect(llamacppProvider(cfg)).toEqual(existing);
  });

  it("does not demand the proxy bearer for an entry that names its own server", () => {
    // The refusal spoke about a baseUrl that is not the proxy, and left the
    // config invalid over a credential the entry never wanted.
    writeToken(null);
    const { cfg, changed } = migrate({
      models: {
        providers: { llamacpp: { baseUrl: "http://127.0.0.1:8080/v1", models: "broken" } },
      },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(changed).toBe(true);
    expect(llamacppProvider(cfg).baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(llamacppProvider(cfg).models?.[0]?.id).toBe("gemma4-e2b-it-q4_0");
    // ...and no key of ours was put beside a server of theirs.
    expect(llamacppProvider(cfg)).not.toHaveProperty("apiKey");
  });

  it("never leaves a foreign key beside this box's own proxy", () => {
    // The proxy validates the bearer against data/.local-ai-token and answers
    // 401 to anything else: our baseUrl with somebody else's key is the
    // 401-per-turn the token guard exists to prevent.
    writeToken(TOKEN);
    const { cfg, log } = migrate({
      models: { providers: { llamacpp: { apiKey: "an-operators-own-key" } } },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(llamacppProvider(cfg).baseUrl)
      .toBe("http://127.0.0.1/setup-api/local-ai/llamacpp/v1");
    expect(llamacppProvider(cfg).apiKey).toBe(TOKEN);
    expect(log).toContain("Replaced models.providers.llamacpp.apiKey");
  });

  it("says so when it replaces a malformed models value", () => {
    writeToken(TOKEN);
    const { log } = migrate({
      models: "operator-owned-scalar",
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });

    expect(log).toContain("models was not an object");
  });

  it("survives agents.defaults.model = null instead of aborting ExecStartPre", () => {
    // `setdefault` returned the null and every `.get` on it raised
    // AttributeError, which under `set -euo pipefail` means the gateway never
    // reaches ExecStart. A null is an absence rather than a discarded value, so
    // it is repaired without a WARN — the point is only that the run survives.
    writeToken(TOKEN);
    const { cfg, changed } = migrate({
      models: { providers: {} },
      agents: { defaults: { model: null } },
    });

    expect(changed).toBe(false);
    expect(llamacppProvider(cfg)).toEqual({});
  });

  it("says so when it replaces a NON-null malformed model block", () => {
    writeToken(TOKEN);
    const { log } = migrate({
      models: { providers: {} },
      agents: { defaults: { model: "operator-owned-scalar" } },
    });

    expect(log).toContain("agents.defaults.model was not an object");
  });
});
