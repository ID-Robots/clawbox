import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sliceScript } from "../helpers/gateway-pre-start";

// Starts a real python3: the 5 s default is not enough on a loaded runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * The gateway pre-start pass and the external AI engine (TASK-2376), run
 * VERBATIM: the whole local-AI region of the boot script — the llamacpp
 * migrations and repairs, the window resize, the bearer reconciliation, and
 * the external-engine block that ends it — over an openclaw.json whose primary
 * is the engine. A start must keep the `clawext` provider and the primary
 * exactly as saved, never put llama.cpp back into the chat, and put the
 * provider back from the device store when it is gone.
 */
const REGION = hasPython3
  ? sliceScript(
      "# Model migration: some early ClawBox images/configs",
      "# Model migration: legacy ChatGPT-subscription devices",
    )
  : "";

const KEY = "sk-test-external-engine-placeholder-0123456789";
const BASE = "http://192.0.2.10:8000/v1";
const MODEL = "Qwen/Qwen3-32B";
const LOCAL_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const AMBIENT_KEYS = [
  "CLAWBOX_OPENCLAW_2026_10",
  "LLAMACPP_CONTEXT_WINDOW",
  "LLAMACPP_MAX_TOKENS",
  "CLAWBOX_LOCAL_AI_PROXY_BASE_URL",
  "CLAWBOX_DEVICE_STORE",
  "CLAWBOX_PORT",
  "PORT",
] as const;

let dir: string;
let root: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pre-start-external-"));
  root = path.join(dir, "clawbox");
  mkdirSync(path.join(root, "data"), { recursive: true });
  writeFileSync(path.join(root, "data", ".local-ai-token"), LOCAL_TOKEN);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Config = Record<string, unknown>;

const record = (extra: Record<string, unknown> = {}) => ({
  baseUrl: BASE,
  modelId: MODEL,
  contextWindow: 131072,
  maxTokens: 8192,
  imageInput: false,
  providerId: "clawext",
  harness: "openclaw",
  savedAt: "2026-11-09T00:00:00.000Z",
  previous: { store: {} },
  ...extra,
});

function writeStore(value: Record<string, unknown> | null): void {
  if (value === null) return;
  writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(value));
}

function writeKey(value: string | null): void {
  if (value === null) return;
  writeFileSync(path.join(root, "data", ".external-engine-key"), value, { mode: 0o600 });
}

/** The provider block the Settings save writes (openclawExternalProviderDefinition). */
const savedEntry = () => ({
  baseUrl: BASE,
  api: "openai-completions",
  apiKey: KEY,
  models: [{
    id: MODEL,
    name: "Qwen3-32B",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
  }],
});

/** A box whose Local AI was Gemma and is now the external engine. */
const selectedConfig = (providers: Record<string, unknown> = { clawext: savedEntry() }): Config => ({
  agents: { defaults: { model: { primary: `clawext/${MODEL}`, fallbacks: ["deepseek/deepseek-v4-flash"] } } },
  models: {
    providers: {
      llamacpp: {
        baseUrl: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
        api: "openai-completions",
        apiKey: LOCAL_TOKEN,
        models: [{ id: "gemma4-e2b-it-q4_0", name: "gemma4-e2b-it-q4_0", contextWindow: 32768, maxTokens: 8192 }],
      },
      ...providers,
    },
  },
});

function run(cfg: Config): { cfg: Config; changed: boolean; log: string } {
  const file = path.join(dir, "openclaw.json");
  writeFileSync(file, JSON.stringify(cfg));
  const program = [
    "import json, os, re, sys",
    "cfg = json.load(open(sys.argv[1]))",
    'agents_defaults = cfg.setdefault("agents", {}).setdefault("defaults", {})',
    "changed = False",
    'CLAWBOX_OPENCLAW_2026_10 = os.environ.get("CLAWBOX_OPENCLAW_2026_10") == "1"',
    REGION,
    "print(json.dumps({'cfg': cfg, 'changed': changed}))",
  ].join("\n");
  const inherited = { ...process.env };
  for (const key of AMBIENT_KEYS) delete inherited[key];
  const lines = execFileSync("python3", ["-c", program, file], {
    encoding: "utf-8",
    env: { ...inherited, CLAWBOX_ROOT: root },
  }).trim().split("\n");
  return { ...JSON.parse(lines[lines.length - 1]), log: lines.slice(0, -1).join("\n") };
}

const providersOf = (cfg: Config) => (cfg.models as { providers: Record<string, Record<string, unknown>> }).providers;
const modelOf = (cfg: Config) => (cfg.agents as { defaults: { model: { primary: string; fallbacks: string[] } } }).defaults.model;

describe.skipIf(!hasPython3)("gateway-pre-start: the external AI engine (TASK-2376)", () => {
  it("keeps the saved provider, the primary and the fallbacks exactly as they are", () => {
    writeStore({ local_ai_provider: "clawext", local_ai_model: `clawext/${MODEL}`, external_engine: record() });
    writeKey(KEY);
    const out = run(selectedConfig());
    expect(providersOf(out.cfg).clawext).toEqual(savedEntry());
    expect(modelOf(out.cfg)).toEqual({ primary: `clawext/${MODEL}`, fallbacks: ["deepseek/deepseek-v4-flash"] });
    expect(out.log).not.toContain("clawext");
  });

  it("never puts llama.cpp back into the chat, whatever the llamacpp repairs do", () => {
    writeStore({ external_engine: record() });
    writeKey(KEY);
    const out = run(selectedConfig());
    const model = modelOf(out.cfg);
    expect(model.primary.startsWith("llamacpp/")).toBe(false);
    expect(model.fallbacks.some((f) => f.startsWith("llamacpp/") || f.startsWith("ollama/"))).toBe(false);
  });

  it("puts the provider back from the device store when it is gone, key from its own file", () => {
    writeStore({ external_engine: record({ imageInput: true }) });
    writeKey(KEY);
    const out = run(selectedConfig({}));
    expect(out.changed).toBe(true);
    expect(providersOf(out.cfg).clawext).toEqual({
      ...savedEntry(),
      models: [{ ...savedEntry().models[0], input: ["text", "image"] }],
    });
    expect(modelOf(out.cfg).primary).toBe(`clawext/${MODEL}`);
    expect(out.log).toContain("Restored models.providers.clawext");
    // The log names the model and the endpoint, never the key.
    expect(out.log).not.toContain(KEY);
  });

  it("corrects ClawBox's own fields and keeps a field the owner added", () => {
    writeStore({ external_engine: record() });
    writeKey(KEY);
    const stale = { ...savedEntry(), baseUrl: "http://198.51.100.7:8000/v1", headers: { "X-Team": "lab" } };
    const out = run(selectedConfig({ clawext: stale }));
    expect(providersOf(out.cfg).clawext).toEqual({ ...savedEntry(), headers: { "X-Team": "lab" } });
  });

  it("keeps the entry's key when the key file is missing", () => {
    writeStore({ external_engine: record() });
    const out = run(selectedConfig({ clawext: { ...savedEntry(), apiKey: "kept-key-value" } }));
    expect(providersOf(out.cfg).clawext.apiKey).toBe("kept-key-value");
  });

  it("leaves everything alone for a malformed record", () => {
    writeStore({ external_engine: record({ baseUrl: "http://192.0.2.10/setup-api/local-ai/llamacpp/v1" }) });
    writeKey(KEY);
    const out = run(selectedConfig({}));
    expect(providersOf(out.cfg).clawext).toBeUndefined();
    expect(out.log).toContain("External engine record in the device store is malformed");
  });

  it("never writes a link-local, metadata or unspecified target, whatever the store says", () => {
    for (const baseUrl of ["http://169.254.169.254/v1", "http://[fe80::1]:8000/v1", "http://[::ffff:169.254.169.254]/v1", "http://0.0.0.0:8000/v1", "http://metadata.google.internal/v1"]) {
      writeStore({ external_engine: record({ baseUrl }) });
      writeKey(KEY);
      const out = run(selectedConfig({}));
      expect(providersOf(out.cfg).clawext, baseUrl).toBeUndefined();
      expect(out.log, baseUrl).toContain("External engine record in the device store is malformed");
    }
    // The LAN, loopback and private hosts the feature is for are written.
    for (const baseUrl of ["http://192.168.1.20:8000/v1", "http://127.0.0.1:8000/v1", "http://[fd00::5]:8000/v1"]) {
      writeStore({ external_engine: record({ baseUrl }) });
      writeKey(KEY);
      expect(providersOf(run(selectedConfig({})).cfg).clawext?.baseUrl, baseUrl).toBe(baseUrl);
    }
  });

  it("does nothing on a box with no engine selected (the appliance default)", () => {
    writeStore({ local_ai_configured: true, local_ai_provider: "llamacpp" });
    const plain: Config = {
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash", fallbacks: [] } } },
      models: { providers: {} },
    };
    const out = run(plain);
    expect(providersOf(out.cfg).clawext).toBeUndefined();
    expect(out.changed).toBe(false);
    expect(out.log).not.toContain("external");
    // A leftover entry with no record is not ours to delete or rewrite.
    const leftover = run({ ...plain, models: { providers: { clawext: { baseUrl: "http://192.0.2.99/v1" } } } });
    expect(providersOf(leftover.cfg).clawext).toEqual({ baseUrl: "http://192.0.2.99/v1" });
  });
});
