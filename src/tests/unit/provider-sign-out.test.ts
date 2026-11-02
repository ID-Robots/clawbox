/**
 * Signing the box out of one AI provider (src/lib/provider-sign-out.ts and
 * its two harness halves), per provider and per edition:
 *
 *  - OpenClaw: the gateway's auth profiles through the core's own `models auth
 *    logout`, what logout leaves in openclaw.json through `config unset`, the
 *    key's copies in openclaw.json's own backups;
 *  - Hermes: the credential pool through `hermes auth remove` / `logout`,
 *    the key in config.yaml and ClawBox AI's in `.env`, Hermes' good-copy
 *    backups, and a restart of the dashboard;
 *  - a dual box: ClawBox AI out of both harnesses, any other provider out of
 *    the active one only;
 *
 * ClawBox's records about the provider, the default's rule, the owner's other
 * keys left alone — and a result READ BACK, so a credential still on the box
 * is never answered as signed out.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "claw_test_token_0123456789";
const OPENROUTER_KEY = "sk-or-v1-placeholder-0123456789";
const GOOGLE_KEY = "AIzaPlaceholder0123456789";
const ANTHROPIC_KEY = "sk-ant-owners-own-0123456789";

const tmp = vi.hoisted(() => `${process.env.TMPDIR || "/tmp"}/provider-sign-out-test-${process.pid}-${Date.now()}`);
const OPENCLAW_DIR = path.join(tmp, "openclaw");
const HERMES_DIR = path.join(tmp, "hermes");

type Harness = "openclaw" | "hermes";
interface StoreProfile { provider: string; type: string }

/** The box as the mocks below answer it; each case edits it. */
const box = vi.hoisted(() => ({
  harness: "openclaw" as Harness,
  edition: "openclaw" as "openclaw" | "hermes" | "dual",
  /** The gateway's auth store: profile id → its provider. */
  gatewayStore: {} as Record<string, StoreProfile>,
  /** The auth store as `readGatewayAuthProfile` answers when it cannot be read. */
  storeUnreadable: false,
  /** `data/config.json` unreadable for the strict reader. */
  configStoreUnreadable: false,
  /** Whether `models auth logout` removes the store row (and the profile entry). */
  logoutWorks: true,
  config: {} as Record<string, unknown>,
  store: {} as Record<string, unknown>,
  session: null as null | { status: string; createdAt: number; configuringStartedAt?: number },
  hot: { applied: true, how: "hot-reload" } as { applied: boolean; how?: string; why?: string },
  restartRefused: false,
  ready: [true, false] as boolean[],
  /** Hermes' config.yaml, as dotted key → value. */
  hermesConfig: {} as Record<string, string>,
  hermesConfigUnreadable: false,
  hermesEnv: {} as Record<string, string>,
  hermesRemoveWorks: true,
  bounce: "restarted" as "restarted" | "pending" | "failed" | "in_flight",
}));

function signedInConfig(litellmKey: string = TOKEN): Record<string, unknown> {
  return {
    auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "api_key" }, "openai:manual": { provider: "openai", mode: "api_key" } } },
    models: { providers: {
      deepseek: { baseUrl: "https://proxy", apiKey: TOKEN, models: [] },
      litellm: { apiKey: litellmKey, baseUrl: "https://proxy" },
      anthropic: { apiKey: ANTHROPIC_KEY },
    } },
    agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
    // The cloud voice the boot script arms with the token, stamped as ours.
    tts: { providers: { openai: { baseUrl: "https://proxy/v1", model: "voice", apiKey: TOKEN, clawboxManaged: true }, elevenlabs: { apiKey: "el-own" } } },
  };
}

/** A box with ClawBox AI as the default and every other cloud provider connected too. */
function everyProviderConfig(): Record<string, unknown> {
  return {
    auth: {
      profiles: {
        "deepseek:default": { provider: "deepseek", mode: "api_key" },
        "openai:default": { provider: "openai", mode: "api_key" },
        "openai:chatgpt": { provider: "openai", mode: "oauth" },
        "anthropic:default": { provider: "anthropic", mode: "api_key" },
        "anthropic:clawbox-1a2b3c4d": { provider: "anthropic", mode: "token" },
        "google:default": { provider: "google", mode: "oauth" },
        "openrouter:default": { provider: "openrouter", mode: "api_key" },
        "xai:default": { provider: "xai", mode: "oauth" },
      },
      order: { anthropic: ["anthropic:clawbox-1a2b3c4d", "anthropic:default"], openai: ["openai:chatgpt", "openai:default"] },
    },
    models: { providers: {
      deepseek: { baseUrl: "https://proxy", apiKey: TOKEN, models: [] },
      // ClawBox AI's image route in the legacy `openai` slot: ClawBox AI's, not OpenAI's.
      openai: { apiKey: "claw_legacy_image_slot_0123" },
      anthropic: { baseUrl: "https://api.anthropic.com/v1", api: "openai-completions", apiKey: ANTHROPIC_KEY, models: [] },
      google: { baseUrl: "https://generativelanguage.googleapis.com", apiKey: GOOGLE_KEY, models: [] },
      openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKey: OPENROUTER_KEY },
    } },
    agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash", fallbacks: ["openrouter/auto"] } } },
    // The owner's own OpenAI voice key: another setting's, never this sign-out's.
    tts: { providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-owners-voice-key-0123" } } },
  };
}

function everyProviderStore(): Record<string, StoreProfile> {
  const store: Record<string, StoreProfile> = {};
  for (const [id, entry] of Object.entries((everyProviderConfig().auth as { profiles: Record<string, { provider: string; mode: string }> }).profiles)) {
    store[id] = { provider: entry.provider, type: entry.mode };
  }
  return store;
}

/** `config unset <path>` on the fake config. */
function unsetPath(config: Record<string, unknown>, dotted: string): void {
  // Profile ids carry a colon, never a dot, so a plain split is exact here.
  const parts = dotted.split(".");
  let node = config as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    node = (node[part] ?? {}) as Record<string, unknown>;
  }
  delete node[parts[parts.length - 1]];
}

const cli = vi.hoisted(() => ({
  CONFIG_PATH: "",
  spawnOpenclawCli: vi.fn(),
  runOpenclawConfigUnset: vi.fn(),
  flushConfigWrites: vi.fn(async () => undefined),
  readConfig: vi.fn(),
  readConfigStrict: vi.fn(),
}));
cli.CONFIG_PATH = `${tmp}/openclaw/openclaw.json`;
vi.mock("@/lib/openclaw-config", () => cli);
vi.mock("@/lib/openclaw-auth-store", () => ({
  readGatewayAuthProfile: vi.fn((id: string) => (box.storeUnreadable
    ? { kind: "unreadable" }
    : box.gatewayStore[id] ? { kind: "present", type: box.gatewayStore[id].type, store: "shared" } : { kind: "absent", store: "shared" })),
  readGatewayProviderAuth: vi.fn((provider: string) => (box.storeUnreadable
    ? { kind: "unreadable" }
    : {
      kind: "present",
      profiles: Object.entries(box.gatewayStore).filter(([, p]) => p.provider === provider).map(([profileId]) => ({ profileId })),
      order: null,
      failures: {},
    })),
}));
const store = vi.hoisted(() => ({
  DATA_DIR: "/nonexistent-provider-sign-out-test",
  get: vi.fn(async (key: string) => box.store[key]),
  // `@/lib/clawai-credential-refusal` writes the remembered refusal through
  // this; like the real store, undefined removes the key.
  set: vi.fn(async (key: string, value: unknown) => {
    if (value === undefined) delete box.store[key];
    else box.store[key] = value;
  }),
  getKnown: vi.fn(async (key: string) => (box.configStoreUnreadable ? { value: undefined, known: false } : { value: box.store[key], known: true })),
  setMany: vi.fn(async (entries: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(entries)) {
      if (v === undefined) delete box.store[k];
      else box.store[k] = v;
    }
  }),
}));
// Each member named, not `() => store`: the config-store mock gate
// (openclaw-config-mock-completeness.test.ts) reads only a literal factory
// object, and a suite that can reach the refusal reader must carry get/set.
vi.mock("@/lib/config-store", () => ({
  DATA_DIR: store.DATA_DIR,
  get: store.get,
  set: store.set,
  getKnown: store.getKnown,
  setMany: store.setMany,
}));
const credentials = vi.hoisted(() => ({
  forgetClawaiCredentialRefusal: vi.fn(async () => undefined),
  resolveClawaiToken: vi.fn(),
  hasClawaiToken: vi.fn(async () => false),
}));
vi.mock("@/lib/harness/credentials", () => credentials);
vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn(async () => box.harness),
  getActiveHarnessSource: vi.fn(async () => ({ active: box.harness, defaulted: false, edition: box.edition, locked: box.edition !== "dual" })),
}));
const connect = vi.hoisted(() => ({
  readClawAiSession: vi.fn(async () => box.session),
  clearClawAiSession: vi.fn(async () => undefined),
}));
// The real window (`isClawAiSessionConfiguring`); only the session file is faked.
vi.mock("@/lib/clawai-connect", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/clawai-connect")>()), ...connect }));
const gateway = vi.hoisted(() => ({
  readGatewayConfigBaseline: vi.fn(async () => ({ hash: "before" })),
  awaitGatewayHotApply: vi.fn(async () => box.hot),
  restartGatewayAnsweringEarly: vi.fn(async () => {
    if (box.restartRefused) throw new Error("Unit clawbox-gateway.service is masked.");
    return { back: Promise.resolve(true) };
  }),
  diffConfigPaths: vi.fn((a: unknown, b: unknown) => (JSON.stringify(a) === JSON.stringify(b) ? [] : ["models"])),
}));
vi.mock("@/lib/gateway-hot-apply", () => gateway);
const readiness = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/coding-agent", () => ({
  getCodingAgentStatus: vi.fn(async () => ({ ready: box.ready[Math.min(readiness.calls++, box.ready.length - 1)] })),
}));
const refresh = vi.hoisted(() => ({ refreshCodingAgentToolsIfReadinessChanged: vi.fn(async () => undefined) }));
vi.mock("@/lib/coding-agent-mcp-refresh", () => refresh);

// ── Hermes ──────────────────────────────────────────────────────────────────
const hermesYaml = vi.hoisted(() => ({
  hermesConfigPath: vi.fn(() => `${tmp}/hermes/config.yaml`),
  resolveHermesConfigValue: vi.fn(async (key: string) => {
    if (box.hermesConfigUnreadable) return { state: "unreadable" };
    return Object.hasOwn(box.hermesConfig, key) ? { state: "value", value: box.hermesConfig[key] } : { state: "absent" };
  }),
  // The merge path keeps the previous revision beside the file, as the real one does.
  patchHermesConfig: vi.fn(async (patch: { unset?: string[] }) => {
    const previous = Object.entries(box.hermesConfig).map(([k, v]) => `${k}: ${v}`).join("\n");
    fs.writeFileSync(`${tmp}/hermes/config.yaml.bak`, previous, { mode: 0o600 });
    for (const key of patch.unset ?? []) delete box.hermesConfig[key];
    return { mode: "merge", backupPath: `${tmp}/hermes/config.yaml.bak` };
  }),
}));
vi.mock("@/lib/hermes-config-yaml", () => hermesYaml);
const hermesEnv = vi.hoisted(() => ({
  hermesHome: vi.fn(() => `${tmp}/hermes`),
  hermesEnvPath: vi.fn(() => `${tmp}/hermes/.env`),
  getHermesEnvValue: vi.fn(async (key: string) => box.hermesEnv[key] ?? null),
  clearHermesEnvValues: vi.fn(async (keys: string[]) => { for (const key of keys) delete box.hermesEnv[key]; }),
}));
vi.mock("@/lib/hermes-env", () => hermesEnv);
vi.mock("@/lib/hermes-image-plugin", () => ({ HERMES_IMAGE_TOKEN_ENV: "CLAWBOX_AI_TOKEN" }));
const hermesCli = vi.hoisted(() => ({ runHermesCli: vi.fn() }));
vi.mock("@/lib/hermes-cli", () => hermesCli);
const modelOptions = vi.hoisted(() => ({ invalidateModelOptions: vi.fn(), getModelOptions: vi.fn(), probeStillOwed: vi.fn(async () => false) }));
vi.mock("@/lib/hermes-model-options", () => modelOptions);
const bounce = vi.hoisted(() => ({ bounceHermesDashboardShared: vi.fn(async () => box.bounce) }));
vi.mock("@/lib/hermes-bounce-claim", () => bounce);
const messaging = vi.hoisted(() => ({ restartHermesGatewayIfRunning: vi.fn(async () => null) }));
vi.mock("@/lib/clawbox-mcp-registration", () => messaging);

import { signOutOfProvider } from "@/lib/provider-sign-out";
import { withProviderChangeLock } from "@/lib/provider-change-lock";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

type AuthJson = { version: 1; providers: Record<string, unknown>; credential_pool: Record<string, Record<string, unknown>[]> };

function writeAuth(auth: AuthJson): void {
  fs.writeFileSync(path.join(HERMES_DIR, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
}

function readAuth(): AuthJson {
  return JSON.parse(fs.readFileSync(path.join(HERMES_DIR, "auth.json"), "utf8")) as AuthJson;
}

/** A box on Hermes with ClawBox AI as the default and OpenRouter, Anthropic and Gemini connected. */
function hermesBox(): void {
  box.harness = "hermes";
  box.edition = "hermes";
  box.config = {};
  box.gatewayStore = {};
  box.hermesConfig = {
    "model.provider": "clawai",
    "model.default": "deepseek-v4-pro",
    "providers.clawai.base_url": "https://proxy",
    "providers.clawai.api_key": TOKEN,
    // ClawBox AI's cloud voice carries the token too.
    "tts.openai.api_key": TOKEN,
  };
  box.hermesEnv = { CLAWBOX_AI_TOKEN: TOKEN, TELEGRAM_BOT_TOKEN: "owners-bot-token" };
  writeAuth({
    version: 1,
    providers: { anthropic: { access_token: "anthropic-oauth-access-0123" } },
    credential_pool: {
      openrouter: [{ id: "087208", label: "api-key-1", source: "manual", access_token: OPENROUTER_KEY }],
      anthropic: [{ id: "a1b2c3", label: "claude", source: "hermes_pkce", access_token: "anthropic-oauth-access-0123" }],
      gemini: [{ id: "g1h2i3", label: "api-key-1", source: "manual", access_token: GOOGLE_KEY }],
      // Seeded from config.yaml by Hermes itself: a fingerprint, never the key.
      "custom:clawai": [{ id: "4c3b30", label: "clawai", source: "config:clawai", secret_fingerprint: "sha256:00" }],
    },
  });
  fs.writeFileSync(path.join(HERMES_DIR, "backups", "config", "config.yaml.good.20261102-202429"), `providers:\n  clawai:\n    api_key: ${TOKEN}\n  openrouter:\n    note: keep\n`, { mode: 0o600 });
}

beforeEach(() => {
  vi.clearAllMocks();
  readiness.calls = 0;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(OPENCLAW_DIR, { recursive: true });
  fs.mkdirSync(path.join(HERMES_DIR, "backups", "config"), { recursive: true });
  box.harness = "openclaw";
  box.edition = "openclaw";
  box.gatewayStore = { "deepseek:default": { provider: "deepseek", type: "api_key" } };
  box.storeUnreadable = false;
  box.configStoreUnreadable = false;
  box.restartRefused = false;
  box.logoutWorks = true;
  box.config = signedInConfig();
  box.store = {
    clawai_token: TOKEN,
    clawai_tier: "flash",
    clawai_plan_tier: "flash",
    ai_model_explicit_picks: { clawai: "deepseek-v4-pro", openai: "gpt-5.6" },
    ai_model_provider: "clawai",
  };
  box.session = null;
  box.hot = { applied: true, how: "hot-reload" };
  box.ready = [true, false];
  box.hermesConfig = {};
  box.hermesConfigUnreadable = false;
  box.hermesEnv = {};
  box.hermesRemoveWorks = true;
  box.bounce = "restarted";
  cli.readConfig.mockImplementation(async () => structuredClone(box.config));
  cli.readConfigStrict.mockImplementation(async () => structuredClone(box.config));
  cli.spawnOpenclawCli.mockImplementation(async (args: string[]) => {
    const [models, auth, logout, profileId, yes] = args;
    if (models !== "models" || auth !== "auth" || logout !== "logout" || yes !== "--yes") throw new Error(`unexpected ${args.join(" ")}`);
    if (!box.logoutWorks) throw new Error("logout failed");
    delete box.gatewayStore[profileId];
    unsetPath(box.config, `auth.profiles.${profileId}`);
    return { stdout: "", stderr: "" };
  });
  cli.runOpenclawConfigUnset.mockImplementation(async (dotted: string) => { unsetPath(box.config, dotted); });
  credentials.resolveClawaiToken.mockImplementation(async () => {
    const inline = ((box.config.models as { providers?: Record<string, { apiKey?: unknown }> } | undefined)?.providers?.deepseek?.apiKey);
    return typeof inline === "string" ? inline : (typeof box.store.clawai_token === "string" ? box.store.clawai_token : null);
  });
  hermesCli.runHermesCli.mockImplementation(async (args: string[]) => {
    const auth = readAuth();
    if (args[0] === "auth" && args[1] === "remove") {
      if (!box.hermesRemoveWorks) return { code: 1, stdout: "", stderr: "locked" };
      const [, , key, target] = args;
      const rows = auth.credential_pool[key] ?? [];
      const index = rows.findIndex((row, i) => row.id === target || String(i + 1) === target);
      if (index < 0) return { code: 1, stdout: "", stderr: `No credential matching "${target}"` };
      rows.splice(index, 1);
      writeAuth(auth);
      return { code: 0, stdout: `Removed ${key} credential`, stderr: "" };
    }
    if (args[0] === "auth" && args[1] === "logout") {
      delete auth.providers[args[2]];
      delete auth.credential_pool[args[2]];
      writeAuth(auth);
      return { code: 0, stdout: "Logged out.", stderr: "" };
    }
    throw new Error(`unexpected hermes ${args.join(" ")}`);
  });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("signOutOfProvider — ClawBox AI on OpenClaw (#1369's sign-out, generalised)", () => {
  it("removes the profile natively, the key copies logout leaves, and the account's records — and says so", async () => {
    const result = await signOutOfProvider("clawai");
    expect(result).toEqual({ ok: true, changed: true, gatewayRestarting: false });

    expect(cli.spawnOpenclawCli).toHaveBeenCalledWith(["models", "auth", "logout", "deepseek:default", "--yes"], expect.objectContaining({ timeoutMs: 60_000 }));
    expect(cli.spawnOpenclawCli).toHaveBeenCalledTimes(1);
    expect(cli.runOpenclawConfigUnset.mock.calls.map((c) => c[0])).toEqual([
      "models.providers.deepseek.apiKey",
      "models.providers.litellm.apiKey",
      // Our own cloud voice goes whole: the boot script never withdraws it once the token is gone.
      "tts.providers.openai",
    ]);
    // The provider definition and the default stay: the chat says "sign in again".
    expect(box.config).toMatchObject({
      auth: { profiles: { "openai:manual": { provider: "openai" } } },
      models: { providers: { deepseek: { baseUrl: "https://proxy" }, anthropic: { apiKey: ANTHROPIC_KEY } } },
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
      tts: { providers: { elevenlabs: { apiKey: "el-own" } } },
    });
    expect((box.config.tts as { providers: Record<string, unknown> }).providers).not.toHaveProperty("openai");
    expect((box.config.auth as { profiles: Record<string, unknown> }).profiles).not.toHaveProperty("deepseek:default");

    // The old account's token, badge, plan and pick gone; the rest kept.
    expect(box.store).toEqual({ ai_model_explicit_picks: { openai: "gpt-5.6" }, ai_model_provider: "clawai" });
    expect(credentials.forgetClawaiCredentialRefusal).toHaveBeenCalledTimes(1);
    expect(connect.clearClawAiSession).toHaveBeenCalledTimes(1);

    // The gateway is asked to apply the credential change, not restarted.
    expect(gateway.awaitGatewayHotApply).toHaveBeenCalledWith({ baseline: { hash: "before" }, configChanged: true, credentialsWritten: true });
    expect(gateway.restartGatewayAnsweringEarly).not.toHaveBeenCalled();
    // The coding tools follow the readiness the token gave them.
    expect(refresh.refreshCodingAgentToolsIfReadinessChanged).toHaveBeenCalledWith(true, false);
    // A single-edition OpenClaw box: Hermes is never asked.
    expect(hermesCli.runHermesCli).not.toHaveBeenCalled();
    expect(bounce.bounceHermesDashboardShared).not.toHaveBeenCalled();
  });

  it("leaves the owner's own keys, takes every ClawBox AI copy — and only the key out of an owner's own voice entry", async () => {
    box.config = signedInConfig("sk-owners-own-litellm-key");
    (box.config.models as { providers: Record<string, unknown> }).providers.openai = { apiKey: "claw_legacy_image_slot" };
    box.config.tts = { providers: { openai: { baseUrl: "https://owners-own/v1", apiKey: TOKEN } } };
    expect(await signOutOfProvider("clawai")).toMatchObject({ ok: true });
    expect(cli.runOpenclawConfigUnset.mock.calls.map((c) => c[0])).toEqual([
      "models.providers.deepseek.apiKey",
      "models.providers.openai.apiKey",
      "tts.providers.openai.apiKey",
    ]);
    expect(box.config).toMatchObject({
      models: { providers: { litellm: { apiKey: "sk-owners-own-litellm-key" } } },
      tts: { providers: { openai: { baseUrl: "https://owners-own/v1" } } },
    });
  });

  it("takes the memory search's remote key too, wherever the core keeps it", async () => {
    box.config.memory = { search: { remote: { baseUrl: "https://proxy/v1", apiKey: TOKEN }, provider: "openai" } };
    box.config.agents = { defaults: { model: { primary: "deepseek/deepseek-v4-flash" }, memorySearch: { remote: { apiKey: "claw_other_device_token" } } } };
    expect(await signOutOfProvider("clawai")).toMatchObject({ ok: true });
    expect(cli.runOpenclawConfigUnset.mock.calls.map((c) => c[0])).toEqual([
      "models.providers.deepseek.apiKey",
      "models.providers.litellm.apiKey",
      "agents.defaults.memorySearch.remote.apiKey",
      "tts.providers.openai",
      "memory.search.remote.apiKey",
    ]);
    expect(box.config).toMatchObject({ memory: { search: { remote: { baseUrl: "https://proxy/v1" }, provider: "openai" } } });
  });

  it("clears the token out of openclaw.json's backups, and leaves an owner's other keys in them", async () => {
    const backup = path.join(OPENCLAW_DIR, "openclaw.json.bak.1");
    const lastGood = path.join(OPENCLAW_DIR, "openclaw.json.last-good");
    const other = path.join(OPENCLAW_DIR, "notes.json");
    fs.writeFileSync(backup, JSON.stringify(signedInConfig()), { mode: 0o600 });
    fs.writeFileSync(lastGood, JSON.stringify(signedInConfig()), { mode: 0o600 });
    fs.writeFileSync(other, JSON.stringify({ apiKey: TOKEN }));
    expect(await signOutOfProvider("clawai")).toMatchObject({ ok: true });
    for (const file of [backup, lastGood]) {
      const text = fs.readFileSync(file, "utf8");
      expect(text).not.toContain(TOKEN);
      expect(text).toContain(ANTHROPIC_KEY);
      // Still a file the gateway could roll back to.
      expect(JSON.parse(text)).toMatchObject({ models: { providers: { deepseek: { apiKey: "" } } } });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    // Only the config's own copies are the sign-out's.
    expect(fs.readFileSync(other, "utf8")).toContain(TOKEN);
  });

  it("signs out a box where only the voice copy was left, rather than answer it already signed out", async () => {
    box.gatewayStore = {};
    box.config = { models: { providers: { deepseek: { baseUrl: "https://proxy" } } }, tts: signedInConfig().tts };
    box.store = {};
    expect(await signOutOfProvider("clawai")).toMatchObject({ ok: true, changed: true });
    expect(cli.runOpenclawConfigUnset.mock.calls.map((c) => c[0])).toEqual(["tts.providers.openai"]);
  });

  it("removes a profile entry logout could not, with config unset", async () => {
    box.logoutWorks = false;
    box.gatewayStore = {};
    expect(await signOutOfProvider("clawai")).toMatchObject({ ok: true, changed: true });
    expect(cli.runOpenclawConfigUnset.mock.calls.map((c) => c[0])).toEqual([
      "auth.profiles.deepseek:default",
      "models.providers.deepseek.apiKey",
      "models.providers.litellm.apiKey",
      "tts.providers.openai",
    ]);
  });

  it("restarts the gateway when it does not confirm the change, and follows one it is making itself", async () => {
    box.hot = { applied: false, why: "timeout" };
    expect(await signOutOfProvider("clawai")).toEqual({ ok: true, changed: true, gatewayRestarting: true });
    expect(gateway.restartGatewayAnsweringEarly).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    box.config = signedInConfig();
    box.gatewayStore = { "deepseek:default": { provider: "deepseek", type: "api_key" } };
    box.store.clawai_token = TOKEN;
    box.hot = { applied: false, why: "gateway-restarting" };
    expect(await signOutOfProvider("clawai")).toEqual({ ok: true, changed: true, gatewayRestarting: true });
    expect(gateway.restartGatewayAnsweringEarly).not.toHaveBeenCalled();
  });

  it("never answers signed out while the gateway's store still holds the profile — and the coding agent still hears the token is gone", async () => {
    box.logoutWorks = false;
    const result = await signOutOfProvider("clawai");
    expect(result).toMatchObject({ ok: false, kind: "still_signed_in", error: expect.stringMatching(/ClawBox AI sign-in could not be removed from the gateway's auth store/) });
    expect(box.store.clawai_token).toBeUndefined();
    expect(refresh.refreshCodingAgentToolsIfReadinessChanged).toHaveBeenCalledWith(true, false);
  });

  it("never answers signed out over a store it could not read to check", async () => {
    box.configStoreUnreadable = true;
    expect(await signOutOfProvider("clawai")).toMatchObject({ ok: false, kind: "still_signed_in", error: expect.stringMatching(/checked in the ClawBox config store/) });
    box.configStoreUnreadable = false;
    box.config = signedInConfig();
    box.gatewayStore = { "deepseek:default": { provider: "deepseek", type: "api_key" } };
    box.store.clawai_token = TOKEN;
    cli.readConfigStrict.mockRejectedValueOnce(new Error("openclaw.json is not valid JSON"));
    expect(await signOutOfProvider("clawai")).toMatchObject({ ok: false, kind: "still_signed_in", error: expect.stringMatching(/checked in openclaw.json/) });
    box.config = signedInConfig();
    box.gatewayStore = { "deepseek:default": { provider: "deepseek", type: "api_key" } };
    box.store.clawai_token = TOKEN;
    box.logoutWorks = false;
    box.storeUnreadable = true;
    expect(await signOutOfProvider("clawai")).toMatchObject({ ok: false, kind: "still_signed_in", error: expect.stringMatching(/checked in the gateway's auth store/) });
  });

  it("never answers signed out while the row's own reader still finds a ClawBox AI token", async () => {
    credentials.hasClawaiToken.mockResolvedValue(true);
    expect(await signOutOfProvider("clawai")).toMatchObject({ ok: false, kind: "still_signed_in", error: expect.stringMatching(/removed from the box's ClawBox AI sign-in/) });
  });

  it("says so when the gateway restart that would drop the old sign-in was refused", async () => {
    box.hot = { applied: false, why: "timeout" };
    box.restartRefused = true;
    expect(await signOutOfProvider("clawai")).toMatchObject({ ok: false, kind: "restart_refused" });
    // The box itself is signed out: a second tap has nothing left to remove.
    expect(box.store.clawai_token).toBeUndefined();
  });

  it("answers an already signed-out box at once, touching nothing", async () => {
    box.gatewayStore = {};
    box.config = { models: { providers: { deepseek: { baseUrl: "https://proxy" } } } };
    box.store = { ai_model_provider: "clawai" };
    expect(await signOutOfProvider("clawai")).toEqual({ ok: true, changed: false, gatewayRestarting: false });
    expect(cli.spawnOpenclawCli).not.toHaveBeenCalled();
    expect(cli.runOpenclawConfigUnset).not.toHaveBeenCalled();
    expect(gateway.awaitGatewayHotApply).not.toHaveBeenCalled();
  });

  it("refuses while a device login is writing its token — before anything is touched", async () => {
    box.session = { status: "configuring", createdAt: Date.now() };
    expect(await signOutOfProvider("clawai")).toMatchObject({ ok: false, kind: "sign_in_in_progress" });
    // The poll's window runs from when the configure began, not from the code.
    box.session = { status: "configuring", createdAt: Date.now() - 20 * 60_000, configuringStartedAt: Date.now() - 30_000 } as typeof box.session;
    expect(await signOutOfProvider("clawai")).toMatchObject({ ok: false, kind: "sign_in_in_progress" });
    expect(cli.spawnOpenclawCli).not.toHaveBeenCalled();
    expect(store.setMany).not.toHaveBeenCalled();
    expect(box.store.clawai_token).toBe(TOKEN);
  });

  it("goes ahead over a configure the poll has already given up on", async () => {
    box.session = { status: "configuring", createdAt: Date.now() - 20 * 60_000, configuringStartedAt: Date.now() - 4 * 60_000 } as typeof box.session;
    expect(await signOutOfProvider("clawai")).toMatchObject({ ok: true, changed: true });
    expect(connect.clearClawAiSession).toHaveBeenCalled();
  });

  it("signs out of the default — the box's own provider stays the default, reading 'sign in again'", async () => {
    // signedInConfig's primary is ClawBox AI's: #1369's rule, kept.
    expect(await signOutOfProvider("clawai")).toMatchObject({ ok: true });
    expect(box.config).toMatchObject({ agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } } });
  });
});

describe("signOutOfProvider — every other provider on OpenClaw", () => {
  beforeEach(() => {
    box.config = everyProviderConfig();
    box.gatewayStore = everyProviderStore();
    box.store = {
      clawai_token: TOKEN,
      ai_model_explicit_picks: { clawai: "deepseek-v4-pro", openai: "gpt-5.6", codex: "gpt-5.6-codex", google: "gemini-3-pro", openrouter: "auto", anthropic: "claude-sonnet-5" },
      ai_model_unavailable: { openai: { "gpt-old": { reason: "not_found", at: Date.now() } }, google: { "gemini-old": { reason: "not_found", at: Date.now() } } },
      provider_verified_at: { openrouter: new Date().toISOString(), clawai: new Date().toISOString() },
      anthropic_accounts: [{ id: "1a2b3c4d", kind: "oauth" }],
    };
  });

  const profilesNow = () => Object.keys((box.config.auth as { profiles: Record<string, unknown> }).profiles);
  const providersNow = () => (box.config.models as { providers: Record<string, Record<string, unknown>> }).providers;
  const loggedOut = () => cli.spawnOpenclawCli.mock.calls.map((c) => (c[0] as string[])[3]);
  const unset = () => cli.runOpenclawConfigUnset.mock.calls.map((c) => c[0]);

  it("OpenAI: its API key and its ChatGPT sign-in, and its picks — never ClawBox AI's image key in the openai slot", async () => {
    expect(await signOutOfProvider("openai")).toEqual({ ok: true, changed: true, gatewayRestarting: false });
    expect(loggedOut().sort()).toEqual(["openai:chatgpt", "openai:default"]);
    expect(unset()).toEqual(["auth.order.openai"]);
    expect(profilesNow()).not.toContain("openai:default");
    expect(profilesNow()).not.toContain("openai:chatgpt");
    expect(providersNow().openai).toEqual({ apiKey: "claw_legacy_image_slot_0123" });
    expect(box.store.ai_model_explicit_picks).toEqual({ clawai: "deepseek-v4-pro", google: "gemini-3-pro", openrouter: "auto", anthropic: "claude-sonnet-5" });
    expect(box.store.ai_model_unavailable).not.toHaveProperty("openai");
    expect(box.store.ai_model_unavailable).toHaveProperty("google");
    // ClawBox AI, its token and the owner's voice key: untouched.
    expect(box.store.clawai_token).toBe(TOKEN);
    expect(box.gatewayStore).toHaveProperty("deepseek:default");
    expect(box.config).toMatchObject({ tts: { providers: { openai: { apiKey: "sk-owners-voice-key-0123" } } } });
    expect(gateway.awaitGatewayHotApply).toHaveBeenCalledWith({ baseline: { hash: "before" }, configChanged: true, credentialsWritten: true });
    // ClawBox AI's records are its own sign-out's.
    expect(credentials.forgetClawaiCredentialRefusal).not.toHaveBeenCalled();
    expect(refresh.refreshCodingAgentToolsIfReadinessChanged).not.toHaveBeenCalled();
  });

  it("OpenRouter: the profile, the key inline in its definition and in the backups — the definition and the chat stay", async () => {
    const backup = path.join(OPENCLAW_DIR, "openclaw.json.bak");
    fs.writeFileSync(backup, JSON.stringify(everyProviderConfig()), { mode: 0o600 });
    expect(await signOutOfProvider("openrouter")).toMatchObject({ ok: true, changed: true });
    expect(loggedOut()).toEqual(["openrouter:default"]);
    expect(unset()).toEqual(["models.providers.openrouter.apiKey"]);
    expect(providersNow().openrouter).toEqual({ baseUrl: "https://openrouter.ai/api/v1" });
    expect(box.config).toMatchObject({ agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } } });
    expect(box.store.provider_verified_at).toEqual({ clawai: expect.any(String) });
    const copy = fs.readFileSync(backup, "utf8");
    expect(copy).not.toContain(OPENROUTER_KEY);
    expect(copy).toContain(GOOGLE_KEY);
    expect(copy).toContain(TOKEN);
  });

  it("Google Gemini: its sign-in and the access token it keeps inline", async () => {
    expect(await signOutOfProvider("google")).toMatchObject({ ok: true });
    expect(loggedOut()).toEqual(["google:default"]);
    expect(unset()).toEqual(["models.providers.google.apiKey"]);
    expect(box.store.ai_model_explicit_picks).not.toHaveProperty("google");
    expect(providersNow().openrouter.apiKey).toBe(OPENROUTER_KEY);
  });

  it("Anthropic: its key, every profile the gateway holds for it and its order — the coding agent's accounts stay", async () => {
    expect(await signOutOfProvider("anthropic")).toMatchObject({ ok: true });
    expect(loggedOut().sort()).toEqual(["anthropic:clawbox-1a2b3c4d", "anthropic:default"]);
    expect(unset()).toEqual(["auth.order.anthropic", "models.providers.anthropic.apiKey"]);
    expect(Object.keys(box.gatewayStore).filter((id) => id.startsWith("anthropic:"))).toEqual([]);
    expect(box.store.anthropic_accounts).toEqual([{ id: "1a2b3c4d", kind: "oauth" }]);
  });

  it("xAI Grok: a SuperGrok sign-in the store holds", async () => {
    expect(await signOutOfProvider("xai")).toMatchObject({ ok: true });
    expect(loggedOut()).toEqual(["xai:default"]);
    expect(profilesNow()).not.toContain("xai:default");
  });

  it("a profile only the gateway's store holds is signed out too", async () => {
    box.gatewayStore["openrouter:second"] = { provider: "openrouter", type: "api_key" };
    expect(await signOutOfProvider("openrouter")).toMatchObject({ ok: true });
    expect(loggedOut().sort()).toEqual(["openrouter:default", "openrouter:second"]);
  });

  it("refuses the default — make another provider the default first — and touches nothing", async () => {
    (box.config.agents as { defaults: { model: { primary: string } } }).defaults.model.primary = "openai/gpt-5.6";
    expect(await signOutOfProvider("openai")).toMatchObject({
      ok: false,
      kind: "is_default",
      error: "OpenAI GPT is the default provider. Make another provider the default first, then sign out of it.",
    });
    // A ChatGPT pick is the same row's default.
    (box.config.agents as { defaults: { model: { primary: string } } }).defaults.model.primary = "openai-codex/gpt-5.6-codex";
    expect(await signOutOfProvider("openai")).toMatchObject({ ok: false, kind: "is_default" });
    expect(cli.spawnOpenclawCli).not.toHaveBeenCalled();
    expect(store.setMany).not.toHaveBeenCalled();
  });

  it("a default write that arrives during the sign-out waits until the key is gone", async () => {
    // The sign-out is inside its removal (its first logout has started)...
    let inRemoval!: () => void;
    const removing = new Promise<void>((resolve) => { inRemoval = resolve; });
    const logout = cli.spawnOpenclawCli.getMockImplementation()!;
    cli.spawnOpenclawCli.mockImplementation(async (args: string[], opts: unknown) => {
      inRemoval();
      await tick();
      return logout(args, opts);
    });
    const signingOut = signOutOfProvider("openrouter");
    await removing;
    // ...when a second browser makes OpenRouter the default — through the
    // writer's own lock, as /setup-api/chat/model takes it.
    let seenByWriter: string[] | null = null;
    const write = withProviderChangeLock(async () => {
      seenByWriter = Object.keys(box.gatewayStore).filter((id) => id.startsWith("openrouter:"));
      (box.config.agents as { defaults: { model: { primary: string } } }).defaults.model.primary = "openrouter/auto";
    });
    expect(await signingOut).toMatchObject({ ok: true, changed: true });
    await write;
    // It ran after the removal, and so sees a provider with nothing to sign in with.
    expect(seenByWriter).toEqual([]);
  });

  it("a sign-out that arrives after a default write sees the new default, and touches nothing", async () => {
    const write = withProviderChangeLock(async () => {
      (box.config.agents as { defaults: { model: { primary: string } } }).defaults.model.primary = "openrouter/auto";
    });
    expect(await signOutOfProvider("openrouter")).toMatchObject({ ok: false, kind: "is_default" });
    await write;
    expect(cli.spawnOpenclawCli).not.toHaveBeenCalled();
    expect(box.gatewayStore).toHaveProperty("openrouter:default");
  });

  it("refuses when it cannot read which provider is the default, or none is set", async () => {
    cli.readConfigStrict.mockRejectedValueOnce(new Error("openclaw.json is not valid JSON"));
    expect(await signOutOfProvider("openrouter")).toMatchObject({ ok: false, kind: "default_unknown", error: expect.stringMatching(/could not read/) });
    delete (box.config.agents as { defaults: { model: Record<string, unknown> } }).defaults.model.primary;
    expect(await signOutOfProvider("openrouter")).toMatchObject({ ok: false, kind: "default_unknown", error: expect.stringMatching(/^No provider is set as the default/) });
    expect(cli.spawnOpenclawCli).not.toHaveBeenCalled();
  });

  it("never hands the CLI a profile id it would read as a flag — and says the sign-in is still there", async () => {
    (box.config.auth as { profiles: Record<string, unknown> }).profiles["--force"] = { provider: "openrouter", mode: "api_key" };
    expect(await signOutOfProvider("openrouter")).toMatchObject({ ok: false, kind: "still_signed_in", error: expect.stringMatching(/removed from openclaw.json/) });
    expect(loggedOut()).toEqual(["openrouter:default"]);
    expect(unset()).not.toContain("auth.profiles.--force");
  });

  it("leaves a value in the backups that another setting still holds live", async () => {
    // The owner's voice happens to use the same string as the OpenRouter key.
    (box.config.tts as { providers: { openai: { apiKey: string } } }).providers.openai.apiKey = OPENROUTER_KEY;
    const backup = path.join(OPENCLAW_DIR, "openclaw.json.last-good");
    fs.writeFileSync(path.join(OPENCLAW_DIR, "openclaw.json"), JSON.stringify(box.config));
    fs.writeFileSync(backup, JSON.stringify(everyProviderConfig()), { mode: 0o600 });
    cli.runOpenclawConfigUnset.mockImplementation(async (dotted: string) => {
      unsetPath(box.config, dotted);
      fs.writeFileSync(path.join(OPENCLAW_DIR, "openclaw.json"), JSON.stringify(box.config));
    });
    expect(await signOutOfProvider("openrouter")).toMatchObject({ ok: true });
    expect(providersNow().openrouter).not.toHaveProperty("apiKey");
    expect(fs.readFileSync(backup, "utf8")).toContain(OPENROUTER_KEY);
  });

  it("never answers signed out while it cannot check ClawBox's records of the provider", async () => {
    box.configStoreUnreadable = true;
    expect(await signOutOfProvider("openrouter")).toMatchObject({ ok: false, kind: "still_signed_in", error: expect.stringMatching(/checked in the ClawBox config store/) });
  });

  it("never answers signed out while the store still holds the key", async () => {
    box.logoutWorks = false;
    // The entry and the inline key go with config unset, the store row does not.
    expect(await signOutOfProvider("openrouter")).toMatchObject({
      ok: false,
      kind: "still_signed_in",
      error: expect.stringMatching(/^The OpenRouter sign-in could not be removed from the gateway's auth store\./),
    });
  });

  it("answers a provider that holds nothing as already signed out, touching nothing", async () => {
    box.config = signedInConfig();
    box.gatewayStore = { "deepseek:default": { provider: "deepseek", type: "api_key" } };
    expect(await signOutOfProvider("openrouter")).toEqual({ ok: true, changed: false, gatewayRestarting: false });
    expect(cli.spawnOpenclawCli).not.toHaveBeenCalled();
    expect(cli.runOpenclawConfigUnset).not.toHaveBeenCalled();
    expect(gateway.awaitGatewayHotApply).not.toHaveBeenCalled();
  });

  it("refuses an on-device engine, an unknown shape and the auto provider", async () => {
    for (const id of ["llamacpp", "ollama", "", "../etc", "auto"]) {
      expect(await signOutOfProvider(id), id).toMatchObject({ ok: false, kind: "unknown_provider" });
    }
    expect(cli.spawnOpenclawCli).not.toHaveBeenCalled();
  });
});

describe("signOutOfProvider — Hermes", () => {
  beforeEach(() => hermesBox());

  const removed = () => hermesCli.runHermesCli.mock.calls.map((c) => (c[0] as string[]).join(" "));

  it("ClawBox AI: its key in config.yaml and the voice, the .env token, the backups — the block and the default stay", async () => {
    expect(await signOutOfProvider("clawai")).toEqual({ ok: true, changed: true, gatewayRestarting: false });
    expect(hermesYaml.patchHermesConfig).toHaveBeenCalledWith({ unset: ["providers.clawai.api_key", "tts.openai.api_key"] });
    expect(box.hermesConfig).toEqual({
      "model.provider": "clawai",
      "model.default": "deepseek-v4-pro",
      "providers.clawai.base_url": "https://proxy",
    });
    expect(box.hermesEnv).toEqual({ TELEGRAM_BOT_TOKEN: "owners-bot-token" });
    // Hermes' own fingerprint row is not the key: it is pruned once the key is gone.
    expect(removed()).toEqual([]);
    for (const copy of ["config.yaml.bak", "backups/config/config.yaml.good.20261102-202429"]) {
      const text = fs.readFileSync(path.join(HERMES_DIR, copy), "utf8");
      expect(text, copy).not.toContain(TOKEN);
    }
    expect(fs.readFileSync(path.join(HERMES_DIR, "backups/config/config.yaml.good.20261102-202429"), "utf8")).toContain("note: keep");
    expect(box.store).toEqual({ ai_model_explicit_picks: { openai: "gpt-5.6" }, ai_model_provider: "clawai" });
    // The running agent read `.env` when it started: restarted, under the shared claim.
    expect(bounce.bounceHermesDashboardShared).toHaveBeenCalledTimes(1);
    expect(messaging.restartHermesGatewayIfRunning).toHaveBeenCalledTimes(1);
    expect(modelOptions.invalidateModelOptions).toHaveBeenCalled();
    // OpenClaw is not on this box.
    expect(cli.spawnOpenclawCli).not.toHaveBeenCalled();
    expect(gateway.awaitGatewayHotApply).not.toHaveBeenCalled();
  });

  it("ClawBox AI: an owner's own voice key stays", async () => {
    box.hermesConfig["tts.openai.api_key"] = "sk-owners-voice-key-0123";
    expect(await signOutOfProvider("clawai")).toMatchObject({ ok: true });
    expect(hermesYaml.patchHermesConfig).toHaveBeenCalledWith({ unset: ["providers.clawai.api_key"] });
    expect(box.hermesConfig["tts.openai.api_key"]).toBe("sk-owners-voice-key-0123");
  });

  it("OpenRouter: its pool row through `hermes auth remove`, nothing of anyone else's", async () => {
    box.store.ai_model_explicit_picks = { clawai: "deepseek-v4-pro", openrouter: "auto" };
    expect(await signOutOfProvider("openrouter")).toEqual({ ok: true, changed: true, gatewayRestarting: false });
    expect(removed()).toEqual(["auth remove openrouter 087208"]);
    const auth = readAuth();
    expect(auth.credential_pool.openrouter).toEqual([]);
    expect(auth.credential_pool.gemini).toHaveLength(1);
    expect(auth.providers).toHaveProperty("anthropic");
    expect(hermesYaml.patchHermesConfig).not.toHaveBeenCalled();
    expect(box.hermesEnv.CLAWBOX_AI_TOKEN).toBe(TOKEN);
    expect(box.store.ai_model_explicit_picks).toEqual({ clawai: "deepseek-v4-pro" });
    expect(box.store.clawai_token).toBe(TOKEN);
    expect(bounce.bounceHermesDashboardShared).toHaveBeenCalledTimes(1);
  });

  it("Anthropic: the pool row and the OAuth block", async () => {
    expect(await signOutOfProvider("anthropic")).toMatchObject({ ok: true });
    expect(removed()).toEqual(["auth remove anthropic a1b2c3", "auth logout anthropic"]);
    expect(readAuth().providers).not.toHaveProperty("anthropic");
  });

  it("Google Gemini, by Hermes' own slug", async () => {
    expect(await signOutOfProvider("gemini")).toMatchObject({ ok: true });
    expect(removed()).toEqual(["auth remove gemini g1h2i3"]);
  });

  it("a provider defined in config.yaml: its api_key", async () => {
    box.hermesConfig["providers.together.api_key"] = "tg-owners-key-0123456789";
    box.hermesConfig["providers.together.base_url"] = "https://api.together.xyz/v1";
    expect(await signOutOfProvider("together")).toMatchObject({ ok: true });
    expect(hermesYaml.patchHermesConfig).toHaveBeenCalledWith({ unset: ["providers.together.api_key"] });
    expect(box.hermesConfig["providers.together.base_url"]).toBe("https://api.together.xyz/v1");
  });

  it("refuses the default, by config.yaml's own selection", async () => {
    box.hermesConfig["model.provider"] = "openrouter";
    expect(await signOutOfProvider("openrouter")).toMatchObject({ ok: false, kind: "is_default", error: expect.stringMatching(/^OpenRouter is the default provider/) });
    box.hermesConfigUnreadable = true;
    expect(await signOutOfProvider("gemini")).toMatchObject({ ok: false, kind: "default_unknown" });
    expect(hermesCli.runHermesCli).not.toHaveBeenCalled();
  });

  it("refuses any provider but ClawBox AI while Hermes picks its own (auto, or nothing set)", async () => {
    box.hermesConfig["model.provider"] = "auto";
    expect(await signOutOfProvider("openrouter")).toMatchObject({ ok: false, kind: "default_unknown", error: expect.stringMatching(/^No provider is set as the default/) });
    delete box.hermesConfig["model.provider"];
    expect(await signOutOfProvider("gemini")).toMatchObject({ ok: false, kind: "default_unknown" });
    expect(hermesCli.runHermesCli).not.toHaveBeenCalled();
    // ClawBox AI keeps #1369's rule.
    expect(await signOutOfProvider("clawai")).toMatchObject({ ok: true });
  });

  it("an env-seeded pool row goes through `hermes auth remove` even when it copies no secret", async () => {
    const auth = readAuth();
    auth.credential_pool.openrouter = [{ id: "e-1", label: "OPENROUTER_API_KEY", source: "env:OPENROUTER_API_KEY" }];
    writeAuth(auth);
    expect(await signOutOfProvider("openrouter")).toMatchObject({ ok: true, changed: true });
    expect(removed()).toEqual(["auth remove openrouter e-1"]);
  });

  it("never answers signed out while the pool still holds the key, or over a pool it could not read", async () => {
    box.hermesRemoveWorks = false;
    expect(await signOutOfProvider("openrouter")).toMatchObject({ ok: false, kind: "still_signed_in", error: expect.stringMatching(/removed from Hermes' auth store/) });
    box.hermesRemoveWorks = true;
    fs.writeFileSync(path.join(HERMES_DIR, "auth.json"), "{ not json");
    expect(await signOutOfProvider("openrouter")).toMatchObject({ ok: false, kind: "still_signed_in", error: expect.stringMatching(/checked in Hermes' auth store/) });
  });

  it("never answers signed out while config.yaml still holds the ClawBox AI key", async () => {
    hermesYaml.patchHermesConfig.mockRejectedValueOnce(new Error("Failed to update the Hermes config"));
    expect(await signOutOfProvider("clawai")).toMatchObject({ ok: false, kind: "still_signed_in", error: expect.stringMatching(/removed from Hermes' config.yaml/) });
  });

  it("follows a restart that is still coming up, and says so when it was refused", async () => {
    box.bounce = "pending";
    expect(await signOutOfProvider("openrouter")).toEqual({ ok: true, changed: true, gatewayRestarting: true });
    hermesBox();
    box.bounce = "failed";
    expect(await signOutOfProvider("gemini")).toMatchObject({ ok: false, kind: "restart_refused" });
    expect(readAuth().credential_pool.gemini).toEqual([]);
  });

  it("restarts nothing when there was nothing to sign out of", async () => {
    expect(await signOutOfProvider("zai")).toEqual({ ok: true, changed: false, gatewayRestarting: false });
    expect(bounce.bounceHermesDashboardShared).not.toHaveBeenCalled();
  });
});

describe("signOutOfProvider — a dual box", () => {
  it("running OpenClaw: ClawBox AI out of Hermes' config too, which is not restarted", async () => {
    hermesBox();
    box.harness = "openclaw";
    box.edition = "dual";
    box.config = signedInConfig();
    box.gatewayStore = { "deepseek:default": { provider: "deepseek", type: "api_key" } };
    expect(await signOutOfProvider("clawai")).toEqual({ ok: true, changed: true, gatewayRestarting: false });
    expect(cli.spawnOpenclawCli).toHaveBeenCalledTimes(1);
    expect(box.hermesConfig).not.toHaveProperty("providers.clawai.api_key");
    expect(box.hermesEnv).not.toHaveProperty("CLAWBOX_AI_TOKEN");
    expect(gateway.awaitGatewayHotApply).toHaveBeenCalledTimes(1);
    expect(bounce.bounceHermesDashboardShared).not.toHaveBeenCalled();
  });

  it("running Hermes: ClawBox AI out of openclaw.json too, the gateway not restarted", async () => {
    hermesBox();
    box.edition = "dual";
    box.config = signedInConfig();
    box.gatewayStore = { "deepseek:default": { provider: "deepseek", type: "api_key" } };
    expect(await signOutOfProvider("clawai")).toMatchObject({ ok: true, changed: true });
    expect(cli.spawnOpenclawCli).toHaveBeenCalledWith(["models", "auth", "logout", "deepseek:default", "--yes"], expect.anything());
    expect(box.config).toMatchObject({ models: { providers: { deepseek: { baseUrl: "https://proxy" } } } });
    expect((box.config.models as { providers: { deepseek: Record<string, unknown> } }).providers.deepseek).not.toHaveProperty("apiKey");
    expect(gateway.awaitGatewayHotApply).not.toHaveBeenCalled();
    expect(bounce.bounceHermesDashboardShared).toHaveBeenCalledTimes(1);
  });

  it("any other provider: the active harness's own sign-in only", async () => {
    hermesBox();
    box.edition = "dual";
    box.config = everyProviderConfig();
    box.gatewayStore = everyProviderStore();
    expect(await signOutOfProvider("openrouter")).toMatchObject({ ok: true });
    expect(readAuth().credential_pool.openrouter).toEqual([]);
    expect(cli.spawnOpenclawCli).not.toHaveBeenCalled();
    expect(box.gatewayStore).toHaveProperty("openrouter:default");
  });
});
