import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import fsp from "fs/promises";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";

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
    rm: vi.fn(),
  },
}));

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/home/clawbox/clawbox/data",
  getAll: vi.fn(),
  setMany: vi.fn(),
}));

vi.mock("@/lib/clawkeep", () => ({
  unpairLocal: vi.fn(),
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
  findOpenclawBin: vi.fn().mockReturnValue("/usr/local/bin/openclaw"),
  readConfig: vi.fn(),
  inferConfiguredLocalModel: vi.fn(),
  runOpenclawConfigSet: vi.fn(),
  // Added by PR #83 — the configure route sweeps agent sessions so the
  // new primary provider takes effect on the open chat without a reset.
  applyModelOverrideToAllAgentSessions: vi.fn().mockResolvedValue(undefined),
  parseFullyQualifiedModel: vi.fn(parseFullyQualifiedModelImpl),
  // Plugin gating: configure route now toggles `plugins.entries.anthropic.enabled`
  // based on the active provider. Tests don't care about the side effect; just
  // make the import resolve.
  setProviderPlugins: vi.fn().mockResolvedValue(undefined),
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
import { inferConfiguredLocalModel, readConfig, restartGateway, runOpenclawConfigSet, applyModelOverrideToAllAgentSessions, parseFullyQualifiedModel } from "@/lib/openclaw-config";
import { getDefaultLlamaCppModel, getLlamaCppContextWindow, getLlamaCppMaxTokens, getLlamaCppProxyBaseUrl } from "@/lib/llamacpp";
import { getLocalAiProxyBaseUrl } from "@/lib/local-ai-runtime";
import { getLocalAiToken } from "@/lib/local-ai-token";

const mockSpawn = vi.mocked(childProcess.spawn);
const mockGetAll = vi.mocked(getAll);
const mockSetMany = vi.mocked(setMany);
const mockInferConfiguredLocalModel = vi.mocked(inferConfiguredLocalModel);
const mockReadOpenClawConfig = vi.mocked(readConfig);
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
    mockFs.rm.mockResolvedValue(undefined);
    mockGetAll.mockResolvedValue({});
    mockReadOpenClawConfig.mockResolvedValue({});
    mockInferConfiguredLocalModel.mockReturnValue(null);
    mockSetMany.mockResolvedValue();
    mockRestartGateway.mockResolvedValue();
    mockSpawn.mockImplementation(() => createSuccessfulChildProcess());
    vi.mocked(runOpenclawConfigSet).mockResolvedValue(undefined);
    mockUnpairLocal.mockResolvedValue(undefined);

    // Re-apply implementations cleared by vi.clearAllMocks above. Factory
    // defaults set in `vi.mock(...)` hold across vi.resetModules but are
    // wiped by mockClear call history cleanup, so we seed them per-test.
    mockApplyModelOverrideToAllAgentSessions.mockResolvedValue({ filesUpdated: 0, sessionsUpdated: 0 });
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

    const mod = await import("@/app/setup-api/ai-models/configure/route");
    configurePost = mod.POST;
  });

  afterEach(() => {
    vi.clearAllMocks();
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

  it("configures openai provider", async () => {
    const res = await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "sk-openai-key",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const commands = vi.mocked(runOpenclawConfigSet).mock.calls.map((call) => ["config", "set", ...(call[0] ?? [])].join(" "));
    expect(commands).toContain("config set agents.defaults.model.primary openai/gpt-5");
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

    const writtenContent = JSON.parse(mockFs.writeFile.mock.calls.at(-1)?.[1] as string);
    expect(writtenContent.profiles["deepseek:default"]).toEqual(
      expect.objectContaining({
        type: "api_key",
        provider: "deepseek",
        key: "portal-token-123",
      }),
    );

    const providerCall = vi.mocked(runOpenclawConfigSet).mock.calls.find((call) => call[0][0] === "models.providers.deepseek");
    const providerDef = providerCall ? JSON.parse(providerCall[0][1] ?? "{}") : {};
    expect(providerDef.apiKey).toBe("portal-token-123");

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
    const commands = vi.mocked(runOpenclawConfigSet).mock.calls.map((call) => ["config", "set", ...(call[0] ?? [])].join(" "));
    expect(commands).toContain("config set agents.defaults.compaction.reserveTokensFloor 8192");
  });

  it("configures llama.cpp without apiKey", async () => {
    const res = await configurePost(jsonRequest({
      provider: "llamacpp",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const commands = vi.mocked(runOpenclawConfigSet).mock.calls.map((call) => ["config", "set", ...(call[0] ?? [])].join(" "));
    expect(commands).toContain("config set agents.defaults.model.primary llamacpp/gemma4-e2b-it-q4_0");
    expect(commands).toContain("config set agents.defaults.compaction.reserveTokensFloor 24000");
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

    const commands = vi.mocked(runOpenclawConfigSet).mock.calls.map((call) => ["config", "set", ...(call[0] ?? [])].join(" "));
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

    const commands = vi.mocked(runOpenclawConfigSet).mock.calls.map((call) => ["config", "set", ...(call[0] ?? [])].join(" "));
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

    const commands = vi.mocked(runOpenclawConfigSet).mock.calls.map((call) => ["config", "set", ...(call[0] ?? [])].join(" "));
    expect(commands).toContain("config set agents.defaults.model.primary codex/gpt-5.4");
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
    vi.mocked(runOpenclawConfigSet).mockRejectedValue(new Error("Command failed"));

    const res = await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-test",
    }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBeDefined();
  });

  it("handles missing auth profiles file", async () => {
    mockFs.readFile.mockRejectedValue(new Error("ENOENT"));

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

    expect(mockFs.writeFile).toHaveBeenCalled();
    const writeCall = mockFs.writeFile.mock.calls[0];
    const writtenContent = JSON.parse(writeCall[1] as string);

    expect(writtenContent.profiles["anthropic:default"]).toBeDefined();
    expect(writtenContent.profiles["anthropic:default"].type).toBe("api_key");
    expect(writtenContent.profiles["anthropic:default"].key).toBe("sk-test");
  });

  it("writes auth profile with the local-ai bearer for Ollama", async () => {
    await configurePost(jsonRequest({
      provider: "ollama",
      apiKey: "mistral:7b",
    }));

    const writeCall = mockFs.writeFile.mock.calls[0];
    const writtenContent = JSON.parse(writeCall[1] as string);
    // Per-install token (>=16 chars) — the proxy validates against the same
    // value via `verifyLocalAiBearer` in src/lib/local-ai-token.ts.
    expect(writtenContent.profiles["ollama:default"].key).toMatch(/^[a-f0-9]{32,}$/);
  });

  it("writes auth profile with the local-ai bearer for llama.cpp", async () => {
    await configurePost(jsonRequest({
      provider: "llamacpp",
      apiKey: "gemma-q4",
    }));

    const writeCall = mockFs.writeFile.mock.calls[0];
    const writtenContent = JSON.parse(writeCall[1] as string);
    expect(writtenContent.profiles["llamacpp:default"].key).toMatch(/^[a-f0-9]{32,}$/);
  });

  it("configures ClawBox AI as a fallback model when a stored user token is present", async () => {
    mockGetAll.mockResolvedValue({
      clawai_token: "stored-fallback-token",
    });

    await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-test",
    }));

    const commands = vi.mocked(runOpenclawConfigSet).mock.calls.map((call) => ["config", "set", ...(call[0] ?? [])].join(" "));
    expect(commands).toContain('config set agents.defaults.model.fallbacks ["deepseek/deepseek-v4-flash"] --json');
    expect(commands.some((command) => command.includes("config set models.providers.deepseek"))).toBe(true);

    const writtenContent = JSON.parse(mockFs.writeFile.mock.calls.at(-1)?.[1] as string);
    expect(writtenContent.profiles["deepseek:default"]).toEqual(
      expect.objectContaining({
        type: "api_key",
        provider: "deepseek",
        key: "stored-fallback-token",
      })
    );
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

    const commands = vi.mocked(runOpenclawConfigSet).mock.calls.map((call) => ["config", "set", ...(call[0] ?? [])].join(" "));
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

    const commands = vi.mocked(runOpenclawConfigSet).mock.calls.map((call) => ["config", "set", ...(call[0] ?? [])].join(" "));
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

    const commands = vi.mocked(runOpenclawConfigSet).mock.calls.map((call) => ["config", "set", ...(call[0] ?? [])].join(" "));
    expect(commands).not.toContain('config set agents.defaults.model.fallbacks ["llamacpp/gemma4-e2b-it-q4_0"] --json');
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

    const providerCall = vi.mocked(runOpenclawConfigSet).mock.calls.find((call) => call[0][0] === "models.providers.deepseek");
    const providerDef = providerCall ? JSON.parse(providerCall[0][1] ?? "{}") : {};

    expect(providerDef.baseUrl).toBe("https://openclawhardware.dev/api/ai");
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

    const commands = vi.mocked(runOpenclawConfigSet).mock.calls.map((call) => ["config", "set", ...(call[0] ?? [])].join(" "));
    expect(commands.some((command) => command.includes("config set models.providers.llamacpp"))).toBe(true);
    expect(commands).toContain("config set agents.defaults.model.primary llamacpp/gemma-q4");

    const providerCall = vi.mocked(runOpenclawConfigSet).mock.calls.find((call) => call[0][0] === "models.providers.llamacpp");
    const providerDef = providerCall ? JSON.parse(providerCall[0][1] ?? "{}") : {};
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

    const providerCall = vi.mocked(runOpenclawConfigSet).mock.calls.find((call) => call[0][0] === "models.providers.ollama");
    const providerDef = providerCall ? JSON.parse(providerCall[0][1] ?? "{}") : {};

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

    const commands = vi.mocked(runOpenclawConfigSet).mock.calls.map((call) => ["config", "set", ...(call[0] ?? [])].join(" "));
    expect(commands.some((command) => command.includes("config set models.providers.openrouter"))).toBe(true);
    expect(commands).toContain("config set agents.defaults.model.primary openrouter/anthropic/claude-haiku-4.5");

    const providerCall = vi.mocked(runOpenclawConfigSet).mock.calls.find((call) => call[0][0] === "models.providers.openrouter");
    const providerDef = providerCall ? JSON.parse(providerCall[0][1] ?? "{}") : {};

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
    const writtenContent = JSON.parse(mockFs.writeFile.mock.calls.at(-1)?.[1] as string);
    expect(writtenContent.profiles["openrouter:default"]).toEqual(
      expect.objectContaining({ type: "api_key", provider: "openrouter", key: "sk-or-v1-test" })
    );
  });

  it("honors an openrouter model picked by the user", async () => {
    const res = await configurePost(jsonRequest({
      provider: "openrouter",
      apiKey: "sk-or-v1-test",
      model: "mistralai/mistral-large",
    }));

    expect(res.status).toBe(200);

    const commands = vi.mocked(runOpenclawConfigSet).mock.calls.map((call) => ["config", "set", ...(call[0] ?? [])].join(" "));
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

    const commands = vi.mocked(runOpenclawConfigSet).mock.calls.map((call) => ["config", "set", ...(call[0] ?? [])].join(" "));
    expect(commands.some((command) => command.includes("config set models.providers.google"))).toBe(true);
    expect(commands).toContain("config set agents.defaults.model.primary google/gemini-2.5-flash");

    const providerCall = vi.mocked(runOpenclawConfigSet).mock.calls.find((call) => call[0][0] === "models.providers.google");
    const providerDef = providerCall ? JSON.parse(providerCall[0][1] ?? "{}") : {};
    expect(providerDef.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(providerDef.api).toBe("openai-completions");
    // Real key inlined (the fix) — not delegated to the native plugin.
    expect(providerDef.apiKey).toBe("AIzaTestKey123");
    const modelIds = providerDef.models?.map((m: { id: string }) => m.id) ?? [];
    expect(modelIds).toContain("gemini-2.5-flash");
    expect(modelIds).toContain("gemini-3.5-flash");
    expect(modelIds).toContain("gemini-3.1-flash-lite");

    // ...and the managed auth profile is api_key with the inline key.
    const writtenContent = JSON.parse(mockFs.writeFile.mock.calls.at(-1)?.[1] as string);
    expect(writtenContent.profiles["google:default"]).toEqual(
      expect.objectContaining({ type: "api_key", provider: "google", key: "AIzaTestKey123" })
    );
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

    const commands = vi.mocked(runOpenclawConfigSet).mock.calls.map((call) => ["config", "set", ...(call[0] ?? [])].join(" "));
    expect(commands.some((command) => command.includes("config set models.providers.anthropic"))).toBe(true);
    expect(commands).toContain("config set agents.defaults.model.primary anthropic/claude-sonnet-4-6");

    const providerCall = vi.mocked(runOpenclawConfigSet).mock.calls.find((call) => call[0][0] === "models.providers.anthropic");
    const providerDef = providerCall ? JSON.parse(providerCall[0][1] ?? "{}") : {};
    expect(providerDef.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(providerDef.api).toBe("openai-completions");
    expect(providerDef.apiKey).toBe("sk-ant-test123");
    const modelIds = providerDef.models?.map((m: { id: string }) => m.id) ?? [];
    expect(modelIds).toContain("claude-sonnet-4-6");

    const writtenContent = JSON.parse(mockFs.writeFile.mock.calls.at(-1)?.[1] as string);
    expect(writtenContent.profiles["anthropic:default"]).toEqual(
      expect.objectContaining({ type: "api_key", provider: "anthropic", key: "sk-ant-test123" })
    );
  });
});
