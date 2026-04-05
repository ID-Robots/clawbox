import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import * as fsp from "fs/promises";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";

vi.mock("child_process", () => ({
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
  setMany: vi.fn(),
}));

vi.mock("@/lib/openclaw-config", () => ({
  restartGateway: vi.fn(),
  findOpenclawBin: vi.fn().mockReturnValue("/usr/local/bin/openclaw"),
}));

import { setMany } from "@/lib/config-store";
import { restartGateway } from "@/lib/openclaw-config";

const mockSpawn = vi.mocked(childProcess.spawn);
const mockSetMany = vi.mocked(setMany);
const mockRestartGateway = vi.mocked(restartGateway);
const mockFs = vi.mocked(fsp.default);

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

  it("restarts gateway after configuration", async () => {
    await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-test",
    }));

    expect(mockRestartGateway).toHaveBeenCalled();
  });
});
