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
  },
}));

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/home/clawbox/clawbox/data",
  getAll: vi.fn(),
  setMany: vi.fn(),
}));

vi.mock("@/lib/openclaw-config", () => ({
  DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR: 24000,
  restartGateway: vi.fn(),
  findOpenclawBin: vi.fn().mockReturnValue("/usr/local/bin/openclaw"),
  readConfig: vi.fn(),
  inferConfiguredLocalModel: vi.fn(),
}));

import { getAll, setMany } from "@/lib/config-store";
import { inferConfiguredLocalModel, readConfig, restartGateway } from "@/lib/openclaw-config";

const mockSpawn = vi.mocked(childProcess.spawn);
const mockGetAll = vi.mocked(getAll);
const mockSetMany = vi.mocked(setMany);
const mockInferConfiguredLocalModel = vi.mocked(inferConfiguredLocalModel);
const mockReadOpenClawConfig = vi.mocked(readConfig);
const mockRestartGateway = vi.mocked(restartGateway);
const mockFs = vi.mocked(fsp);

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
    mockGetAll.mockResolvedValue({});
    mockReadOpenClawConfig.mockResolvedValue({});
    mockInferConfiguredLocalModel.mockReturnValue(null);
    mockSetMany.mockResolvedValue();
    mockRestartGateway.mockResolvedValue();
    mockSpawn.mockImplementation(() => createSuccessfulChildProcess());

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

    const providerCall = mockSpawn.mock.calls.find((call) => call[1]?.[2] === "models.providers.deepseek");
    const providerDef = providerCall ? JSON.parse(providerCall[1]?.[3] ?? "{}") : {};
    expect(providerDef.apiKey).toBe("portal-token-123");

    expect(mockSetMany).toHaveBeenCalledWith(
      expect.objectContaining({
        clawai_token: "portal-token-123",
      }),
    );
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
  });

  it("configures llama.cpp without apiKey", async () => {
    const res = await configurePost(jsonRequest({
      provider: "llamacpp",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const commands = mockSpawn.mock.calls.map((call) => call[1]?.join(" ") ?? "");
    expect(commands).toContain("config set agents.defaults.model.primary llamacpp/gemma4-e2b-it-q4_0");
    expect(commands).toContain("config set agents.defaults.compaction.reserveTokensFloor 24000");
    expect(commands).toContain("config set gateway.auth.mode token");
    expect(commands).toContain("config set gateway.auth.token clawbox");
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

    const commands = mockSpawn.mock.calls.map((call) => call[1]?.join(" ") ?? "");
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

    const commands = mockSpawn.mock.calls.map((call) => call[1]?.join(" ") ?? "");
    expect(commands).not.toContain("config set agents.defaults.model.primary llamacpp/gemma4-e2b-it-q4_0");
    expect(commands).toContain('config set agents.defaults.model.fallbacks ["llamacpp/gemma4-e2b-it-q4_0"] --json');
    expect(commands).toContain("config set models.mode merge");
  });

  it("configures subscription auth mode for oauth", async () => {
    const res = await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "access-token",
      authMode: "subscription",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
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
    mockSpawn.mockImplementation(() => createFailingChildProcess("Command failed"));

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

  it("writes auth profile with correct structure for token auth", async () => {
    await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-test",
    }));

    expect(mockFs.writeFile).toHaveBeenCalled();
    const writeCall = mockFs.writeFile.mock.calls[0];
    const writtenContent = JSON.parse(writeCall[1] as string);

    expect(writtenContent.profiles["anthropic:default"]).toBeDefined();
    expect(writtenContent.profiles["anthropic:default"].type).toBe("token");
  });

  it("writes auth profile with dummy key for Ollama", async () => {
    await configurePost(jsonRequest({
      provider: "ollama",
      apiKey: "mistral:7b",
    }));

    const writeCall = mockFs.writeFile.mock.calls[0];
    const writtenContent = JSON.parse(writeCall[1] as string);
    expect(writtenContent.profiles["ollama:default"].key).toBe("ollama-local");
  });

  it("writes auth profile with dummy key for llama.cpp", async () => {
    await configurePost(jsonRequest({
      provider: "llamacpp",
      apiKey: "gemma-q4",
    }));

    const writeCall = mockFs.writeFile.mock.calls[0];
    const writtenContent = JSON.parse(writeCall[1] as string);
    expect(writtenContent.profiles["llamacpp:default"].key).toBe("llamacpp-local");
  });

  it("configures ClawBox AI as a fallback model when a stored user token is present", async () => {
    mockGetAll.mockResolvedValue({
      clawai_token: "stored-fallback-token",
    });

    await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-test",
    }));

    const commands = mockSpawn.mock.calls.map((call) => call[1]?.join(" ") ?? "");
    expect(commands).toContain('config set agents.defaults.model.fallbacks ["deepseek/deepseek-chat"] --json');
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

    const commands = mockSpawn.mock.calls.map((call) => call[1]?.join(" ") ?? "");
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

    const commands = mockSpawn.mock.calls.map((call) => call[1]?.join(" ") ?? "");
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

    const commands = mockSpawn.mock.calls.map((call) => call[1]?.join(" ") ?? "");
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

    const providerCall = mockSpawn.mock.calls.find((call) => call[1]?.[2] === "models.providers.deepseek");
    const providerDef = providerCall ? JSON.parse(providerCall[1]?.[3] ?? "{}") : {};

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

    const commands = mockSpawn.mock.calls.map((call) => call[1]?.join(" ") ?? "");
    expect(commands.some((command) => command.includes("config set models.providers.llamacpp"))).toBe(true);
    expect(commands).toContain("config set agents.defaults.model.primary llamacpp/gemma-q4");

    const providerCall = mockSpawn.mock.calls.find((call) => call[1]?.[2] === "models.providers.llamacpp");
    const providerDef = providerCall ? JSON.parse(providerCall[1]?.[3] ?? "{}") : {};
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

    const providerCall = mockSpawn.mock.calls.find((call) => call[1]?.[2] === "models.providers.ollama");
    const providerDef = providerCall ? JSON.parse(providerCall[1]?.[3] ?? "{}") : {};

    expect(providerDef.baseUrl).toBe("http://127.0.0.1/setup-api/local-ai/ollama");
  });
});
