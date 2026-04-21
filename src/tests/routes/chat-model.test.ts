import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: vi.fn(),
}));

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/home/clawbox/clawbox/data",
  getAll: vi.fn(),
}));

vi.mock("@/lib/openclaw-config", () => ({
  inferConfiguredLocalModel: vi.fn(),
  findOpenclawBin: vi.fn(() => "/usr/local/bin/openclaw"),
  readConfig: vi.fn(),
  restartGateway: vi.fn(),
  runOpenclawConfigSet: vi.fn(),
  applyModelOverrideToAllAgentSessions: vi.fn(),
  parseFullyQualifiedModel: vi.fn(),
}));

vi.mock("@/lib/sqlite-store", () => ({
  sqliteGet: vi.fn(),
  sqliteSet: vi.fn(),
}));

import { getAll } from "@/lib/config-store";
import { inferConfiguredLocalModel, readConfig, restartGateway, runOpenclawConfigSet, applyModelOverrideToAllAgentSessions, parseFullyQualifiedModel } from "@/lib/openclaw-config";
import { sqliteGet, sqliteSet } from "@/lib/sqlite-store";
import { promisify } from "util";

describe("/setup-api/chat/model", () => {
  let GET: () => Promise<Response>;
  let POST: (request: Request) => Promise<Response>;
  let mockExec: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockExec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    vi.mocked(promisify).mockReturnValue(mockExec as never);
    vi.mocked(runOpenclawConfigSet).mockResolvedValue(undefined);
    vi.mocked(applyModelOverrideToAllAgentSessions).mockResolvedValue({ filesUpdated: 0, sessionsUpdated: 0 });
    // Mirror real `parseFullyQualifiedModel` from `@/lib/openclaw-config`
    // exactly — trailing-slash rejection matters, a lax mock can mask bugs.
    vi.mocked(parseFullyQualifiedModel).mockImplementation((fq: string) => {
      const idx = fq.indexOf("/");
      if (idx <= 0 || idx === fq.length - 1) return null;
      return { provider: fq.slice(0, idx), modelId: fq.slice(idx + 1) };
    });

    vi.mocked(getAll).mockResolvedValue({
      ai_model_provider: "clawai",
      local_ai_provider: "llamacpp",
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
    });
    vi.mocked(readConfig).mockResolvedValue({
      auth: {
        profiles: {
          "deepseek:default": { provider: "deepseek", mode: "api_key" },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "deepseek/deepseek-chat",
          },
        },
      },
    } as never);
    vi.mocked(inferConfiguredLocalModel).mockReturnValue(null);
    vi.mocked(sqliteGet).mockResolvedValue(null);
    vi.mocked(sqliteSet).mockResolvedValue();
    vi.mocked(restartGateway).mockResolvedValue();

    const mod = await import("@/app/setup-api/chat/model/route");
    GET = mod.GET;
    POST = mod.POST;
  });

  it("returns both the primary AI provider and Local AI targets", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.activeOptionId).toBe("deepseek/deepseek-chat");
    expect(body.activeSource).toBe("primary");
    expect(body.activeLabel).toBe("ClawBox AI");
    expect(body.options).toEqual([
      {
        id: "deepseek/deepseek-chat",
        label: "ClawBox AI",
        model: "deepseek/deepseek-chat",
        provider: "clawai",
        available: true,
        settingsSection: "ai",
        isLocal: false,
      },
      {
        id: "llamacpp/gemma4-e2b-it-q4_0",
        label: "Gemma 4 Local",
        model: "llamacpp/gemma4-e2b-it-q4_0",
        provider: "llamacpp",
        available: true,
        settingsSection: "localAi",
        isLocal: true,
      },
    ]);
    expect(body.primary).toEqual({
      available: true,
      label: "ClawBox AI",
      model: "deepseek/deepseek-chat",
    });
    expect(body.local).toEqual({
      available: true,
      label: "Gemma 4 Local",
      model: "llamacpp/gemma4-e2b-it-q4_0",
    });
    expect(sqliteSet).toHaveBeenCalledWith("chat:primary-provider-model", "deepseek/deepseek-chat");
  });

  it("lists every configured cloud provider alongside Local AI", async () => {
    vi.mocked(readConfig).mockResolvedValue({
      auth: {
        profiles: {
          "deepseek:default": { provider: "deepseek", mode: "api_key" },
          "openai:default": { provider: "openai", mode: "token" },
          "anthropic:default": { provider: "anthropic", mode: "token" },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "deepseek/deepseek-chat",
          },
        },
      },
    } as never);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.options.map((option: { label: string }) => option.label)).toEqual([
      "ClawBox AI",
      "OpenAI GPT",
      "Anthropic Claude",
      "Gemma 4 Local",
    ]);
    expect(body.options.map((option: { model: string | null }) => option.model)).toEqual([
      "deepseek/deepseek-chat",
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4-6",
      "llamacpp/gemma4-e2b-it-q4_0",
    ]);
  });

  it("switches the active chat model to Local AI and restarts the gateway", async () => {
    vi.mocked(readConfig)
      .mockResolvedValueOnce({
        auth: {
          profiles: {
            "deepseek:default": { provider: "deepseek", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "deepseek/deepseek-chat",
            },
          },
        },
      } as never)
      .mockResolvedValueOnce({
        auth: {
          profiles: {
            "deepseek:default": { provider: "deepseek", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "llamacpp/gemma4-e2b-it-q4_0",
            },
          },
        },
      } as never);
    vi.mocked(sqliteGet)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("deepseek/deepseek-chat");

    const response = await POST(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llamacpp/gemma4-e2b-it-q4_0" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(runOpenclawConfigSet).toHaveBeenCalledWith([
      "agents.defaults.model.primary",
      "llamacpp/gemma4-e2b-it-q4_0",
    ]);
    expect(restartGateway).toHaveBeenCalled();
    expect(body.activeSource).toBe("local");
    expect(body.activeLabel).toBe("Gemma 4 Local");
  });

  it("switches back to the stored primary provider model", async () => {
    vi.mocked(getAll).mockResolvedValue({
      ai_model_provider: "clawai",
      local_ai_provider: "llamacpp",
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
    });
    vi.mocked(readConfig)
      .mockResolvedValueOnce({
        auth: {
          profiles: {
            "deepseek:default": { provider: "deepseek", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "llamacpp/gemma4-e2b-it-q4_0",
            },
          },
        },
      } as never)
      .mockResolvedValueOnce({
        auth: {
          profiles: {
            "deepseek:default": { provider: "deepseek", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "deepseek/deepseek-chat",
            },
          },
        },
      } as never);
    vi.mocked(sqliteGet)
      .mockResolvedValueOnce("deepseek/deepseek-chat")
      .mockResolvedValueOnce("deepseek/deepseek-chat");

    const response = await POST(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek/deepseek-chat" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(runOpenclawConfigSet).toHaveBeenCalledWith([
      "agents.defaults.model.primary",
      "deepseek/deepseek-chat",
    ]);
    expect(body.activeSource).toBe("primary");
    expect(body.activeLabel).toBe("ClawBox AI");
  });

  it("rejects an invalid source", async () => {
    const response = await POST(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "unsupported" }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid chat model source" });
  });

  it("accepts an arbitrary openrouter/<slug> when the openrouter profile exists", async () => {
    // The wizard curates ~12 models but OpenRouter exposes 340+. Users can
    // enter a custom slug in the wizard or hot-swap to a non-curated model
    // in the chat header — either way the slug reaches this route without
    // being in state.options. We accept it as long as openrouter is
    // configured (auth profile present). Without this escape hatch the
    // custom-input path is dead weight.
    vi.mocked(readConfig)
      .mockResolvedValueOnce({
        auth: {
          profiles: {
            "openrouter:default": { provider: "openrouter", mode: "token" },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openrouter/anthropic/claude-haiku-4-5",
            },
          },
        },
      } as never)
      .mockResolvedValueOnce({
        auth: {
          profiles: {
            "openrouter:default": { provider: "openrouter", mode: "token" },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openrouter/mistralai/mistral-large",
            },
          },
        },
      } as never);

    const response = await POST(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openrouter/mistralai/mistral-large" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(runOpenclawConfigSet).toHaveBeenCalledWith([
      "agents.defaults.model.primary",
      "openrouter/mistralai/mistral-large",
    ]);
    expect(body.activeModel).toBe("openrouter/mistralai/mistral-large");
  });

  it("rejects a non-openrouter model that is not in state.options", async () => {
    const response = await POST(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-nonexistent" }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Selected AI provider is not configured" });
  });
});
