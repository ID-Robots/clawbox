import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import * as childProcess from "child_process";
import fsp from "fs/promises";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { getProviderCatalog } from "@/lib/provider-models";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    chown: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(),
    rm: vi.fn(),
    unlink: vi.fn(),
  },
}));

const readSetupGateFacts = vi.fn<() => { setupComplete: boolean; passwordConfigured: boolean }>();

// PARTIAL mock — only the setup-gate read is replaceable. The configure route
// asks it whether the first-run wizard is still driving the box, which decides
// whether step 9 waits for the gateway to bind; everything else in route-auth
// (session checks other modules in this graph import) keeps its real behaviour.
vi.mock("@/lib/route-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/route-auth")>("@/lib/route-auth");
  return { ...actual, readSetupGateFacts: () => readSetupGateFacts() };
});

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/home/clawbox/clawbox/data",
  getAll: vi.fn(),
  setMany: vi.fn(),
}));

vi.mock("@/lib/clawkeep", () => ({
  unpairLocal: vi.fn(),
}));

// Connecting a provider re-enables it. The switch itself is exercised by the
// providers/enabled route tests; here only the call matters.
vi.mock("@/lib/provider-enablement", () => ({
  getDisabledProviders: async () => new Set<string>(),
  setProviderEnabled: vi.fn(async () => ({ ok: true })),
}));

// The configure route fires a catalog refresh out-of-band and deliberately does
// NOT await it (step 8c). The real refreshInBackground starts a fetch/openclaw
// fork and logs its outcome — `[catalog] refreshed …` or `[catalog] refresh
// failed for …` — whenever it settles, which is after the test that triggered
// it has already finished.
//
// That stray console write is what surfaced in CI as
// `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`:
// a log arriving while the worker was closing its RPC channel. The job reported
// every one of its test files as passing and still exited 1 on the unhandled
// rejection.
//
// Stubbing it here keeps the leak from ever starting, which is the fix — no
// console silencing and no global unhandled-rejection swallow, either of which
// would hide this class of bug rather than remove it. Nothing in this file
// asserts on the refresh; it is out-of-band work by design.
vi.mock("@/app/setup-api/ai-models/catalog/route", () => ({
  refreshInBackground: vi.fn(),
  notifyProviderSetChanged: vi.fn(),
}));

// Hoisted so the vi.mock factories below (which are themselves hoisted by
// vitest) can see these. A plain const declaration at file-body position
// would be in the TDZ when the mock factory evaluates.
const { parseFullyQualifiedModelImpl, LLAMACPP_PROXY_BASE_URL } = vi.hoisted(() => ({
  // Mirror real `parseFullyQualifiedModel` byte-for-byte — a sloppier
  // split-on-"/" mock would accept "foo/" where the real impl rejects it,
  // masking real regressions. Inlined to avoid `vi.importActual` which
  // would pull in openclaw-config's side-effectful init.
  parseFullyQualifiedModelImpl(fq: string) {
    const idx = fq.indexOf("/");
    if (idx <= 0 || idx === fq.length - 1) return null;
    return { provider: fq.slice(0, idx), modelId: fq.slice(idx + 1) };
  },
  LLAMACPP_PROXY_BASE_URL: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
}));

vi.mock("@/lib/openclaw-config", () => ({
  DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR: 24000,
  // Pure helper — mirror the real implementation (unit-tested in
  // openclaw-config.test.ts) so the configure route computes a real reserve.
  compactionReserveFloorForContext: (contextWindow: number) =>
    Number.isFinite(contextWindow) && contextWindow > 0
      ? Math.min(24000, Math.max(4096, Math.round(contextWindow / 4)))
      : 24000,
  restartGateway: vi.fn(),
  // A REAL class, not `vi.fn()` and not an omitted export: the route narrows on
  // `instanceof GatewayNotReadyError`, and `instanceof undefined` throws a
  // TypeError the first time a test makes the restart reject.
  GatewayNotReadyError: class GatewayNotReadyError extends Error {
    constructor(message = "gateway did not come back") {
      super(message);
      this.name = "GatewayNotReadyError";
    }
  },
  findOpenclawBin: vi.fn().mockReturnValue("/usr/local/bin/openclaw"),
  readConfig: vi.fn(),
  readConfigStrict: vi.fn(),
  setPrimaryModelWithoutCatalogValidation: vi.fn().mockResolvedValue(undefined),
  inferConfiguredLocalModel: vi.fn(),
  runOpenclawConfigSet: vi.fn(),
  runOpenclawDoctorFix: vi.fn().mockResolvedValue(undefined),
  spawnOpenclawCli: vi.fn().mockResolvedValue(""),
  writeConfig: vi.fn().mockResolvedValue(undefined),
  runOpenclawConfigSetBatch: vi.fn(),
  runOpenclawConfigUnset: vi.fn(),
  // Added by PR #83 — the configure route sweeps agent sessions so the
  // new primary provider takes effect on the open chat without a reset.
  applyModelOverrideToAllAgentSessions: vi.fn().mockResolvedValue(undefined),
  parseFullyQualifiedModel: vi.fn(parseFullyQualifiedModelImpl),
  // Plugin gating: the route switches the plugin the new primary needs ON
  // before the batch that writes `agents.defaults.model.primary` and gates
  // the rest OFF after it. "the anthropic plugin around the primary write"
  // asserts on both halves; every other test only needs the imports to resolve.
  setProviderPlugins: vi.fn().mockResolvedValue(undefined),
  // Edition guard: these tests exercise the OpenClaw path, so openclaw is
  // present. The Hermes branch (openclawIsAbsent → true) is covered separately
  // in configure-hermes.test.ts.
  openclawIsAbsent: vi.fn().mockReturnValue(false),
  OpenclawUnavailableError: class OpenclawUnavailableError extends Error {},
}));

// llamacpp / local-ai-runtime have pure getters, but local-ai-runtime
// transitively imports `@/instrumentation-node` (which starts a server).
// Mock both to keep tests hermetic.
vi.mock("@/lib/llamacpp", () => ({
  getDefaultLlamaCppModel: vi.fn().mockReturnValue("gemma4-e2b-it-q4_0"),
  getLlamaCppContextWindow: vi.fn().mockReturnValue(131072),
  // Real impl defaults to `getLlamaCppContextWindow()` when the env var is unset.
  getLlamaCppMaxTokens: vi.fn().mockReturnValue(131072),
  getLlamaCppProxyBaseUrl: vi.fn().mockReturnValue(LLAMACPP_PROXY_BASE_URL),
}));

vi.mock("@/lib/local-ai-runtime", () => ({
  getLocalAiProxyBaseUrl: vi.fn((provider: string) =>
    provider === "llamacpp"
      ? LLAMACPP_PROXY_BASE_URL
      : `http://127.0.0.1/setup-api/local-ai/${provider}`,
  ),
  // The save-time model probe (ollama-model-context) builds its /api/show URL
  // from this; without it the probe throws before fetching and every save
  // fails open as "unreachable", so the refusal tests would test nothing.
  getOllamaBaseUrl: vi.fn(() => "http://127.0.0.1:11434"),
}));

vi.mock("@/lib/local-ai-token", () => ({
  // Stable 64-char hex value so tests can assert on shape without depending
  // on filesystem state. Real impl reads/writes data/.local-ai-token.
  getLocalAiToken: vi.fn().mockReturnValue("a".repeat(64)),
  verifyLocalAiBearer: vi.fn().mockReturnValue(true),
  // Configure route calls this on every Ollama/llama.cpp save to stamp
  // the legacy-sentinel sunset flag — no-op in tests.
  markLocalAiTokenMigrated: vi.fn(),
}));

import { getAll, setMany } from "@/lib/config-store";
import { unpairLocal } from "@/lib/clawkeep";
import { inferConfiguredLocalModel, readConfig, readConfigStrict, restartGateway, runOpenclawConfigSet, runOpenclawConfigSetBatch, runOpenclawConfigUnset, applyModelOverrideToAllAgentSessions, parseFullyQualifiedModel,
  setPrimaryModelWithoutCatalogValidation,
  runOpenclawDoctorFix,
  spawnOpenclawCli,
  setProviderPlugins,
  GatewayNotReadyError,
} from "@/lib/openclaw-config";
import { configSetCalls, configSetCommands, failConfigSetsMatching, findConfigSet } from "./config-set-calls";
import { getDefaultLlamaCppModel, getLlamaCppContextWindow, getLlamaCppMaxTokens, getLlamaCppProxyBaseUrl } from "@/lib/llamacpp";
import { getLocalAiProxyBaseUrl } from "@/lib/local-ai-runtime";
import { getLocalAiToken } from "@/lib/local-ai-token";
import { notifyProviderSetChanged } from "@/app/setup-api/ai-models/catalog/route";

const mockSpawn = vi.mocked(childProcess.spawn);
const mockGetAll = vi.mocked(getAll);
const mockSetMany = vi.mocked(setMany);
const mockInferConfiguredLocalModel = vi.mocked(inferConfiguredLocalModel);
const mockReadOpenClawConfig = vi.mocked(readConfig);
const mockReadOpenClawConfigStrict = vi.mocked(readConfigStrict);
const mockRestartGateway = vi.mocked(restartGateway);
const mockFs = vi.mocked(fsp);
const mockApplyModelOverrideToAllAgentSessions = vi.mocked(applyModelOverrideToAllAgentSessions);
const mockParseFullyQualifiedModel = vi.mocked(parseFullyQualifiedModel);
const mockGetDefaultLlamaCppModel = vi.mocked(getDefaultLlamaCppModel);
const mockGetLlamaCppContextWindow = vi.mocked(getLlamaCppContextWindow);
const mockGetLlamaCppMaxTokens = vi.mocked(getLlamaCppMaxTokens);
const mockGetLlamaCppProxyBaseUrl = vi.mocked(getLlamaCppProxyBaseUrl);
const mockGetLocalAiProxyBaseUrl = vi.mocked(getLocalAiProxyBaseUrl);
const mockGetLocalAiToken = vi.mocked(getLocalAiToken);
const mockUnpairLocal = vi.mocked(unpairLocal);

// Create a mock child process that immediately succeeds
function createSuccessfulChildProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  emitter.stdin = { end: vi.fn() } as unknown as ChildProcess["stdin"];
  emitter.stdout = new EventEmitter() as unknown as ChildProcess["stdout"];
  emitter.stderr = new EventEmitter() as unknown as ChildProcess["stderr"];
  emitter.kill = vi.fn();

  // Use queueMicrotask for reliable immediate execution
  queueMicrotask(() => {
    emitter.emit("close", 0);
  });

  return emitter;
}

function createFailingChildProcess(errorMessage: string): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  emitter.stdin = { end: vi.fn() } as unknown as ChildProcess["stdin"];
  emitter.stdout = new EventEmitter() as unknown as ChildProcess["stdout"];
  emitter.stderr = new EventEmitter() as unknown as ChildProcess["stderr"];
  emitter.kill = vi.fn();

  queueMicrotask(() => {
    emitter.stderr?.emit("data", Buffer.from(errorMessage));
    emitter.emit("close", 1);
  });

  return emitter;
}

/**
 * The `models auth paste-api-key` call that stored a credential: args carry
 * provider + profile id (never the secret), the secret rides stdinData.
 */
function pasteCallFor(profileId: string) {
  return vi.mocked(spawnOpenclawCli).mock.calls.find(
    (call) => Array.isArray(call[0]) && call[0].includes("paste-api-key") && call[0].includes(profileId),
  );
}

function pasteStdin(profileId: string): string {
  return (pasteCallFor(profileId)?.[1] as { stdinData?: string } | undefined)?.stdinData ?? "";
}

describe("POST /setup-api/ai-models/configure", () => {
  let configurePost: (req: Request) => Promise<Response>;

  function jsonRequest(body: unknown): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockFs.readFile.mockResolvedValue(JSON.stringify({ version: 1, profiles: {} }));
    mockFs.writeFile.mockResolvedValue();
    mockFs.rename.mockResolvedValue();
    mockFs.chown.mockResolvedValue();
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.readdir.mockResolvedValue([]);
    mockFs.rm.mockResolvedValue(undefined);
    mockFs.unlink.mockResolvedValue(undefined);
    mockGetAll.mockResolvedValue({});
    // A provisioned box, past the wizard: that is the shape every case here
    // means, and it is the one where step 9 waits for the gateway to come back.
    readSetupGateFacts.mockReturnValue({ setupComplete: true, passwordConfigured: true });
    mockReadOpenClawConfig.mockResolvedValue({});
    mockReadOpenClawConfigStrict.mockResolvedValue({});
    mockInferConfiguredLocalModel.mockReturnValue(null);
    mockSetMany.mockResolvedValue();
    mockRestartGateway.mockResolvedValue();
    mockSpawn.mockImplementation(() => createSuccessfulChildProcess());
    vi.mocked(runOpenclawConfigSet).mockResolvedValue(undefined);
    vi.mocked(runOpenclawConfigSetBatch).mockResolvedValue(undefined);
    vi.mocked(runOpenclawConfigUnset).mockResolvedValue(undefined);
    mockUnpairLocal.mockResolvedValue(undefined);
    vi.mocked(setPrimaryModelWithoutCatalogValidation).mockResolvedValue(undefined);
    vi.mocked(setProviderPlugins).mockResolvedValue(null);

    // Re-apply implementations cleared by vi.clearAllMocks above. Factory
    // defaults set in `vi.mock(...)` hold across vi.resetModules but are
    // wiped by mockClear call history cleanup, so we seed them per-test.
    mockApplyModelOverrideToAllAgentSessions.mockResolvedValue({ filesUpdated: 0, sessionsUpdated: 0, sessionsSkipped: 0 });
    mockParseFullyQualifiedModel.mockImplementation(parseFullyQualifiedModelImpl);
    mockGetDefaultLlamaCppModel.mockReturnValue("gemma4-e2b-it-q4_0");
    mockGetLlamaCppContextWindow.mockReturnValue(131072);
    mockGetLlamaCppMaxTokens.mockReturnValue(131072);
    mockGetLlamaCppProxyBaseUrl.mockReturnValue(LLAMACPP_PROXY_BASE_URL);
    mockGetLocalAiProxyBaseUrl.mockImplementation((provider) =>
      provider === "llamacpp"
        ? LLAMACPP_PROXY_BASE_URL
        : `http://127.0.0.1/setup-api/local-ai/${provider}`,
    );
    mockGetLocalAiToken.mockReturnValue("a".repeat(64));

    // The codex entitlement probe talks to chatgpt.com. Stub it by default so
    // no test reaches the network; individual tests override with the verdict
    // they need.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));

    const mod = await import("@/app/setup-api/ai-models/configure/route");
    configurePost = mod.POST;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await configurePost(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid JSON");
  });

  it("returns 400 for missing provider", async () => {
    const res = await configurePost(jsonRequest({ apiKey: "test" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("Provider is required");
  });

  it("returns 400 for missing API key on non-Ollama provider", async () => {
    const res = await configurePost(jsonRequest({ provider: "anthropic" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("API key required");
  });

  it("returns 400 for unknown provider", async () => {
    const res = await configurePost(jsonRequest({
      provider: "unknown-provider",
      apiKey: "test",
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("Unknown provider");
  });

  it("configures anthropic provider successfully", async () => {
    const res = await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-test-key",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockSetMany).toHaveBeenCalledWith(
      expect.objectContaining({
        ai_model_configured: true,
        ai_model_provider: "anthropic",
      })
    );
  });

  // The one thing this file DOES assert about the out-of-band refresh (see the
  // mock's note above): that step 8c COUNTS the change server-side. It runs one
  // statement after the plugin is switched on and the credential written, i.e.
  // at the moment a provider that could not enumerate starts being able to, and
  // it is the only thing that can count it — a client's `?refresh=1` is a nudge
  // and deliberately bumps nothing. A write that forgets this call leaves its
  // change invisible to the catalogue until the 6h refresh.
  it("counts the provider-set change server-side", async () => {
    await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-test-key" }));

    expect(vi.mocked(notifyProviderSetChanged)).toHaveBeenCalledWith("anthropic");
  });

  it("configures openai provider", async () => {
    const res = await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "sk-openai-key",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands).toContain("config set agents.defaults.model.primary openai/gpt-5.4");
  });

  // A save that carries no `model` lands on the PROVIDERS table's cold start,
  // and that table is hand-maintained beside three other lists of the same
  // ids. It had already drifted: openai's entry was `openai/gpt-5`, an id
  // neither OPENAI_MODELS nor any live enumeration on the pinned core (2026.8.1)
  // carries — it exists only as an OpenRouter slug. The CLI refuses that
  // reference against the enabled plugins' catalogs, the route falls through to
  // setPrimaryModelWithoutCatalogValidation and answers 200, and nothing
  // surfaces it until the owner's first turn fails. The picker never offers it,
  // so there is no second chance to notice.
  //
  // Driven through the route rather than pinned against a copy of the table:
  // PROVIDERS is module-private, and what matters is the id the box is actually
  // left on.
  //
  // What this still catches, precisely: a cold start the provider's own picker
  // list does not carry. It cannot constrain WHICH curated id is chosen — a
  // cold start of `gpt-5.5-pro` would sail through — and for the three
  // providers whose two tables now resolve from one exported symbol the
  // `defaultModelId` half is structurally true. It stays because it is the half
  // that fails the day a table is edited back to a hand-written id.
  //
  // clawai is excluded on purpose: its refs are `deepseek/…`, so the provider
  // assertion below could not hold, and its ids come from
  // CLAWBOX_AI_*_MODEL_ID, which a deploy-time env var can move.
  describe("cold-start defaults", () => {
    const coldStarts: ReadonlyArray<{ provider: string; apiKey: string }> = [
      { provider: "anthropic", apiKey: "sk-ant-test" },
      { provider: "openai", apiKey: "sk-openai-test" },
      { provider: "google", apiKey: "AIza-test" },
      { provider: "openrouter", apiKey: "sk-or-test" },
    ];

    it.each(coldStarts)(
      "$provider lands on a model its curated catalogue carries",
      async ({ provider, apiKey }) => {
        const res = await configurePost(jsonRequest({ provider, apiKey }));
        // A route that writes the primary and then refuses would otherwise pass
        // here: the assertions below only read the recorded `config set` calls.
        expect(res.status).toBe(200);

        const commands = configSetCommands(
          vi.mocked(runOpenclawConfigSet),
          vi.mocked(runOpenclawConfigSetBatch),
        );
        const primary = commands
          .map((c) => /^config set agents\.defaults\.model\.primary (.+)$/.exec(c)?.[1])
          .filter((v): v is string => Boolean(v))
          .at(-1);
        expect(primary).toBeDefined();

        const parsed = parseFullyQualifiedModelImpl(primary!);
        expect(parsed).not.toBeNull();
        expect(parsed!.provider).toBe(provider);

        const catalog = getProviderCatalog(provider);
        expect(catalog).not.toBeNull();
        // Both halves matter: the id has to be renderable by the picker, and
        // the two tables have to agree on which id is the cold start.
        expect(catalog!.models.map((m) => m.id)).toContain(parsed!.modelId);
        expect(catalog!.defaultModelId).toBe(parsed!.modelId);
      },
    );
  });

  it("refuses an unknown authMode before any write", async () => {
    const res = await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-test",
      authMode: "yolo",
    }));
    expect(res.status).toBe(400);
    expect(vi.mocked(spawnOpenclawCli)).not.toHaveBeenCalled();
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it("accepts authMode 'local' (the Ollama hook's spelling)", async () => {
    const res = await configurePost(jsonRequest({
      provider: "ollama",
      apiKey: "mistral:7b",
      authMode: "local",
    }));
    expect(res.status).toBe(200);
  });

  it("returns 400 for ClawBox AI when no token is provided or stored", async () => {
    const res = await configurePost(jsonRequest({
      provider: "clawai",
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("ClawBox AI token is required");
  });

  it("uses a user-supplied ClawBox AI token when provided", async () => {
    const res = await configurePost(jsonRequest({
      provider: "clawai",
      apiKey: "portal-token-123",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const paste = pasteCallFor("deepseek:default");
    expect(paste?.[0]).toEqual(expect.arrayContaining(["--provider", "deepseek"]));
    expect(pasteStdin("deepseek:default")).toContain("portal-token-123");

    const providerCall = findConfigSet(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch), "models.providers.deepseek");
    const providerDef = providerCall ? JSON.parse(providerCall.value || "{}") : {};
    expect(providerDef.apiKey).toBe("portal-token-123");
    expect(providerDef.baseUrl).toBe("https://clawbox.com/api/ai");
    expect(providerDef.models[0].compat.supportedReasoningEfforts).toEqual(["off", "high", "xhigh"]);
    expect(providerDef.models[1].compat.supportedReasoningEfforts).toEqual(["off", "high", "xhigh"]);

    // A configured provider overrides OpenClaw's bundled catalog, so these
    // three fields have to be stated on every CHAT model. Omit contextWindow
    // and the gateway falls back to a generic 200,000 rather than V4's real 1M
    // — reproduced on a device running 2026.7.1 on 2026-08-17.
    //
    // Scoped to the two V4 tiers on purpose: the same provider also carries the
    // vision entry (TASK-417), which is deliberately text+image with its own
    // measured ceiling and is never a session model. Asserting over every row
    // would make this test fail on a correct config.
    const chatTiers = providerDef.models.filter(
      (m: { id: string }) => m.id === "deepseek-v4-flash" || m.id === "deepseek-v4-pro",
    );
    expect(chatTiers).toHaveLength(2);
    for (const model of chatTiers) {
      expect(model.contextWindow).toBe(1_000_000);
      expect(model.maxTokens).toBe(393_216);
      expect(model.input).toEqual(["text"]);
    }

    expect(mockSetMany).toHaveBeenCalledWith(
      expect.objectContaining({
        clawai_token: "portal-token-123",
      }),
    );
  });

  it("unpairs ClawKeep when the ClawBox AI account (token) changes", async () => {
    // A token for a *different* account was already stored.
    mockGetAll.mockResolvedValue({ clawai_token: "claw_OLD", ai_model_provider: "deepseek" });

    const res = await configurePost(jsonRequest({
      provider: "clawai",
      apiKey: "claw_NEW",
    }));

    expect(res.status).toBe(200);
    // ClawKeep is bound to its own token/account, so switching accounts must
    // unpair it (else backups keep going to the old account's storage), and
    // clear the old account's stats so they don't linger on the new account.
    expect(mockUnpairLocal).toHaveBeenCalledTimes(1);
    expect(mockUnpairLocal).toHaveBeenCalledWith({ clearStats: true });
  });

  it("does not unpair ClawKeep when the ClawBox AI token is unchanged", async () => {
    mockGetAll.mockResolvedValue({ clawai_token: "claw_SAME", ai_model_provider: "deepseek" });

    const res = await configurePost(jsonRequest({
      provider: "clawai",
      apiKey: "claw_SAME",
    }));

    expect(res.status).toBe(200);
    expect(mockUnpairLocal).not.toHaveBeenCalled();
  });

  it("does not unpair ClawKeep on first-time ClawBox AI setup (no previous token)", async () => {
    // getAll default ({}) — no prior clawai_token, so nothing to reset.
    const res = await configurePost(jsonRequest({
      provider: "clawai",
      apiKey: "claw_NEW",
    }));

    expect(res.status).toBe(200);
    expect(mockUnpairLocal).not.toHaveBeenCalled();
  });

  it("configures ollama without apiKey", async () => {
    const res = await configurePost(jsonRequest({
      provider: "ollama",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("configures ollama with model name", async () => {
    const res = await configurePost(jsonRequest({
      provider: "ollama",
      apiKey: "llama3.2:3b",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    // Ollama's 32K window gets a context-scaled reserve (32768/4 = 8192), not
    // the flat 24000 default — a 24000 floor leaves too little usable input for
    // the agent's system prompt + tools, so every turn overflows before the
    // model runs.
    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    // OpenClaw 2 retired the reserve-tuning keys (compaction.mode owns this
    // now); the route must not write one for ANY provider, small-window
    // local models included.
    expect(commands.some((c) => c.includes("reserveTokensFloor"))).toBe(false);
  });

  it("honours the model FIELD for Ollama when the apiKey slot is empty", async () => {
    // The wizard sends the id through `apiKey`; every cloud provider sends its
    // pick through `model`. An API caller who wrote { model: "qwen3:8b" } used
    // to have the field silently ignored and llama3.2:3b saved in its place —
    // a "success" that configured a model the box does not have (TASK-448).
    const res = await configurePost(jsonRequest({
      provider: "ollama",
      model: "qwen3:8b",
    }));

    expect(res.status).toBe(200);
    const providerCall = findConfigSet(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch), "models.providers.ollama");
    const providerDef = providerCall ? JSON.parse(providerCall.value || "{}") : {};
    expect(providerDef?.models?.[0]?.id).toBe("qwen3:8b");
  });

  it("refuses an Ollama id the device does not have", async () => {
    // Save-time honesty: Ollama is up and says the model is absent, so the
    // route must say it NOW instead of letting the first chat turn 404.
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "model 'ghost:7b' not found" }), { status: 404 }),
    ));

    const res = await configurePost(jsonRequest({
      provider: "ollama",
      apiKey: "ghost:7b",
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(String(body.error)).toContain('"ghost:7b"');
    const providerCall = findConfigSet(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch), "models.providers.ollama");
    expect(providerCall).toBeUndefined();
  });

  it("accepts a 32K Ollama model on OpenClaw — the 64K floor is Hermes' alone", async () => {
    // OpenClaw deliberately caps the registered window at 32K for RAM (see
    // OLLAMA_CONTEXT_WINDOW); a 32K model is a fine citizen here.
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ model_info: { "qwen2.context_length": 32768 } }), { status: 200 }),
    ));

    const res = await configurePost(jsonRequest({
      provider: "ollama",
      apiKey: "qwen2.5:3b",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("configures llama.cpp without apiKey", async () => {
    const res = await configurePost(jsonRequest({
      provider: "llamacpp",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands).toContain("config set agents.defaults.model.primary llamacpp/gemma4-e2b-it-q4_0");
    expect(commands).toContain("config set gateway.auth.mode token");
    // Token must be a per-device 32-byte random hex from
    // getOrGenerateGatewayToken — never the legacy literal "clawbox"
    // (public via the open-source repo).
    const tokenCommand = commands.find((c: string) =>
      c.startsWith("config set gateway.auth.token "),
    );
    expect(tokenCommand).toMatch(/^config set gateway\.auth\.token [0-9a-f]{64}$/);
    expect(commands).not.toContain("config set gateway.auth.token clawbox");
  });

  it("preserves an externally managed gateway token when settings are saved", async () => {
    const secretRef = {
      source: "exec",
      provider: "vault",
      id: "gateway-token",
    };
    mockFs.readFile.mockImplementation(async (file) =>
      String(file).endsWith("openclaw.json")
        ? JSON.stringify({ gateway: { auth: { token: secretRef } } })
        : JSON.stringify({ version: 1, profiles: {} }),
    );

    const res = await configurePost(jsonRequest({ provider: "llamacpp" }));
    expect(res.status).toBe(200);

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands).toContain("config set gateway.auth.mode token");
    expect(commands.some((command) =>
      command.startsWith("config set gateway.auth.token "),
    )).toBe(false);
  });

  it("promotes local AI to the active default when no primary AI provider was configured", async () => {
    const res = await configurePost(jsonRequest({
      provider: "llamacpp",
      scope: "local",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockSetMany).toHaveBeenCalledWith(
      expect.objectContaining({
        local_ai_configured: true,
        local_ai_provider: "llamacpp",
        local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
      }),
    );

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands).toContain("config set agents.defaults.model.primary llamacpp/gemma4-e2b-it-q4_0");
    expect(commands).not.toContain('config set agents.defaults.model.fallbacks ["llamacpp/gemma4-e2b-it-q4_0"] --json');
    expect(commands).toContain("config set models.mode merge");
  });

  it("keeps local AI as fallback-only when a primary AI provider is already configured", async () => {
    mockGetAll.mockResolvedValue({
      ai_model_configured: true,
      ai_model_provider: "openai",
    });

    const res = await configurePost(jsonRequest({
      provider: "llamacpp",
      scope: "local",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands).not.toContain("config set agents.defaults.model.primary llamacpp/gemma4-e2b-it-q4_0");
    expect(commands).toContain('config set agents.defaults.model.fallbacks ["llamacpp/gemma4-e2b-it-q4_0"] --json');
    expect(commands).toContain("config set models.mode merge");
  });

  it("configures subscription auth mode for oauth", async () => {
    const res = await configurePost(jsonRequest({
      provider: "openai",
      // Codex subscription credentials must be JWT-shaped (3 dot-segments) —
      // the configure route rejects non-JWT tokens to avoid recreating the
      // "invalid ID token format" failure.
      apiKey: "access.token.jwt",
      idToken: "id.token.jwt",
      authMode: "subscription",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    // OpenClaw 2: the subscription is an openai-provider OAuth profile under
    // its own key, the model is `openai/<id>` with the Codex runtime armed on
    // it, and the core is asked to prefer the sign-in over the API-key
    // profile the same provider carries for the ClawBox AI image token.
    expect(commands).toContain("config set agents.defaults.model.primary openai/gpt-5.5");
    expect(commands).toContain('config set agents.defaults.models["openai/gpt-5.5"].agentRuntime.id codex');
    expect(commands).toContain('config set auth.profiles.openai:chatgpt {"provider":"openai","mode":"oauth"} --json');
    expect(commands.some((c) => c.includes("codex/"))).toBe(false);
    const written = JSON.parse(mockFs.writeFile.mock.calls.at(-1)?.[1] as string);
    expect(written.profiles["openai:chatgpt"]).toEqual(expect.objectContaining({ type: "oauth", provider: "openai" }));
    expect(written.profiles["codex:default"]).toBeUndefined();
    // One openai profile on this box, so there is nothing to disambiguate and
    // an explicit order would only hide the credential the owner adds next —
    // the core already selects a usable profile over the
    // `models.providers.openai.apiKey` fallback. And no `clear` either: ClawBox
    // has never written an order on this box, so the clear would be a CLI cold
    // start (~10 s on a Jetson, on the wizard's critical path) against a store
    // that has none.
    expect(vi.mocked(spawnOpenclawCli).mock.calls.some(
      ([args]) => Array.isArray(args) && args[2] === "order",
    )).toBe(false);
  });

  it("clears an order ClawBox itself wrote once the box is down to one profile", async () => {
    // The fail-safe half: the marker says there IS something of ours to clear,
    // so the spawn is worth its cold start. Without the marker the same box
    // costs nothing.
    mockGetAll.mockResolvedValue({ openai_auth_order_written: true } as never);

    await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "access.token.jwt",
      idToken: "id.token.jwt",
      authMode: "subscription",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    }));

    expect(vi.mocked(spawnOpenclawCli)).toHaveBeenCalledWith(
      ["models", "auth", "order", "clear", "--agent", "main", "--provider", "openai"],
      expect.anything(),
    );
  });

  // The order write and the credential write must address the SAME agent
  // store. `models auth order` resolves its own target when `--agent` is
  // omitted (resolveSoleAgentId), which throws on a box with more than one
  // configured agent and otherwise resolves whichever sole agent is declared
  // — not necessarily `main`, the directory the credential was written into.
  it("addresses the same agent store the credential was written to", async () => {
    // Two openai profiles, so an order IS written — and it must name the agent
    // whose store the credential went to.
    mockReadOpenClawConfig.mockResolvedValue({
      auth: { profiles: { "openai:default": { provider: "openai", mode: "api_key" } } },
    } as never);

    await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "access.token.jwt",
      idToken: "id.token.jwt",
      authMode: "subscription",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    }));

    const orderCall = vi.mocked(spawnOpenclawCli).mock.calls.find(
      ([args]) => Array.isArray(args) && args[2] === "order",
    );
    expect(orderCall?.[0]).toEqual(expect.arrayContaining(["--agent", "main"]));
  });

  it("names both OpenAI profiles, the sign-in first, when the box holds an API key too", async () => {
    // An explicit order REPLACES the core's candidate list rather than
    // reordering it, so a one-entry order written here made a later
    // `openai:default` invisible — the turn kept going to the ChatGPT account
    // and 400d on the API-only models the owner switched modes to reach.
    mockReadOpenClawConfig.mockResolvedValue({
      auth: { profiles: { "openai:default": { provider: "openai", mode: "api_key" } } },
    } as never);

    await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "access.token.jwt",
      idToken: "id.token.jwt",
      authMode: "subscription",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    }));

    expect(vi.mocked(spawnOpenclawCli)).toHaveBeenCalledWith(
      ["models", "auth", "order", "set", "--agent", "main", "--provider", "openai",
        "openai:chatgpt", "openai:default"],
      expect.anything(),
    );
  });

  it("revises the preference to the API key when THAT is the save", async () => {
    // The owner switches OpenAI to API-key mode to reach gpt-5.4-pro. Nothing
    // used to revisit the order, so the core still picked the sign-in.
    mockReadOpenClawConfig.mockResolvedValue({
      auth: { profiles: { "openai:chatgpt": { provider: "openai", mode: "oauth" } } },
    } as never);

    await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "sk-openai-key",
    }));

    expect(vi.mocked(spawnOpenclawCli)).toHaveBeenCalledWith(
      ["models", "auth", "order", "set", "--agent", "main", "--provider", "openai",
        "openai:default", "openai:chatgpt"],
      expect.anything(),
    );
  });

  it("refuses a ClawBox AI key offered as another provider's API key", async () => {
    // A `claw_…` key authenticates to the ClawBox AI proxy and nowhere else.
    // Registered as the OpenAI api_key profile it becomes that provider's
    // bearer: measured on a box, `openai:default` held one and every turn on
    // `openai/gpt-5.5` went to https://api.openai.com/v1/responses and came
    // back `401 … Incorrect API key provided: claw_***`. Worse, an eligible
    // api_key profile shadows the owner's working ChatGPT sign-in on the same
    // provider, so the box answers on a silent fallback instead.
    const res = await configurePost(jsonRequest({ provider: "openai", apiKey: "claw_token_abc" }));

    expect(res.status).toBe(400);
    expect(pasteCallFor("openai:default")).toBeUndefined();
  });

  it("leaves the order alone for a provider that is not OpenAI", async () => {
    await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-ant" }));

    expect(vi.mocked(spawnOpenclawCli).mock.calls.some(
      ([args]) => Array.isArray(args) && args[2] === "order",
    )).toBe(false);
  });

  // The other door onto the write-only arm: the owner signs in with ChatGPT,
  // later switches OpenAI to API-key mode and saves the SAME model. Nothing
  // used to remove the arm, so Settings said "Configured" while every turn kept
  // going to the ChatGPT account — and once the sign-in is removed, the
  // app-server has no credential and every turn dies on the Cloudflare
  // challenge with no ClawBox surface that can undo it.
  it("clears the Codex runtime arm on an OpenAI API-key save", async () => {
    mockReadOpenClawConfig.mockResolvedValue({
      auth: { profiles: { "openai:chatgpt": { provider: "openai", mode: "oauth" } } },
      agents: {
        defaults: { models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } } },
      },
    } as never);

    const res = await configurePost(jsonRequest({ provider: "openai", apiKey: "sk-openai-key" }));

    expect(res.status).toBe(200);
    expect(vi.mocked(runOpenclawConfigUnset)).toHaveBeenCalledWith(
      'agents.defaults.models["openai/gpt-5.4"].agentRuntime',
      expect.anything(),
    );
  });

  it("costs no spawn when there is no arm to clear", async () => {
    await configurePost(jsonRequest({ provider: "openai", apiKey: "sk-openai-key" }));

    expect(vi.mocked(runOpenclawConfigUnset)).not.toHaveBeenCalled();
  });

  it("says the box is still on the subscription when the disarm fails", async () => {
    // A clean 200 over a box that still routes that model to the ChatGPT
    // account is the false success this finding is about.
    mockReadOpenClawConfig.mockResolvedValue({
      auth: { profiles: { "openai:chatgpt": { provider: "openai", mode: "oauth" } } },
      agents: {
        defaults: { models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } } },
      },
    } as never);
    vi.mocked(runOpenclawConfigUnset).mockRejectedValue(new Error("unset failed"));

    const res = await configurePost(jsonRequest({ provider: "openai", apiKey: "sk-openai-key" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.warning).toMatch(/still routes openai\/gpt-5\.4 through your ChatGPT account/);
  });

  it("leaves the arm alone when the save IS the subscription", async () => {
    mockReadOpenClawConfig.mockResolvedValue({
      auth: { profiles: { "openai:chatgpt": { provider: "openai", mode: "oauth" } } },
      agents: {
        defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } },
      },
    } as never);

    await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "access.token.jwt",
      idToken: "id.token.jwt",
      authMode: "subscription",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    }));

    expect(vi.mocked(runOpenclawConfigUnset)).not.toHaveBeenCalled();
  });

  it("answers an error, not success, when the batch carrying the runtime arm is refused", async () => {
    // The arm is part of the sign-in's contract: a 200 whose box cannot route
    // a ChatGPT turn is the failure this PR exists to stop reporting as fine.
    vi.mocked(runOpenclawConfigSetBatch).mockRejectedValue(
      new Error('Config validation failed: agents.defaults.models."openai/gpt-5.5": bad'),
    );

    const res = await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "access.token.jwt",
      idToken: "id.token.jwt",
      authMode: "subscription",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    }));

    expect(res.status).not.toBe(200);
  });

  it("names a failed auth-order preference in the answer instead of hiding it", async () => {
    // The sign-in is stored either way; what the owner must not get is a
    // silent success whose chat then answers with an authentication error
    // because the image-token API-key profile won the route.
    mockReadOpenClawConfig.mockResolvedValue({
      auth: { profiles: { "openai:default": { provider: "openai", mode: "api_key" } } },
    } as never);
    vi.mocked(spawnOpenclawCli).mockImplementation(async (args) => {
      if (Array.isArray(args) && args[2] === "order") throw new Error("auth order failed");
      return "";
    });
    const res = await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "access.token.jwt",
      idToken: "id.token.jwt",
      authMode: "subscription",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.warning).toMatch(/models auth order set --agent main --provider openai/);
  });

  // A Pro account used to land on gpt-5.5 after sign-in and had to know to
  // change it. Entitlement isn't readable from any catalog (the plugin list is
  // static and identical for every account), so the route asks the account.
  it("defaults a ChatGPT sign-in to the newest model the account can use", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));

    const res = await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "access.token.jwt",
      idToken: "id.token.jwt",
      authMode: "subscription",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    }));

    expect(res.status).toBe(200);
    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands).toContain("config set agents.defaults.model.primary openai/gpt-5.6-sol");
  });

  it("leaves a non-entitled account on gpt-5.5 rather than a model that 400s", async () => {
    // Every gpt-5.6 id gated: the safe landing spot is gpt-5.5, which runs on
    // every tier including Free, not the newest id in the static catalog.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 403 })));

    const res = await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "access.token.jwt",
      idToken: "id.token.jwt",
      authMode: "subscription",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    }));

    expect(res.status).toBe(200);
    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands).toContain("config set agents.defaults.model.primary openai/gpt-5.5");
  });

  it("does not probe when the user picked a model explicitly", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "access.token.jwt",
      idToken: "id.token.jwt",
      authMode: "subscription",
      refreshToken: "refresh-token",
      expiresIn: 3600,
      // Deliberately NOT the subscription default (gpt-5.5) — otherwise this
      // assertion would pass even if the probe ran and found nothing.
      model: "gpt-5.4-mini",
    }));

    expect(res.status).toBe(200);
    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands).toContain("config set agents.defaults.model.primary openai/gpt-5.4-mini");
    const probedCodex = fetchMock.mock.calls.some(([url]) => String(url).includes("backend-api/codex/responses"));
    expect(probedCodex).toBe(false);
  });

  it("includes projectId for google oauth", async () => {
    const res = await configurePost(jsonRequest({
      provider: "google",
      apiKey: "access-token",
      authMode: "subscription",
      projectId: "my-project-id",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  /**
   * TASK-608. A gateway that has not finished coming back is NOT a failed
   * configure: the provider, the credential and the model are all on disk, and
   * `restartGateway` only stopped waiting.
   *
   * This route's 502 predates the readiness wait, when it could fire only if
   * `systemctl restart` itself failed. The wait widened it to "the port did not
   * open inside 30 s" — and `e2e-install`'s fresh-install wizard proved what
   * that costs: OpenAI configured, the gateway a few seconds late, a 502, and
   * the wizard stopped dead at the AI step with "Try rebooting the device" over
   * a box that needed ten more seconds. A restart that was REFUSED is a
   * different fact and keeps the 502 below.
   */
  it("keeps a configure that landed when only the gateway has not come back yet", async () => {
    mockRestartGateway.mockRejectedValue(new GatewayNotReadyError("gateway did not come back"));

    const res = await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-test",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.warning).toMatch(/gateway/i);
  });

  it("waits for the gateway to come back on a box past the wizard", async () => {
    // Settings renders the "has not finished restarting" notice, so there the
    // readiness answer has a reader and is worth the budget.
    const res = await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-test" }));

    expect(res.status).toBe(200);
    expect(mockRestartGateway).toHaveBeenCalledWith({ awaitReady: true });
  });

  it("does not wait for the gateway during the first-run wizard", async () => {
    // TASK-608 / M2. `setup_complete` is written at the end of the wizard, so
    // its absence is the first-run path — the one AIModelsStep discards the
    // warning on, and the one e2e-install measured at 52.9 s (23 s of writes,
    // then the whole 30 s budget, expired). Waiting there buys latency only.
    readSetupGateFacts.mockReturnValue({ setupComplete: false, passwordConfigured: true });

    const res = await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-test" }));

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mockRestartGateway).toHaveBeenCalledWith({ awaitReady: false });
  });

  it("still reports a refused restart during the first-run wizard", async () => {
    // Skipping the poll must not swallow the fact that nothing is coming: the
    // exec failure is still a 502, wizard or not.
    readSetupGateFacts.mockReturnValue({ setupComplete: false, passwordConfigured: true });
    mockRestartGateway.mockRejectedValue(new Error("Unit clawbox-gateway.service is masked."));

    const res = await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-test" }));

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("gateway failed to restart");
  });

  it("returns 502 when gateway restart fails", async () => {
    mockRestartGateway.mockRejectedValue(new Error("Gateway restart failed"));

    const res = await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-test",
    }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain("gateway failed to restart");
  });

  it("returns 500 when spawn command fails", async () => {
    // Both forms: the route sends most of its writes as one batch, so stubbing
    // only the single-set form would leave the failure it is testing unreached.
    vi.mocked(runOpenclawConfigSet).mockRejectedValue(new Error("Command failed"));
    vi.mocked(runOpenclawConfigSetBatch).mockRejectedValue(new Error("Command failed"));

    const res = await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-test",
    }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBeDefined();
  });

  it("handles missing auth profiles file", async () => {
    // A genuinely absent file (ENOENT) → treated as no profiles yet. Real fs
    // errors carry a `.code`; a message-only Error would now (correctly) be
    // treated as an unexpected read failure and fail closed.
    const enoent = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    mockFs.readFile.mockRejectedValue(enoent);

    const res = await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-test",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("writes an api_key auth profile for key-based providers", async () => {
    // Key providers must use type:"api_key" (not the legacy "token", which
    // OpenClaw 2026.6.8 no longer turns into an Authorization header).
    await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-test",
    }));

    // Stored through the CLI's own auth store (paste-api-key, key on stdin) —
    // the CLI owns the `api_key` shape on every generation.
    expect(pasteCallFor("anthropic:default")).toBeDefined();
    expect(pasteStdin("anthropic:default")).toContain("sk-test");
  });

  it("writes auth profile with the local-ai bearer for Ollama", async () => {
    await configurePost(jsonRequest({
      provider: "ollama",
      apiKey: "mistral:7b",
    }));

    // Per-install token (>=16 chars) — the proxy validates against the same
    // value via `verifyLocalAiBearer` in src/lib/local-ai-token.ts.
    expect(pasteStdin("ollama:default")).toMatch(/[a-f0-9]{32,}/);
  });

  it("writes auth profile with the local-ai bearer for llama.cpp", async () => {
    await configurePost(jsonRequest({
      provider: "llamacpp",
      apiKey: "gemma-q4",
    }));

    expect(pasteStdin("llamacpp:default")).toMatch(/[a-f0-9]{32,}/);
  });

  it("configures ClawBox AI as a fallback model when a stored user token is present", async () => {
    mockGetAll.mockResolvedValue({
      clawai_token: "stored-fallback-token",
    });

    await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-test",
    }));

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands).toContain('config set agents.defaults.model.fallbacks ["deepseek/deepseek-v4-flash"] --json');
    expect(commands.some((command) => command.includes("config set models.providers.deepseek"))).toBe(true);

    expect(pasteStdin("deepseek:default")).toContain("stored-fallback-token");
  });

  it("prefers the configured local AI model as the OpenClaw fallback", async () => {
    mockGetAll.mockResolvedValue({
      local_ai_configured: true,
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
    });

    await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "sk-openai-key",
    }));

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands).toContain('config set agents.defaults.model.fallbacks ["llamacpp/gemma4-e2b-it-q4_0"] --json');
    expect(commands.some((command) => command.includes("config set models.providers.deepseek"))).toBe(false);
  });

  it("falls back to an inferred local model from openclaw config when config-store state is missing", async () => {
    mockInferConfiguredLocalModel.mockReturnValue({
      provider: "llamacpp",
      model: "llamacpp/gemma4-e2b-it-q4_0",
    });

    await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "sk-openai-key",
    }));

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands).toContain('config set agents.defaults.model.fallbacks ["llamacpp/gemma4-e2b-it-q4_0"] --json');
  });

  it("does not use inferred local fallback when local AI is explicitly disabled", async () => {
    mockGetAll.mockResolvedValue({
      local_ai_configured: false,
    });
    mockInferConfiguredLocalModel.mockReturnValue({
      provider: "llamacpp",
      model: "llamacpp/gemma4-e2b-it-q4_0",
    });

    await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "sk-openai-key",
    }));

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands).not.toContain('config set agents.defaults.model.fallbacks ["llamacpp/gemma4-e2b-it-q4_0"] --json');
  });

  it("skips a local engine the owner switched off when picking the fallback", async () => {
    // The switch reaches the fallback slot too: a backup the gateway would
    // quietly route to when the primary fails is exactly what "switched off"
    // promises cannot happen. With nothing else to back the primary up, the
    // slot is cleared rather than left pointing at the disabled engine.
    mockGetAll.mockResolvedValue({
      local_ai_configured: true,
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
      ai_disabled_providers: ["llamacpp"],
    });

    await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "sk-openai-key",
    }));

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands).not.toContain('config set agents.defaults.model.fallbacks ["llamacpp/gemma4-e2b-it-q4_0"] --json');
    expect(commands).toContain("config set agents.defaults.model.fallbacks [] --json");
  });

  it("does not fall back to ClawBox AI when the owner switched it off", async () => {
    // Same rule for the last resort: a stored token alone used to be enough
    // to make ClawBox AI the silent backup for every other provider.
    mockGetAll.mockResolvedValue({
      clawai_token: "stored-fallback-token",
      ai_disabled_providers: ["clawai"],
    });

    await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-test",
    }));

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands).not.toContain('config set agents.defaults.model.fallbacks ["deepseek/deepseek-v4-flash"] --json');
    expect(commands).toContain("config set agents.defaults.model.fallbacks [] --json");
  });

  it("turns a switched-off provider back on when the owner connects it", async () => {
    // Re-entering a key is the owner saying "use this one". Without this the
    // save would route the chat to a provider the list still shows as off.
    const { setProviderEnabled } = await import("@/lib/provider-enablement");
    mockGetAll.mockResolvedValue({ ai_disabled_providers: ["openai"] });

    await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "sk-openai-key",
    }));

    expect(vi.mocked(setProviderEnabled)).toHaveBeenCalledWith("openai", true);
  });

  it("uses a stored ClawBox AI token when no new token is supplied", async () => {
    mockGetAll.mockResolvedValue({
      clawai_token: "stored-portal-token",
    });

    const res = await configurePost(jsonRequest({
      provider: "clawai",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const providerCall = findConfigSet(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch), "models.providers.deepseek");
    const providerDef = providerCall ? JSON.parse(providerCall.value || "{}") : {};

    expect(providerDef.baseUrl).toBe("https://clawbox.com/api/ai");
    expect(providerDef.apiKey).toBe("stored-portal-token");
  });

  it("restarts gateway after configuration", async () => {
    await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-test",
    }));

    expect(mockRestartGateway).toHaveBeenCalled();
  });

  it("configures llama.cpp provider definition in openclaw", async () => {
    await configurePost(jsonRequest({
      provider: "llamacpp",
      apiKey: "gemma-q4",
    }));

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands.some((command) => command.includes("config set models.providers.llamacpp"))).toBe(true);
    expect(commands).toContain("config set agents.defaults.model.primary llamacpp/gemma-q4");

    const providerCall = findConfigSet(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch), "models.providers.llamacpp");
    const providerDef = providerCall ? JSON.parse(providerCall.value || "{}") : {};
    const modelDef = providerDef?.models?.[0] ?? {};

    expect(providerDef.baseUrl).toBe("http://127.0.0.1/setup-api/local-ai/llamacpp/v1");
    expect(modelDef.contextWindow).toBe(131072);
    expect(modelDef.maxTokens).toBe(131072);
  });

  it("configures Ollama through the local AI proxy", async () => {
    await configurePost(jsonRequest({
      provider: "ollama",
      apiKey: "llama3.2:3b",
    }));

    const providerCall = findConfigSet(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch), "models.providers.ollama");
    const providerDef = providerCall ? JSON.parse(providerCall.value || "{}") : {};

    expect(providerDef.baseUrl).toBe("http://127.0.0.1/setup-api/local-ai/ollama");
  });

  it("configures openrouter provider definition in openclaw", async () => {
    // OpenClaw has no built-in OpenRouter adapter, so without an explicit
    // models.providers.openrouter entry the runtime short-circuits every
    // chat turn to `usage: 0/0/0` and the UI appears dead. Regression test
    // for that silent-failure bug.
    const res = await configurePost(jsonRequest({
      provider: "openrouter",
      apiKey: "sk-or-v1-test",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands.some((command) => command.includes("config set models.providers.openrouter"))).toBe(true);
    expect(commands).toContain("config set agents.defaults.model.primary openrouter/anthropic/claude-haiku-4.5");

    const providerCall = findConfigSet(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch), "models.providers.openrouter");
    const providerDef = providerCall ? JSON.parse(providerCall.value || "{}") : {};

    expect(providerDef.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(providerDef.api).toBe("openai-completions");
    // The seed includes the user's default + the small static fallback
    // list. Mid-conversation switches to slugs outside this seed are
    // handled by the chat-header dropdown (chat/model/route.ts), which
    // auto-extends models.providers.openrouter.models on demand. Don't
    // assert a specific count — the static fallback is intentionally
    // tiny and may shrink further as upstream renames bite us.
    const modelIds = providerDef.models?.map((m: { id: string }) => m.id) ?? [];
    expect(modelIds).toContain("anthropic/claude-haiku-4.5");
    expect(modelIds.length).toBeGreaterThanOrEqual(1);

    // The real key must be inlined on the provider, not the old "openrouter-ref"
    // placeholder: OpenClaw 2026.6.8 sends models.providers.*.apiKey verbatim, so
    // the placeholder went out as the bearer and OpenRouter 401'd.
    expect(providerDef.apiKey).toBe("sk-or-v1-test");

    // ...and the managed auth profile uses api_key (not the legacy token mode
    // that 6.8 no longer turns into an Authorization header).
    const paste = pasteCallFor("openrouter:default");
    expect(paste?.[0]).toEqual(expect.arrayContaining(["--provider", "openrouter"]));
    expect(pasteStdin("openrouter:default")).toContain("sk-or-v1-test");
  });

  it("honors an openrouter model picked by the user", async () => {
    const res = await configurePost(jsonRequest({
      provider: "openrouter",
      apiKey: "sk-or-v1-test",
      model: "mistralai/mistral-large",
    }));

    expect(res.status).toBe(200);

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands).toContain("config set agents.defaults.model.primary openrouter/mistralai/mistral-large");
  });

  it("rejects an invalid openrouter model slug", async () => {
    const res = await configurePost(jsonRequest({
      provider: "openrouter",
      apiKey: "sk-or-v1-test",
      model: "not-a-valid-slug",
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/Invalid OpenRouter model ID/);
  });

  it("configures google as an openai-compat provider with the key inline", async () => {
    // OpenClaw's native google plugin fails auth at call time on 2026.6.8, so
    // ClawBox routes google through Google's OpenAI-compatible endpoint with the
    // key inline (the proven openai-completions path) rather than the plugin.
    const res = await configurePost(jsonRequest({
      provider: "google",
      apiKey: "AIzaTestKey123",
    }));
    expect(res.status).toBe(200);

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands.some((command) => command.includes("config set models.providers.google"))).toBe(true);
    expect(commands).toContain("config set agents.defaults.model.primary google/gemini-2.5-flash");

    const providerCall = findConfigSet(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch), "models.providers.google");
    const providerDef = providerCall ? JSON.parse(providerCall.value || "{}") : {};
    expect(providerDef.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(providerDef.api).toBe("openai-completions");
    // Real key inlined (the fix) — not delegated to the native plugin.
    expect(providerDef.apiKey).toBe("AIzaTestKey123");
    const modelIds = providerDef.models?.map((m: { id: string }) => m.id) ?? [];
    expect(modelIds).toContain("gemini-2.5-flash");
    expect(modelIds).toContain("gemini-3.5-flash");
    expect(modelIds).toContain("gemini-3.1-flash-lite");

    // ...and the managed auth profile is api_key with the inline key.
    expect(pasteStdin("google:default")).toContain("AIzaTestKey123");
  });

  it("configures anthropic as an openai-compat provider with the key inline", async () => {
    // Native anthropic plugin reads a per-agent sqlite auth store ClawBox
    // doesn't populate ("No API key found" at call time), so route it through
    // Anthropic's OpenAI-compatible endpoint with the key inline.
    const res = await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-ant-test123",
    }));
    expect(res.status).toBe(200);

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands.some((command) => command.includes("config set models.providers.anthropic"))).toBe(true);
    expect(commands).toContain("config set agents.defaults.model.primary anthropic/claude-opus-5");

    const providerCall = findConfigSet(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch), "models.providers.anthropic");
    const providerDef = providerCall ? JSON.parse(providerCall.value || "{}") : {};
    expect(providerDef.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(providerDef.api).toBe("openai-completions");
    expect(providerDef.apiKey).toBe("sk-ant-test123");
    const modelIds = providerDef.models?.map((m: { id: string }) => m.id) ?? [];
    expect(modelIds).toContain("claude-sonnet-5");

    expect(pasteStdin("anthropic:default")).toContain("sk-ant-test123");
  });

  // ------------------------------------------------------------------
  // Gap A1 — a Claude Pro/Max subscription 429'd on EVERY turn on the
  // OpenClaw edition while the same sign-in worked on Hermes.
  //
  // Not a rate limit. `writeOpenAICompatProvider` is an API-key construction:
  // it pins the provider to `api: "openai-completions"` and inlines the
  // credential, so turns leave as `POST /v1/chat/completions` with a bearer
  // token and none of the provider-native headers. Proven on a device against
  // ONE token inside ONE minute: `/v1/chat/completions` -> 429;
  // `/v1/messages` with `anthropic-beta: oauth-2025-04-20` -> 200 and a real
  // completion; `/v1/messages` without that header -> 429. The override was
  // the whole difference, and it was written for subscription sign-ins because
  // the branch never looked at `authMode`.
  //
  // The credential here is a placeholder string, never a real token — this
  // repository is public.
  const ANTHROPIC_OAUTH_ACCESS = "anthropic-oauth-access-token-placeholder";

  it("does not write the openai-compat override for a Claude subscription sign-in", async () => {
    const res = await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: ANTHROPIC_OAUTH_ACCESS,
      authMode: "subscription",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    }));
    expect(res.status).toBe(200);

    // The override is what forces the openai-completions transport. Absent, the
    // native anthropic plugin owns routing and sends /v1/messages with the
    // oauth beta header.
    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands.some((command) => command.includes("config set models.providers.anthropic"))).toBe(false);

    // ...and the rest of the save is unchanged: the subscription still becomes
    // the primary, in merge mode, with an oauth auth profile.
    expect(commands).toContain("config set agents.defaults.model.primary anthropic/claude-opus-5");
    expect(commands).toContain("config set models.mode merge");

    const writtenContent = JSON.parse(mockFs.writeFile.mock.calls.at(-1)?.[1] as string);
    expect(writtenContent.profiles["anthropic:default"]).toEqual(
      expect.objectContaining({ type: "oauth", provider: "anthropic", access: ANTHROPIC_OAUTH_ACCESS }),
    );
  });

  it("removes a stale openai-compat override when a device switches from API key to subscription", async () => {
    // The migration half. Boxes in the field are already in the broken state:
    // they were set up with an `sk-ant-api03-…` key, which wrote the override,
    // and then the owner signed in with their subscription. Nothing in this
    // route ever deleted a provider entry, so the old override outlived the key
    // that justified it and kept poisoning the transport. Not writing a NEW one
    // does not repair those devices; only removing the old one does.
    mockReadOpenClawConfigStrict.mockResolvedValue({
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com/v1",
            api: "openai-completions",
            apiKey: "previously-configured-api-key",
          },
        },
      },
    });

    const res = await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: ANTHROPIC_OAUTH_ACCESS,
      authMode: "subscription",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    }));
    expect(res.status).toBe(200);

    expect(vi.mocked(runOpenclawConfigUnset)).toHaveBeenCalledWith(
      "models.providers.anthropic",
      expect.anything(),
    );

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands.some((command) => command.includes("config set models.providers.anthropic"))).toBe(false);
  });

  it("leaves the openai-compat override alone for an anthropic API key", async () => {
    // The guard is on `authMode`, not on the provider: an API key still needs
    // the override, because the native plugin reads a sqlite auth store ClawBox
    // does not populate and 401s at call time.
    mockReadOpenClawConfig.mockResolvedValue({
      models: { providers: { anthropic: { api: "openai-completions", apiKey: "old-key" } } },
    });

    const res = await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-ant-test123",
    }));
    expect(res.status).toBe(200);

    expect(vi.mocked(runOpenclawConfigUnset)).not.toHaveBeenCalled();
    const providerCall = findConfigSet(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch), "models.providers.anthropic");
    expect(JSON.parse(providerCall?.value || "{}").api).toBe("openai-completions");
  });

  it("keeps the openai-compat override for a provider with no native subscription route", async () => {
    // The sibling question, answered with evidence rather than symmetry.
    // `writeOpenAICompatProvider` has three call sites — openrouter, google,
    // anthropic — but only anthropic earns the native path here.
    //
    // OpenRouter has no OAuth flow at all (absent from OAUTH_PROVIDERS), so a
    // subscription save for it cannot arrive from the wizard. Google DOES have
    // one (Gemini Code Assist), and it reaches the same helper — but nothing
    // gives google a native route to fall back on: setProviderPlugins toggles
    // the anthropic plugin and no other, and the google branch records that
    // the native google plugin's auth fails at call time. Taking google's
    // override away on the strength of anthropic's proof would be this very
    // bug pointed the other way, so google keeps the transport it has until
    // someone proves the native route on a device.
    for (const provider of ["google", "openrouter"] as const) {
      vi.clearAllMocks();
      mockFs.readFile.mockResolvedValue(JSON.stringify({ version: 1, profiles: {} }));
      mockGetAll.mockResolvedValue({});
      mockReadOpenClawConfig.mockResolvedValue({});
      mockReadOpenClawConfigStrict.mockResolvedValue({});
      mockParseFullyQualifiedModel.mockImplementation(parseFullyQualifiedModelImpl);
      mockApplyModelOverrideToAllAgentSessions.mockResolvedValue({ filesUpdated: 0, sessionsUpdated: 0, sessionsSkipped: 0 });

      const res = await configurePost(jsonRequest({
        provider,
        apiKey: `${provider}-oauth-access-token-placeholder`,
        authMode: "subscription",
      }));
      expect(res.status, provider).toBe(200);

      const providerCall = findConfigSet(
        vi.mocked(runOpenclawConfigSet),
        vi.mocked(runOpenclawConfigSetBatch),
        `models.providers.${provider}`,
      );
      expect(providerCall, provider).toBeTruthy();
      expect(JSON.parse(providerCall?.value || "{}").api, provider).toBe("openai-completions");
      // ...and nothing is unset, because there is no native route to hand over to.
      expect(vi.mocked(runOpenclawConfigUnset), provider).not.toHaveBeenCalled();
    }
  });

  it("fails the subscription save when the config cannot be read", async () => {
    // The removal decides to do NOTHING when it sees no override, and the
    // ordinary readConfig answers `{}` to an unreadable file exactly as it does
    // to a clean one. Reading through that would let an EACCES or a
    // half-written config skip the repair, report 200, and leave the poisoned
    // override on disk — the precise failure this fix exists to remove. So an
    // unreadable config has to be loud.
    mockReadOpenClawConfigStrict.mockRejectedValue(
      Object.assign(new Error("EACCES: permission denied, open '/home/clawbox/.openclaw/openclaw.json'"), {
        code: "EACCES",
      }),
    );

    const res = await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: ANTHROPIC_OAUTH_ACCESS,
      authMode: "subscription",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    }));
    expect(res.status).not.toBe(200);
  });

  it("seeds a user-picked non-curated model into the provider entry", async () => {
    // claude-opus-4-8 is newer than ANTHROPIC_MODELS — the helper must still
    // seed the user's pick (via defaultModel) so the gateway can resolve it.
    const res = await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-ant-test123",
      model: "claude-opus-4-8",
    }));
    expect(res.status).toBe(200);

    const providerCall = findConfigSet(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch), "models.providers.anthropic");
    const providerDef = providerCall ? JSON.parse(providerCall.value || "{}") : {};
    const modelIds = providerDef.models?.map((m: { id: string }) => m.id) ?? [];
    expect(modelIds).toContain("claude-opus-4-8");

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands).toContain("config set agents.defaults.model.primary anthropic/claude-opus-4-8");
  });

  // SEC-12: server-side OAuth token handoff. On the handoff path the browser
  // posts no provider tokens — configure reads them from the 0600 file that
  // device-poll wrote, consumes it, and proceeds as if they were in the body.
  it("reads OAuth tokens from the server-side handoff file and consumes it", async () => {
    mockFs.readFile.mockImplementation(async (file) =>
      String(file).endsWith("oauth-device-tokens.json")
        ? JSON.stringify({
            provider: "openai",
            access_token: "access.token.jwt",
            id_token: "id.token.jwt",
            refresh_token: "refresh-token",
            expires_in: 3600,
            createdAt: Date.now(),
          })
        : JSON.stringify({ version: 1, profiles: {} }),
    );

    const res = await configurePost(jsonRequest({
      provider: "openai",
      authMode: "subscription",
      oauthHandoff: true,
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // The handoff file is deleted after read so tokens don't linger on disk.
    expect(mockFs.unlink).toHaveBeenCalledWith(
      expect.stringContaining("oauth-device-tokens.json"),
    );
    // The access token from the file lands in the oauth auth profile.
    const written = JSON.parse(mockFs.writeFile.mock.calls.at(-1)?.[1] as string);
    expect(written.profiles["openai:chatgpt"].access).toBe("access.token.jwt");
    expect(written.profiles["openai:chatgpt"].id).toBe("id.token.jwt");
  });

  it("clears EVERY agent's codex-home mirror on a ChatGPT sign-in, not just ~/.codex", async () => {
    // The sync timer refuses to overwrite a `<agentDir>/codex-home/auth.json`
    // whose refresh token core does not have — overwriting a live app-server
    // rotation with core's spent copy is what burnt the token family in #278.
    // On a 2026.8 box core's store can no longer be written from that script
    // (the per-agent table holds zero profiles after `doctor --fix`), so the
    // file never leaves that state: it keeps the PREVIOUS account's token for
    // the life of the box and the timer warns about it every ten minutes.
    //
    // A sign-in is the one moment the account genuinely changes, so it is the
    // only place the divergence can be settled. Clearing both mirrors here lets
    // the restart below regenerate them from the fresh profile.
    mockFs.readdir.mockResolvedValue(["main", "support"] as unknown as never);
    mockFs.readFile.mockImplementation(async (file) =>
      String(file).endsWith("oauth-device-tokens.json")
        ? JSON.stringify({
            provider: "openai",
            access_token: "access.token.jwt",
            id_token: "id.token.jwt",
            refresh_token: "refresh-token",
            expires_in: 3600,
            createdAt: Date.now(),
          })
        : JSON.stringify({ version: 1, profiles: {} }),
    );

    const res = await configurePost(jsonRequest({
      provider: "openai",
      authMode: "subscription",
      oauthHandoff: true,
    }));
    expect(res.status).toBe(200);

    const removed = mockFs.rm.mock.calls.map((call) => String(call[0]));
    expect(removed.some((file) => file.endsWith("/.codex/auth.json"))).toBe(true);
    expect(removed.some((file) => file.endsWith("/agents/main/agent/codex-home/auth.json"))).toBe(true);
    expect(removed.some((file) => file.endsWith("/agents/support/agent/codex-home/auth.json"))).toBe(true);
  });

  it("binds the handoff tokens to the provider recorded in the file, not the body", async () => {
    // The file says openai (→ the ChatGPT profile); the body claims google. The
    // tokens were minted for openai, so the file's provider must win — binding
    // them under google:default would be wrong.
    mockFs.readFile.mockImplementation(async (file) =>
      String(file).endsWith("oauth-device-tokens.json")
        ? JSON.stringify({
            provider: "openai",
            access_token: "access.token.jwt",
            id_token: "id.token.jwt",
            refresh_token: "refresh-token",
            expires_in: 3600,
            createdAt: Date.now(),
          })
        : JSON.stringify({ version: 1, profiles: {} }),
    );

    const res = await configurePost(jsonRequest({
      provider: "google",
      authMode: "subscription",
      oauthHandoff: true,
    }));

    expect(res.status).toBe(200);
    // Profile is openai:chatgpt (openai subscription), NOT google:default.
    const written = JSON.parse(mockFs.writeFile.mock.calls.at(-1)?.[1] as string);
    expect(written.profiles["openai:chatgpt"]).toBeDefined();
    expect(written.profiles["google:default"]).toBeUndefined();

    const commands = configSetCommands(vi.mocked(runOpenclawConfigSet), vi.mocked(runOpenclawConfigSetBatch));
    expect(commands.some((c) => c.startsWith("config set agents.defaults.model.primary openai/"))).toBe(true);
  });

  it("keeps the handoff file for a retry when the gateway restart fails", async () => {
    mockRestartGateway.mockRejectedValue(new Error("gateway down"));
    mockFs.readFile.mockImplementation(async (file) =>
      String(file).endsWith("oauth-device-tokens.json")
        ? JSON.stringify({
            provider: "openai",
            access_token: "access.token.jwt",
            id_token: "id.token.jwt",
            createdAt: Date.now(),
          })
        : JSON.stringify({ version: 1, profiles: {} }),
    );

    const res = await configurePost(jsonRequest({
      provider: "openai",
      authMode: "subscription",
      oauthHandoff: true,
    }));

    // A transient 5xx must NOT consume the tokens — the client can retry within
    // the TTL rather than being forced through a full re-auth.
    expect(res.status).toBe(502);
    expect(mockFs.unlink).not.toHaveBeenCalled();
  });

  it("returns 400 when the handoff file is missing on the subscription handoff path", async () => {
    mockFs.readFile.mockImplementation(async (file) => {
      if (String(file).endsWith("oauth-device-tokens.json")) {
        throw new Error("ENOENT");
      }
      return JSON.stringify({ version: 1, profiles: {} });
    });

    const res = await configurePost(jsonRequest({
      provider: "openai",
      authMode: "subscription",
      oauthHandoff: true,
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("No pending OAuth tokens");
  });

  it("returns 400 when the handoff tokens are expired", async () => {
    mockFs.readFile.mockImplementation(async (file) =>
      String(file).endsWith("oauth-device-tokens.json")
        ? JSON.stringify({
            provider: "openai",
            access_token: "access.token.jwt",
            id_token: "id.token.jwt",
            createdAt: Date.now() - 20 * 60 * 1000, // 20 min ago > 15 min TTL
          })
        : JSON.stringify({ version: 1, profiles: {} }),
    );

    const res = await configurePost(jsonRequest({
      provider: "openai",
      authMode: "subscription",
      oauthHandoff: true,
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("expired");
  });

  it("rejects and removes a handoff file whose contents cannot be parsed", async () => {
    // A retry cannot fix this file, so leaving it would make every later
    // attempt fail on the same content.
    mockFs.readFile.mockImplementation(async (file) =>
      String(file).endsWith("oauth-device-tokens.json")
        ? "{not json"
        : JSON.stringify({ version: 1, profiles: {} }),
    );

    const res = await configurePost(jsonRequest({
      provider: "openai",
      authMode: "subscription",
      oauthHandoff: true,
    }));

    expect(res.status).toBe(400);
    expect(mockFs.unlink).toHaveBeenCalledWith(
      expect.stringContaining("oauth-device-tokens.json"),
    );
  });

  // Written as raw documents rather than through JSON.stringify: it serialises
  // NaN and Infinity as `null`, which would quietly turn the non-finite case
  // into the missing-createdAt case already covered below. `1e999` parses to
  // Infinity, which is what the route's Number.isFinite check is there for.
  const handoffDoc = (fields: string) =>
    `{"provider":"openai","access_token":"access.token.jwt","id_token":"id.token.jwt",${fields}}`;

  it.each([
    ["a non-numeric createdAt", handoffDoc(`"createdAt":"not-a-timestamp"`)],
    ["a non-finite createdAt", handoffDoc(`"createdAt":1e999`)],
    ["a createdAt in the future", handoffDoc(`"createdAt":${Date.now() + 60 * 60 * 1000}`)],
    // A field of the wrong shape means the file is not one this device wrote.
    ["a non-string access_token", `{"provider":"openai","access_token":{},"createdAt":${Date.now()}}`],
    ["a non-string provider", `{"provider":{},"access_token":"a.b.c","createdAt":${Date.now()}}`],
    // Trims to nothing where it is used, so it is as unusable as a missing one.
    ["a blank access_token", `{"provider":"openai","access_token":"   ","createdAt":${Date.now()}}`],
  ])("rejects and removes a handoff file with %s", async (_label, doc) => {
    // None of these yields something the route can use, and a bare
    // `now - createdAt > TTL` truthiness test passes for every one of them.
    mockFs.readFile.mockImplementation(async (file) =>
      String(file).endsWith("oauth-device-tokens.json")
        ? doc
        : JSON.stringify({ version: 1, profiles: {} }),
    );

    const res = await configurePost(jsonRequest({
      provider: "openai",
      authMode: "subscription",
      oauthHandoff: true,
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("expired");
    expect(mockFs.unlink).toHaveBeenCalledWith(
      expect.stringContaining("oauth-device-tokens.json"),
    );
  });

  it("rejects and removes a handoff file that carries no createdAt", async () => {
    // Without a timestamp the file's age is unknown, so it cannot be shown to
    // be inside the TTL — it is refused like an expired one, and removed rather
    // than left on disk for the next request to find.
    mockFs.readFile.mockImplementation(async (file) =>
      String(file).endsWith("oauth-device-tokens.json")
        ? JSON.stringify({
            provider: "openai",
            access_token: "access.token.jwt",
            id_token: "id.token.jwt",
          })
        : JSON.stringify({ version: 1, profiles: {} }),
    );

    const res = await configurePost(jsonRequest({
      provider: "openai",
      authMode: "subscription",
      oauthHandoff: true,
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("expired");
    expect(mockFs.unlink).toHaveBeenCalledWith(
      expect.stringContaining("oauth-device-tokens.json"),
    );
  });

  // ---------------------------------------------------------------------
  // TASK-481 — the ClawBox AI tier the box is configured for must come from
  // the ACCOUNT, not from the wizard's plan picker.
  //
  // The picker is pre-pairing UI: on a first setup it holds whatever the card
  // defaulted to before there was an account to look at ("flash" = Pro, EUR 9).
  // Sending that as `clawaiTier` while pasting a Max token wrote the EUR 9
  // model onto a EUR 49 box, and the customer had no way to reach the frontier
  // model afterwards. The route already holds the token one line earlier, so
  // it can just ask.
  //
  // Every case below asserts the PRIMARY MODEL that gets written, because that
  // is what the customer actually feels — a stored tier string that no model
  // follows is exactly the half-fixed state this bug lived in.
  describe("ClawBox AI tier reconciliation against the portal", () => {
    const deviceInfo = (body: unknown, status = 200) =>
      vi.fn(async (input: string | URL) =>
        String(input).includes("/api/clawbox-ai/device-info")
          ? new Response(JSON.stringify(body), { status })
          : Promise.reject(new Error("network disabled in tests")),
      );

    const primaryModelWritten = () =>
      findConfigSet(
        vi.mocked(runOpenclawConfigSet),
        vi.mocked(runOpenclawConfigSetBatch),
        "agents.defaults.model.primary",
      )?.value;

    it("configures the Max model when the portal says Max, even though the picker said Pro", async () => {
      vi.stubGlobal("fetch", deviceInfo({ tier: "max" }));

      const res = await configurePost(jsonRequest({
        provider: "clawai",
        apiKey: "claw_max_account",
        clawaiTier: "flash",
      }));

      expect(res.status).toBe(200);
      expect(primaryModelWritten()).toBe("deepseek/deepseek-v4-pro");
      expect(mockSetMany).toHaveBeenCalledWith(
        expect.objectContaining({ clawai_tier: "pro" }),
      );
    });

    it("configures the Pro model when the portal says Pro, even though the picker said Max", async () => {
      // The mirror image, and the reason this is a reconcile rather than a
      // promote: clicking the Max card does not entitle you to the Max model.
      vi.stubGlobal("fetch", deviceInfo({ tier: "pro" }));

      const res = await configurePost(jsonRequest({
        provider: "clawai",
        apiKey: "claw_pro_account",
        clawaiTier: "pro",
      }));

      expect(res.status).toBe(200);
      expect(primaryModelWritten()).toBe("deepseek/deepseek-v4-flash");
      expect(mockSetMany).toHaveBeenCalledWith(
        expect.objectContaining({ clawai_tier: "flash" }),
      );
    });

    it("honours the portal's deviceTier stamp so a Max subscriber can run Flash on this box", async () => {
      // Deliberate downgrade, expressed on the portal side at pair time. The
      // fix must not force such a device up to the plan's headline model.
      vi.stubGlobal("fetch", deviceInfo({ tier: "max", deviceTier: "flash" }));

      const res = await configurePost(jsonRequest({
        provider: "clawai",
        apiKey: "claw_max_running_flash",
        clawaiTier: "pro",
      }));

      expect(res.status).toBe(200);
      expect(primaryModelWritten()).toBe("deepseek/deepseek-v4-flash");
    });

    it("keeps the picker's choice when the portal is unreachable", async () => {
      // A portal outage during setup must never quietly downgrade a paying
      // box. `fetchPortalTier` reports network failures as `unreachable`.
      vi.stubGlobal("fetch", vi.fn(async () => {
        throw new Error("portal down");
      }));

      const res = await configurePost(jsonRequest({
        provider: "clawai",
        apiKey: "claw_offline",
        clawaiTier: "pro",
      }));

      expect(res.status).toBe(200);
      expect(primaryModelWritten()).toBe("deepseek/deepseek-v4-pro");
    });

    it("keeps the picker's choice when the portal answers 401", async () => {
      // 401/403 is ambiguous — genuinely Free, or a revoked/migrated token on
      // a still-paid account. fetchPortalTier maps it to `unreachable` for
      // that reason and this route must inherit the same caution.
      vi.stubGlobal("fetch", deviceInfo({}, 401));

      const res = await configurePost(jsonRequest({
        provider: "clawai",
        apiKey: "claw_bad_auth",
        clawaiTier: "pro",
      }));

      expect(res.status).toBe(200);
      expect(primaryModelWritten()).toBe("deepseek/deepseek-v4-pro");
    });

    it("keeps the picker's choice when the portal reports an unpaid account", async () => {
      // mapPortalTier returns null for Free. Null is "no paid entitlement to
      // reconcile against", not "downgrade them", so the existing chain wins.
      vi.stubGlobal("fetch", deviceInfo({ tier: "free" }));

      const res = await configurePost(jsonRequest({
        provider: "clawai",
        apiKey: "claw_free_account",
        clawaiTier: "pro",
      }));

      expect(res.status).toBe(200);
      expect(primaryModelWritten()).toBe("deepseek/deepseek-v4-pro");
    });

    it("reaches the primary model from the portal alone when the request omits clawaiTier", async () => {
      // CodeRabbit's catch on #430, and a fair one: every other case here
      // sends a picker value, so none of them proves the portal result can
      // drive the model on its own. With `clawaiTier` absent,
      // `requestedClawboxAiTier` is null and the whole chain past
      // `portalConfirmedTier` is the stored value then the hardcoded default
      // — both of which are "flash". So if the reconcile ever stopped
      // feeding this branch, this is the only test that would notice.
      vi.stubGlobal("fetch", deviceInfo({ tier: "max" }));

      const res = await configurePost(jsonRequest({
        provider: "clawai",
        apiKey: "claw_max_no_picker",
      }));

      expect(res.status).toBe(200);
      expect(primaryModelWritten()).toBe("deepseek/deepseek-v4-pro");
      expect(mockSetMany).toHaveBeenCalledWith(
        expect.objectContaining({ clawai_tier: "pro" }),
      );
    });

    it("does not consult the portal for a non-ClawBox provider", async () => {
      const fetchMock = deviceInfo({ tier: "max" });
      vi.stubGlobal("fetch", fetchMock);

      const res = await configurePost(jsonRequest({
        provider: "anthropic",
        apiKey: "sk-ant-key",
      }));

      expect(res.status).toBe(200);
      expect(fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/api/clawbox-ai/device-info"))).toBe(false);
    });
  });
  // TASK-483: the last wizard step sat on "Almost ready" for about three
  // minutes on a real box. It was not a spinner problem — the route issued
  // roughly EIGHTEEN separate `openclaw config set` processes, and on a Jetson
  // Orin Nano the CLI costs ~8 s of Node start-up per invocation before it does
  // any work at all. Two things made it eighteen: every key was its own
  // process, and the ClawBox AI path provisioned ClawBox AI TWICE, because
  // ensureFallbackModel called configureClawboxAi again purely to write
  // `agents.defaults.model.fallbacks`.
  //
  // These tests pin both halves. They are deliberately about the number of
  // PROCESSES and the number of times a path is written, not about wall clock,
  // because those are the two things that regressed and the only two a unit
  // test can hold.
  describe("how many openclaw processes first-run setup costs", () => {
    function invocationCount(): number {
      return (
        vi.mocked(runOpenclawConfigSet).mock.calls.length +
        vi.mocked(runOpenclawConfigSetBatch).mock.calls.length
      );
    }

    it("connects ClawBox AI in at most two CLI invocations", async () => {
      const res = await configurePost(jsonRequest({
        provider: "clawai",
        apiKey: "claw_token_abc",
      }));

      expect(res.status).toBe(200);
      expect(invocationCount()).toBeLessThanOrEqual(2);
    });

    it("saves the primary directly when OpenClaw 2's catalog refuses the reference", async () => {
      // v2 validates agents.defaults.model.primary against a live catalog
      // refresh; a placeholder key resolves zero models and refuses the whole
      // batch. The route must retry the batch without the primary and write
      // the primary itself, keeping the save-without-validating contract.
      vi.mocked(runOpenclawConfigSetBatch).mockRejectedValueOnce(
        new Error(
          'Cannot set model reference "deepseek/deepseek-v4-pro" at agents.defaults.model.primary: Unable to refresh provider catalog',
        ),
      );
      const res = await configurePost(jsonRequest({
        provider: "clawai",
        apiKey: "claw_token_abc",
      }));

      expect(res.status).toBe(200);
      const batches = vi.mocked(runOpenclawConfigSetBatch).mock.calls;
      // The refused batch and its retry lead; the flow may batch again later.
      expect(batches.length).toBeGreaterThanOrEqual(2);
      const firstOps = batches[0][0] as Array<[string, string]>;
      const primaryOp = firstOps.find(([p]) => p === "agents.defaults.model.primary");
      expect(primaryOp).toBeDefined();
      const retryPaths = (batches[1][0] as Array<[string, string]>).map(([p]) => p);
      expect(retryPaths).not.toContain("agents.defaults.model.primary");
      expect(vi.mocked(setPrimaryModelWithoutCatalogValidation)).toHaveBeenCalledWith(primaryOp?.[1]);
    });

    it("says so in the answer when the primary had to be written past the catalog check", async () => {
      // The silence that hid `openai/gpt-5`. The route wrote a primary the CLI
      // had just refused, logged one console.warn nobody reads, and answered a
      // clean {success:true} — so Settings said "Configured" and the owner
      // found out on the first turn. The id is fixed elsewhere in this PR; this
      // is what makes the NEXT unresolvable id a visible event.
      vi.mocked(runOpenclawConfigSetBatch).mockRejectedValueOnce(
        new Error(
          'Cannot set model reference "deepseek/deepseek-v4-pro" at agents.defaults.model.primary: Unable to refresh provider catalog',
        ),
      );
      const res = await configurePost(jsonRequest({
        provider: "clawai",
        apiKey: "claw_token_abc",
      }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.warning).toContain("could not confirm");
      // The model it could not confirm is named — a warning that does not say
      // which id is unresolvable sends the owner nowhere. Read off the batch
      // rather than restated, so it is the id actually written.
      const refusedOps = vi.mocked(runOpenclawConfigSetBatch).mock.calls[0][0] as Array<[string, string]>;
      const written = refusedOps.find(([p]) => p === "agents.defaults.model.primary")?.[1];
      expect(written).toBeDefined();
      expect(body.warning).toContain(written!);
    });

    it("says nothing extra when the catalog accepted the primary", async () => {
      // The other half: a clean save must not grow a warning nobody needs.
      const res = await configurePost(jsonRequest({
        provider: "clawai",
        apiKey: "claw_token_abc",
      }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.warning).toBeUndefined();
    });

    it("stores an API key through the CLI's auth store, key on stdin, no doctor", async () => {
      // OpenClaw 2 refuses a hand-written auth-profiles.json (legacy store);
      // `models auth paste-api-key` writes the running generation's store and
      // needs no migration afterwards — so doctor must NOT run here.
      const res = await configurePost(jsonRequest({
        provider: "clawai",
        apiKey: "claw_token_abc",
      }));
      expect(res.status).toBe(200);
      const paste = vi.mocked(spawnOpenclawCli).mock.calls.find(
        (call) => Array.isArray(call[0]) && call[0].includes("paste-api-key"),
      );
      expect(paste).toBeDefined();
      expect(paste?.[0]).not.toContain("claw_token_abc");
      expect((paste?.[1] as { stdinData?: string })?.stdinData).toContain("claw_token_abc");
      expect(vi.mocked(runOpenclawDoctorFix)).not.toHaveBeenCalled();
    });

    it("fails closed when OpenClaw 2 doctor rejects before creating a migrated sibling", async () => {
      // The early failure is the dangerous case: there is no .migrated-* file
      // yet, but the legacy auth-profiles.json we just wrote still prevents an
      // OpenClaw 2 gateway from starting.
      vi.mocked(runOpenclawDoctorFix).mockRejectedValueOnce(new Error("doctor stopped before migration"));
      vi.mocked(spawnOpenclawCli).mockResolvedValueOnce("OpenClaw 2026.8.1 (test)\n");
      mockFs.readdir.mockResolvedValueOnce([]);

      const res = await configurePost(jsonRequest({
        provider: "anthropic",
        apiKey: ANTHROPIC_OAUTH_ACCESS,
        authMode: "subscription",
        refreshToken: "refresh-token",
        expiresIn: 3600,
      }));
      const body = await res.json();

      expect(res.status).toBe(502);
      expect(body.error).toMatch(/Credential migration failed/);
      const versionCall = vi.mocked(spawnOpenclawCli).mock.calls.find(
        (call) => Array.isArray(call[0]) && call[0].includes("--version"),
      );
      expect(versionCall?.[0]).toEqual(["--version"]);
      expect(versionCall?.[1]).toEqual(expect.objectContaining({ captureStdout: true }));
      expect(vi.mocked(runOpenclawConfigSetBatch)).not.toHaveBeenCalled();
      expect(mockFs.rename).toHaveBeenCalledWith(
        expect.stringMatching(/auth-profiles\.json$/),
        expect.stringMatching(/auth-profiles\.json\.failed-/),
      );
    });

    it("keeps the legacy best-effort doctor behavior on an explicit OpenClaw 1 binary", async () => {
      vi.mocked(runOpenclawDoctorFix).mockRejectedValueOnce(new Error("v1 doctor unavailable"));
      vi.mocked(spawnOpenclawCli).mockResolvedValueOnce("OpenClaw 2026.7.9 (test)\n");
      mockFs.readdir.mockResolvedValueOnce([]);

      const res = await configurePost(jsonRequest({
        provider: "anthropic",
        apiKey: ANTHROPIC_OAUTH_ACCESS,
        authMode: "subscription",
        refreshToken: "refresh-token",
        expiresIn: 3600,
      }));

      expect(res.status).toBe(200);
      expect(vi.mocked(runOpenclawConfigSetBatch)).toHaveBeenCalled();
    });

    it("propagates a serialized direct-write failure instead of claiming success", async () => {
      // The narrow helper owns the strict read and cross-process lock. Any
      // refusal there must stop the route rather than claim a configured model.
      vi.mocked(runOpenclawConfigSetBatch).mockRejectedValueOnce(
        new Error('Cannot set model reference "deepseek/deepseek-v4-pro" at agents.defaults.model.primary: Unable to refresh provider catalog'),
      );
      vi.mocked(setPrimaryModelWithoutCatalogValidation).mockRejectedValueOnce(
        new Error("openclaw.json does not contain a configuration object"),
      );

      const res = await configurePost(jsonRequest({
        provider: "clawai",
        apiKey: "claw_token_abc",
      }));

      expect(res.status).toBe(500);
      expect(vi.mocked(setPrimaryModelWithoutCatalogValidation)).toHaveBeenCalledOnce();
    });

    it("still writes every key the old sequence wrote", async () => {
      await configurePost(jsonRequest({ provider: "clawai", apiKey: "claw_token_abc" }));

      const paths = configSetCalls(
        vi.mocked(runOpenclawConfigSet),
        vi.mocked(runOpenclawConfigSetBatch),
      ).map((call) => call.path);

      for (const expected of [
        "auth.profiles.deepseek:default",
        "agents.defaults.model.primary",
        "gateway.auth.mode",
        "gateway.auth.token",
        "models.providers.deepseek",
        "models.mode",
        "agents.defaults.imageModel",
        "models.providers.openai.apiKey",
        "models.providers.openai.models",
        "agents.defaults.mediaModels.image",
        "agents.defaults.model.fallbacks",
      ]) {
        expect(paths).toContain(expected);
      }
    });

    it("provisions ClawBox AI once, not twice", async () => {
      await configurePost(jsonRequest({ provider: "clawai", apiKey: "claw_token_abc" }));

      const paths = configSetCalls(
        vi.mocked(runOpenclawConfigSet),
        vi.mocked(runOpenclawConfigSetBatch),
      ).map((call) => call.path);

      // The expensive ones. Each of these used to be written twice.
      expect(paths.filter((p) => p === "models.providers.deepseek")).toHaveLength(1);
      expect(paths.filter((p) => p === "models.providers.openai.apiKey")).toHaveLength(1);
      expect(paths.filter((p) => p === "agents.defaults.mediaModels.image")).toHaveLength(1);
      // Two, not one: the generic auth-profile step and the ClawBox AI step
      // both name this path, with the same value. That overlap predates this
      // change (it used to make three) and removing it is a different edit.
      expect(paths.filter((p) => p === "auth.profiles.deepseek:default")).toHaveLength(2);
    });

    it("takes the local model as the fallback without a second ClawBox AI pass", async () => {
      // The other branch of the same decision: when the box already has a local
      // model, the fallback slot names it instead of ClawBox AI — and that has
      // to be decided BEFORE the batch, or we are back to two passes.
      mockGetAll.mockResolvedValue({
        local_ai_configured: true,
        local_ai_model: "ollama/llama3.2:3b",
      });

      const res = await configurePost(jsonRequest({
        provider: "clawai",
        apiKey: "claw_token_abc",
      }));

      expect(res.status).toBe(200);
      const calls = configSetCalls(
        vi.mocked(runOpenclawConfigSet),
        vi.mocked(runOpenclawConfigSetBatch),
      );
      expect(calls.find((c) => c.path === "agents.defaults.model.fallbacks")?.value)
        .toBe(JSON.stringify(["ollama/llama3.2:3b"]));
      expect(calls.filter((c) => c.path === "models.providers.deepseek")).toHaveLength(1);
      expect(invocationCount()).toBeLessThanOrEqual(2);
    });

    it("does not fail the connect when only the fallback write fails", async () => {
      // The fallback used to be written inside ensureFallbackModel's try/catch,
      // so it could never fail the request. Batching it alongside the required
      // writes must not quietly promote it to fatal.
      failConfigSetsMatching(
        vi.mocked(runOpenclawConfigSet),
        vi.mocked(runOpenclawConfigSetBatch),
        (path) => path === "agents.defaults.model.fallbacks",
        () => new Error("fallback write exploded"),
      );

      const res = await configurePost(jsonRequest({
        provider: "clawai",
        apiKey: "claw_token_abc",
      }));

      expect(res.status).toBe(200);
      const paths = configSetCalls(
        vi.mocked(runOpenclawConfigSet),
        vi.mocked(runOpenclawConfigSetBatch),
      ).map((call) => call.path);
      expect(paths).toContain("models.providers.deepseek");
    });

    it("still fails the connect when the LOCAL fallback write fails", async () => {
      // The mirror of the test above, and the reason the two are written
      // separately. A local fallback was written before ensureFallbackModel's
      // try block and so was fatal; the ClawBox AI one was written inside it
      // and only warned. Batching them into one call must not quietly level
      // that difference in either direction.
      mockGetAll.mockResolvedValue({
        local_ai_configured: true,
        local_ai_model: "ollama/llama3.2:3b",
      });
      failConfigSetsMatching(
        vi.mocked(runOpenclawConfigSet),
        vi.mocked(runOpenclawConfigSetBatch),
        (path) => path === "agents.defaults.model.fallbacks",
        () => new Error("fallback write exploded"),
      );

      const res = await configurePost(jsonRequest({
        provider: "clawai",
        apiKey: "claw_token_abc",
      }));

      expect(res.status).toBe(500);
    });
  });

  // OpenClaw 2 validates a model reference on `config set` against the
  // captured catalogs of the ENABLED plugins, and an older gate switched the
  // anthropic plugin off on every switch away from Claude. This route wrote
  // the primary in its batch FIRST and enabled the plugin at step 8b — so on a
  // box whose last primary was ClawBox AI / OpenAI / Google, a Claude save had
  // its batch refused with `Unknown model: anthropic/claude-sonnet-5` and fell
  // through to the direct-write fallback: a "success" whose primary the CLI
  // had just refused. The enable now rides in the SAME batch, ahead of the
  // primary: the core applies a batch to one snapshot and validates the
  // references afterwards, so one spawn does both, and a refused batch leaves
  // the flag as it was.
  describe("the anthropic plugin around the primary write", () => {
    const UNKNOWN_MODEL =
      'Cannot set model reference "anthropic/claude-opus-5" at agents.defaults.model.primary: '
      + "Unknown model: anthropic/claude-opus-5. Run openclaw models list to list available models.";
    const ENABLE_OP = ["plugins.entries.anthropic.enabled", "true", "--json"];

    /** Where in vitest's global call sequence the first call `pick` accepts sits. */
    function orderOf(mock: Mock, pick: (args: unknown[]) => boolean = () => true): number {
      const index = mock.mock.calls.findIndex((args) => pick(args));
      expect(index).toBeGreaterThanOrEqual(0);
      return mock.mock.invocationCallOrder[index];
    }

    const carriesAnthropicPrimary = (op: string[]) =>
      op[0] === "agents.defaults.model.primary" && String(op[1]).startsWith("anthropic/");
    const isEnable = (op: string[]) => op[0] === ENABLE_OP[0] && op[1] === "true";

    /**
     * The CLI as a 2026.8.1 box answers it: the anthropic plugin is OFF (an
     * older gate switched it off on the last switch away from Claude) and a
     * batch carrying an `anthropic/*` primary is refused unless the same batch
     * switches the plugin on ahead of it.
     */
    function refuseAnthropicPrimaryUnlessEnabledFirst() {
      vi.mocked(runOpenclawConfigSet).mockImplementation(async (args) => {
        if (carriesAnthropicPrimary(args)) throw new Error(UNKNOWN_MODEL);
      });
      vi.mocked(runOpenclawConfigSetBatch).mockImplementation(async (ops) => {
        const enableIdx = ops.findIndex(isEnable);
        const primaryIdx = ops.findIndex(carriesAnthropicPrimary);
        if (primaryIdx >= 0 && !(enableIdx >= 0 && enableIdx < primaryIdx)) throw new Error(UNKNOWN_MODEL);
      });
    }

    it.each([
      ["a Claude subscription", { apiKey: ANTHROPIC_OAUTH_ACCESS, authMode: "subscription", refreshToken: "refresh-token", expiresIn: 3600 }],
      ["an Anthropic API key", { apiKey: "sk-ant-test123" }],
    ])("switches the plugin on in the SAME batch as the primary, ahead of it, for %s", async (_label, body) => {
      refuseAnthropicPrimaryUnlessEnabledFirst();

      const res = await configurePost(jsonRequest({ provider: "anthropic", ...body }));
      expect(res.status).toBe(200);

      // The reference went through the CLI's own validation. The direct-write
      // fallback exists for an EMPTY catalog (placeholder key, first boot);
      // taken here it would have masked exactly this ordering bug.
      expect(vi.mocked(setPrimaryModelWithoutCatalogValidation)).not.toHaveBeenCalled();
      const batch = vi.mocked(runOpenclawConfigSetBatch).mock.calls.find(([ops]) => ops.some(carriesAnthropicPrimary));
      expect(batch).toBeDefined();
      const ops = batch![0];
      expect(ops.findIndex(isEnable)).toBeGreaterThanOrEqual(0);
      expect(ops.findIndex(isEnable)).toBeLessThan(ops.findIndex(carriesAnthropicPrimary));
      expect(vi.mocked(runOpenclawConfigSet).mock.calls.some(([args]) => isEnable(args))).toBe(false);

      // The OFF half of the gate stays after the write (a no-op for Anthropic,
      // but its place is what keeps a live primary's plugin on), and a plugin
      // enabled by the batch loads on the next gateway start, so the restart
      // that already ends the save has to stay after all of it.
      const writtenAt = orderOf(vi.mocked(runOpenclawConfigSetBatch), (args) => (args[0] as string[][]).some(carriesAnthropicPrimary));
      const gatedAt = orderOf(vi.mocked(setProviderPlugins), (args) => args[0] === "anthropic");
      expect(writtenAt).toBeLessThan(gatedAt);
      expect(gatedAt).toBeLessThan(orderOf(mockRestartGateway));
    });

    it("re-lands the enable with the rest of the batch when the catalog refuses the primary", async () => {
      // The empty-catalog fallback retries the batch WITHOUT the primary and
      // writes the primary directly; the enable is not the primary, so it
      // rides the retry — the plugin is on for the model the direct write
      // then names.
      vi.mocked(runOpenclawConfigSetBatch).mockRejectedValueOnce(new Error(UNKNOWN_MODEL));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const res = await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-ant-test123" }));
      expect(res.status).toBe(200);
      expect(vi.mocked(setPrimaryModelWithoutCatalogValidation)).toHaveBeenCalledWith("anthropic/claude-opus-5");
      const batches = vi.mocked(runOpenclawConfigSetBatch).mock.calls;
      expect(batches.length).toBeGreaterThanOrEqual(2);
      const retry = batches[1][0];
      expect(retry.some(isEnable)).toBe(true);
      expect(retry.some(carriesAnthropicPrimary)).toBe(false);
      expect(warn.mock.calls.map(([first]) => String(first)).some((line) => line.includes("Primary written directly"))).toBe(true);
    });
  });
});
