import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: vi.fn(),
}));

vi.mock("@/lib/config-store", () => ({
  getAll: vi.fn(),
}));

vi.mock("@/lib/openclaw-config", () => ({
  inferConfiguredLocalModel: vi.fn(),
  findOpenclawBin: vi.fn(() => "/usr/local/bin/openclaw"),
  readConfig: vi.fn(),
  restartGateway: vi.fn(),
}));

vi.mock("@/lib/sqlite-store", () => ({
  sqliteGet: vi.fn(),
  sqliteSet: vi.fn(),
}));

import { getAll } from "@/lib/config-store";
import { inferConfiguredLocalModel, readConfig, restartGateway } from "@/lib/openclaw-config";
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

    vi.mocked(getAll).mockResolvedValue({
      ai_model_provider: "clawai",
      local_ai_provider: "llamacpp",
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
    });
    vi.mocked(readConfig).mockResolvedValue({
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
    expect(body.activeSource).toBe("primary");
    expect(body.activeLabel).toBe("ClawBox AI");
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

  it("switches the active chat model to Local AI and restarts the gateway", async () => {
    vi.mocked(readConfig)
      .mockResolvedValueOnce({
        agents: {
          defaults: {
            model: {
              primary: "deepseek/deepseek-chat",
            },
          },
        },
      } as never)
      .mockResolvedValueOnce({
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
      body: JSON.stringify({ source: "local" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockExec).toHaveBeenCalledWith(
      "/usr/local/bin/openclaw",
      ["config", "set", "agents.defaults.model.primary", "llamacpp/gemma4-e2b-it-q4_0"],
      { timeout: 10000 },
    );
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
        agents: {
          defaults: {
            model: {
              primary: "llamacpp/gemma4-e2b-it-q4_0",
            },
          },
        },
      } as never)
      .mockResolvedValueOnce({
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
      body: JSON.stringify({ source: "primary" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockExec).toHaveBeenCalledWith(
      "/usr/local/bin/openclaw",
      ["config", "set", "agents.defaults.model.primary", "deepseek/deepseek-chat"],
      { timeout: 10000 },
    );
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
});
