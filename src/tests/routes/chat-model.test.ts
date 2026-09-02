import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

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

const { configSetMock } = vi.hoisted(() => ({ configSetMock: vi.fn() }));

vi.mock("@/lib/openclaw-config", () => ({
  inferConfiguredLocalModel: vi.fn(),
  findOpenclawBin: vi.fn(() => "/usr/local/bin/openclaw"),
  readConfig: vi.fn(),
  restartGateway: vi.fn(),
  runOpenclawConfigSet: configSetMock,
  // The route writes the primary in a batch now. Record every assignment of
  // a batch on `runOpenclawConfigSet` too, the way config-set-calls flattens
  // both forms for the configure suites: the assertions here are about which
  // assignments were made, not about how many processes carried them.
  runOpenclawConfigSetBatch: vi.fn(async (ops: string[][]) => {
    for (const op of ops) await configSetMock(op);
  }),
  applyModelOverrideToAllAgentSessions: vi.fn(),
  parseFullyQualifiedModel: vi.fn(),
  // Plugin gating: the route switches the plugin the new primary needs ON
  // before writing `agents.defaults.model.primary` and gates the rest OFF
  // after it. The ordering suite at the bottom asserts on both halves; every
  // other test only needs the imports to resolve.
  setProviderPlugins: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/sqlite-store", () => ({
  sqliteGet: vi.fn(),
  sqliteSet: vi.fn(),
}));

import { getAll } from "@/lib/config-store";
import { inferConfiguredLocalModel, readConfig, restartGateway, runOpenclawConfigSet, applyModelOverrideToAllAgentSessions, parseFullyQualifiedModel, setProviderPlugins, runOpenclawConfigSetBatch } from "@/lib/openclaw-config";
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
    vi.mocked(applyModelOverrideToAllAgentSessions).mockResolvedValue({ filesUpdated: 0, sessionsUpdated: 0, sessionsSkipped: 0 });
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
      models: {
        mode: "merge",
        providers: {
          deepseek: {
            models: [
              { id: "deepseek-v4-flash", name: "ClawBox AI Flash" },
              { id: "deepseek-v4-pro", name: "ClawBox AI Pro" },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "deepseek/deepseek-v4-pro",
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

  it("surfaces ClawBox AI as a single provider row alongside Local AI", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    // After consolidating ClawBox AI into one provider row (model
    // variants live in the secondary picker), the active option's id
    // is the active model id and the row's label is the bare provider
    // name — Flash/Pro distinction is no longer encoded in the option's
    // label.
    expect(body.activeOptionId).toBe("deepseek/deepseek-v4-pro");
    expect(body.activeSource).toBe("primary");
    expect(body.activeLabel).toBe("ClawBox AI");
    expect(body.options).toEqual([
      {
        id: "deepseek/deepseek-v4-pro",
        label: "ClawBox AI",
        model: "deepseek/deepseek-v4-pro",
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
    expect(body.local).toEqual({
      available: true,
      label: "Gemma 4 Local",
      model: "llamacpp/gemma4-e2b-it-q4_0",
    });
    expect(sqliteSet).toHaveBeenCalledWith("chat:primary-provider-model", "deepseek/deepseek-v4-pro");
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
      models: {
        mode: "merge",
        providers: {
          deepseek: {
            models: [
              { id: "deepseek-v4-flash", name: "ClawBox AI Flash" },
              { id: "deepseek-v4-pro", name: "ClawBox AI Pro" },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "deepseek/deepseek-v4-flash",
          },
        },
      },
    } as never);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    // One row per provider after consolidation. ClawBox AI Flash
    // (the active model in this fixture) carries the row's `model`
    // field; the secondary model picker handles tier switching.
    // OpenAI default is gpt-5.4 since the curated picker drops 4.1/5.1-5.3.
    expect(body.options.map((option: { label: string }) => option.label)).toEqual([
      "ClawBox AI",
      "OpenAI GPT",
      "Anthropic Claude",
      "Gemma 4 Local",
    ]);
    expect(body.options.map((option: { model: string | null }) => option.model)).toEqual([
      "deepseek/deepseek-v4-flash",
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-5",
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

  it("does not arm the Codex runtime for a non-Codex model", async () => {
    await POST(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llamacpp/gemma4-e2b-it-q4_0" }),
    }));

    const armed = vi.mocked(runOpenclawConfigSet).mock.calls.some(
      ([args]) => Array.isArray(args) && String(args[0]).includes("agentRuntime"),
    );
    expect(armed).toBe(false);
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
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.ai/api/v1",
              api: "openai-completions",
              apiKey: "sk-or-v1-test",
              models: [{ id: "anthropic/claude-haiku-4-5", name: "anthropic/claude-haiku-4-5" }],
            },
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
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.ai/api/v1",
              api: "openai-completions",
              apiKey: "sk-or-v1-test",
              models: [{ id: "anthropic/claude-haiku-4-5", name: "anthropic/claude-haiku-4-5" }],
            },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openrouter/mistralai/mistral-large",
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
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.ai/api/v1",
              api: "openai-completions",
              apiKey: "sk-or-v1-test",
              models: [{ id: "anthropic/claude-haiku-4-5", name: "anthropic/claude-haiku-4-5" }],
            },
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

  it("rejects ChatGPT subscription Pro/API-only Codex models before gateway restart", async () => {
    vi.mocked(readConfig).mockResolvedValue({
      auth: { profiles: { "openai:chatgpt": { provider: "openai", mode: "oauth" } } },
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    } as never);
    const response = await POST(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-5.5-pro" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("not supported with ChatGPT subscription auth");
    expect(runOpenclawConfigSet).not.toHaveBeenCalled();
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("rejects legacy OpenAI Pro picks when only ChatGPT subscription auth is configured", async () => {
    vi.mocked(readConfig).mockResolvedValue({
      auth: {
        profiles: {
          "openai:chatgpt": { provider: "openai", mode: "oauth" },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
          },
        },
      },
    } as never);

    const response = await POST(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.5-pro" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("requires OpenAI API-key mode");
    expect(runOpenclawConfigSet).not.toHaveBeenCalled();
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("routes legacy OpenAI GPT-5.5 picks through Codex when ChatGPT subscription auth is configured", async () => {
    vi.mocked(readConfig).mockResolvedValue({
      auth: {
        profiles: {
          "openai:chatgpt": { provider: "openai", mode: "oauth" },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
          },
        },
      },
    } as never);

    const response = await POST(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.5" }),
    }));

    expect(response.status).toBe(200);
    expect(runOpenclawConfigSet).toHaveBeenCalledWith([
      "agents.defaults.model.primary",
      "openai/gpt-5.5",
    ]);
    // ...and it is the ChatGPT account, not an API key, that runs it: the
    // Codex runtime is armed on the canonical reference.
    expect(runOpenclawConfigSet).toHaveBeenCalledWith([
      "agents.defaults.models.openai/gpt-5.5.agentRuntime.id",
      "codex",
    ]);
    expect(applyModelOverrideToAllAgentSessions).toHaveBeenCalledWith(
      {
        provider: "openai",
        modelId: "gpt-5.5",
        source: "user",
      },
      { skipUserTagged: false },
    );
    expect(restartGateway).toHaveBeenCalled();
  });

  it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
    "accepts Codex %s on ChatGPT subscription auth",
    async (modelId) => {
      vi.mocked(readConfig).mockResolvedValue({
        auth: {
          profiles: {
            "openai:chatgpt": { provider: "openai", mode: "oauth" },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4",
            },
          },
        },
      } as never);

      const response = await POST(new Request("http://localhost/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `codex/${modelId}` }),
      }));

      expect(response.status).toBe(200);
      // Posted under the retired `codex/` namespace (a stale tab); written
      // where OpenClaw 2 resolves it.
      expect(runOpenclawConfigSet).toHaveBeenCalledWith([
        "agents.defaults.model.primary",
        `openai/${modelId}`,
      ]);
      expect(restartGateway).toHaveBeenCalled();
    },
  );

  it("routes OpenAI GPT-5.6 Sol picks through Codex when ChatGPT subscription auth is configured", async () => {
    vi.mocked(readConfig).mockResolvedValue({
      auth: {
        profiles: {
          "openai:chatgpt": { provider: "openai", mode: "oauth" },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
          },
        },
      },
    } as never);

    const response = await POST(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.6-sol" }),
    }));

    expect(response.status).toBe(200);
    expect(runOpenclawConfigSet).toHaveBeenCalledWith([
      "agents.defaults.model.primary",
      "openai/gpt-5.6-sol",
    ]);
    expect(runOpenclawConfigSet).toHaveBeenCalledWith([
      "agents.defaults.models.openai/gpt-5.6-sol.agentRuntime.id",
      "codex",
    ]);
    expect(restartGateway).toHaveBeenCalled();
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

  describe("the owner's per-provider switch", () => {
    beforeEach(() => {
      vi.mocked(getAll).mockResolvedValue({
        ai_model_provider: "clawai",
        local_ai_provider: "llamacpp",
        local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
        ai_disabled_providers: ["anthropic"],
      });
      vi.mocked(readConfig).mockResolvedValue({
        auth: {
          profiles: {
            "deepseek:default": { provider: "deepseek", mode: "api_key" },
            "anthropic:default": { provider: "anthropic", mode: "token" },
          },
        },
        agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
      } as never);
    });

    it("keeps a switched-off provider in the list, greyed and carrying the reason", async () => {
      // Not dropped: a row that vanishes reads as "not connected" and sends
      // the owner to re-enter a key that is fine.
      const body = await (await GET()).json();

      const anthropic = body.options.find((option: { provider: string }) => option.provider === "anthropic");
      expect(anthropic).toMatchObject({ available: false, disabledByOwner: true });
      const clawai = body.options.find((option: { provider: string }) => option.provider === "clawai");
      expect(clawai.available).toBe(true);
      expect(clawai).not.toHaveProperty("disabledByOwner");
    });

    it("refuses to switch to a model on a switched-off provider, before any write", async () => {
      const response = await POST(new Request("http://localhost/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "anthropic/claude-sonnet-5" }),
      }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ kind: "provider_disabled", provider: "anthropic" });
      expect(runOpenclawConfigSet).not.toHaveBeenCalled();
      expect(restartGateway).not.toHaveBeenCalled();
    });
  });

  // OpenClaw 2 validates a model reference on `config set` against the
  // captured catalogs of the ENABLED plugins, and an older gate switched the
  // anthropic plugin off on every switch away from Claude. The switch BACK was
  // then refused straight to the owner — `Unknown model:
  // anthropic/claude-sonnet-5` — because this route wrote the primary first
  // and enabled the plugin after. (2026.7.x answered from the bundled catalog
  // regardless of plugin state, which is why the order never mattered before
  // the core upgrade.) The enable now rides in the SAME batch as the primary,
  // ahead of it: the core applies a batch to one snapshot and validates the
  // references afterwards, so one spawn does both, and a refused batch leaves
  // the flag as it was.
  describe("the anthropic plugin around the primary write", () => {
    const UNKNOWN_MODEL =
      'Cannot set model reference "anthropic/claude-sonnet-5" at agents.defaults.model.primary: '
      + "Unknown model: anthropic/claude-sonnet-5. Run openclaw models list to list available models.";
    const ENABLE_OP = ["plugins.entries.anthropic.enabled", "true", "--json"];

    /** Where in vitest's global call sequence the first call `pick` accepts sits. */
    function orderOf(mock: Mock, pick: (args: unknown[]) => boolean = () => true): number {
      const index = mock.mock.calls.findIndex((args) => pick(args));
      expect(index).toBeGreaterThanOrEqual(0);
      return mock.mock.invocationCallOrder[index];
    }

    const isPrimaryWrite = (op: string[]) => op[0] === "agents.defaults.model.primary";
    /** The batch call that carries the primary, as vitest records it: `[ops]`. */
    const carriesPrimary = (call: unknown[]) => (call[0] as string[][]).some(isPrimaryWrite);

    beforeEach(() => {
      vi.mocked(readConfig).mockResolvedValue({
        auth: {
          profiles: {
            "deepseek:default": { provider: "deepseek", mode: "api_key" },
            "anthropic:default": { provider: "anthropic", mode: "api_key" },
          },
        },
        agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
      } as never);

      // The CLI as a 2026.8.1 box answers it: the anthropic plugin is OFF
      // (an older gate switched it off on the last switch away from Claude)
      // and a batch carrying an `anthropic/*` primary is refused unless the
      // same batch switches the plugin on ahead of it.
      vi.mocked(runOpenclawConfigSetBatch).mockImplementation(async (ops) => {
        const enableIdx = ops.findIndex((op) => op[0] === ENABLE_OP[0] && op[1] === "true");
        const primaryIdx = ops.findIndex((op) => isPrimaryWrite(op) && String(op[1]).startsWith("anthropic/"));
        if (primaryIdx >= 0 && !(enableIdx >= 0 && enableIdx < primaryIdx)) throw new Error(UNKNOWN_MODEL);
        if (ops.length === 1) await vi.mocked(runOpenclawConfigSet)(ops[0]);
      });
    });

    it("switches the plugin on in the SAME batch as the Anthropic primary, ahead of it, and restarts after", async () => {
      const response = await POST(new Request("http://localhost/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "anthropic/claude-sonnet-5" }),
      }));
      const body = await response.json();

      expect(body.error).toBeUndefined();
      expect(response.status).toBe(200);
      expect(runOpenclawConfigSetBatch).toHaveBeenCalledWith([
        ENABLE_OP,
        ["agents.defaults.model.primary", "anthropic/claude-sonnet-5"],
      ]);
      // A plugin enabled by the batch loads on the next gateway start, so the
      // restart that already follows the switch has to stay after it.
      expect(orderOf(vi.mocked(runOpenclawConfigSetBatch), carriesPrimary)).toBeLessThan(orderOf(vi.mocked(restartGateway)));
      expect(restartGateway).toHaveBeenCalledTimes(1);
    });

    it("leaves the plugin and the gateway alone when the batch is refused", async () => {
      // Atomic: a refused batch changed nothing, so there is nothing to put
      // back and nothing to restart — the owner gets the refusal, unmasked.
      vi.mocked(runOpenclawConfigSetBatch).mockRejectedValue(new Error(UNKNOWN_MODEL));

      const response = await POST(new Request("http://localhost/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "anthropic/claude-sonnet-5" }),
      }));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain("Unknown model: anthropic/claude-sonnet-5");
      expect(runOpenclawConfigSet).not.toHaveBeenCalledWith(expect.arrayContaining([ENABLE_OP[0]]));
      expect(setProviderPlugins).not.toHaveBeenCalled();
      expect(restartGateway).not.toHaveBeenCalled();
    });

    it("keeps the OFF half of the gate AFTER the write when the new primary is not Anthropic", async () => {
      // The OFF half (off only when nothing on the box could use the plugin)
      // stays where it was: never before the write, so a plugin whose model IS
      // the current primary is not switched off under it.
      const response = await POST(new Request("http://localhost/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "llamacpp/gemma4-e2b-it-q4_0" }),
      }));
      expect(response.status).toBe(200);

      const writtenAt = orderOf(vi.mocked(runOpenclawConfigSetBatch), carriesPrimary);
      const gatedAt = orderOf(vi.mocked(setProviderPlugins), (args) => args[0] === "llamacpp");
      expect(writtenAt).toBeLessThan(gatedAt);
      expect(gatedAt).toBeLessThan(orderOf(vi.mocked(restartGateway)));
    });
  });

  // OpenClaw 2 has no `codex/` model namespace: the ChatGPT subscription is an
  // OAuth profile of the openai provider and the model is `openai/<id>` with
  // the Codex runtime armed on it (src/lib/chatgpt-subscription.ts). The
  // picker used to offer `codex/gpt-5.5` and the write was refused with the
  // CLI's own sentence; a box signed in before the upgrade holds a
  // `codex:default` the core never consults.
  describe("the ChatGPT subscription on OpenClaw 2", () => {
    const CHATGPT_BOX = {
      auth: {
        profiles: {
          "deepseek:default": { provider: "deepseek", mode: "api_key" },
          "openai:chatgpt": { provider: "openai", mode: "oauth" },
        },
      },
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
    };
    const LEGACY_BOX = {
      auth: {
        profiles: {
          "deepseek:default": { provider: "deepseek", mode: "api_key" },
          "codex:default": { provider: "codex", mode: "oauth" },
        },
      },
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
    };
    const post = (body: unknown) => POST(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));

    it("offers the ChatGPT row as openai/<id>, never in the retired namespace", async () => {
      vi.mocked(readConfig).mockResolvedValue(CHATGPT_BOX as never);

      const body = await (await GET()).json();

      const row = body.options.find((option: { provider: string }) => option.provider === "codex");
      expect(row).toMatchObject({ label: "OpenAI Codex", model: "openai/gpt-5.5", available: true });
      expect(body.options.some((option: { model: string | null }) => option.model?.startsWith("codex/"))).toBe(false);
      // No API key on this box, so `openai/*` IS the subscription: no second
      // "OpenAI GPT" row, and the header pill knows it is on a subscription.
      expect(body.options.some((option: { provider: string }) => option.provider === "openai")).toBe(false);
      expect(body.subscriptionProviders).toContain("codex");
    });

    it("keeps the API-key row separate when the box holds both", async () => {
      vi.mocked(readConfig).mockResolvedValue({
        auth: {
          profiles: {
            "openai:default": { provider: "openai", mode: "api_key" },
            "openai:chatgpt": { provider: "openai", mode: "oauth" },
          },
        },
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
      } as never);

      const body = await (await GET()).json();

      const providers = body.options.map((option: { provider: string }) => option.provider);
      expect(providers).toContain("openai");
      expect(providers).toContain("codex");
      expect(body.subscriptionProviders).not.toContain("codex");
    });

    it("offers a sign-in the core cannot use greyed, with the reason, instead of a pick that fails", async () => {
      vi.mocked(readConfig).mockResolvedValue(LEGACY_BOX as never);

      const body = await (await GET()).json();

      const row = body.options.find((option: { provider: string }) => option.provider === "codex");
      expect(row).toMatchObject({ available: false, reauthRequired: true, model: "openai/gpt-5.5" });
    });

    it("greys the row even when the primary is still written as codex/<id> — the sign-in cannot run it", async () => {
      // The active model registers its row available before the profile loop
      // runs; a box upgraded with `codex/gpt-5.5` as primary AND only the old
      // sign-in showed an available row with no reason, and the pick then 409ed.
      vi.mocked(readConfig).mockResolvedValue({
        ...LEGACY_BOX,
        agents: { defaults: { model: { primary: "codex/gpt-5.5" } } },
      } as never);

      const body = await (await GET()).json();

      const row = body.options.find((option: { provider: string }) => option.provider === "codex");
      expect(row).toMatchObject({ available: false, reauthRequired: true, model: "codex/gpt-5.5" });
    });

    it("refuses a pick on a sign-in the core cannot use with the next step, before any write", async () => {
      vi.mocked(readConfig).mockResolvedValue(LEGACY_BOX as never);

      const response = await post({ model: "codex/gpt-5.5" });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ kind: "chatgpt_reauth_required", provider: "codex" });
      expect(runOpenclawConfigSet).not.toHaveBeenCalled();
      expect(restartGateway).not.toHaveBeenCalled();
    });

    it("arms the Codex runtime on a same-model pick when the entry is missing — the only repair short of a reboot", async () => {
      // A stale tab posts `codex/gpt-5.5`; the primary IS `openai/gpt-5.5`
      // already, but nothing armed its runtime (an older ClawBox wrote the
      // primary, or the entry was lost). The remap made this a no-op answer
      // that left every turn failing.
      vi.mocked(readConfig).mockResolvedValue({
        ...CHATGPT_BOX,
        agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      } as never);

      const response = await post({ model: "codex/gpt-5.5" });

      expect(response.status).toBe(200);
      expect(runOpenclawConfigSet).toHaveBeenCalledWith([
        "agents.defaults.models.openai/gpt-5.5.agentRuntime.id",
        "codex",
      ]);
      expect(runOpenclawConfigSet).not.toHaveBeenCalledWith(expect.arrayContaining(["agents.defaults.model.primary"]));
    });

    it("leaves an armed same-model pick free of any write", async () => {
      vi.mocked(readConfig).mockResolvedValue({
        ...CHATGPT_BOX,
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          },
        },
      } as never);

      const response = await post({ model: "openai/gpt-5.5" });

      expect(response.status).toBe(200);
      expect(runOpenclawConfigSet).not.toHaveBeenCalled();
      expect(restartGateway).not.toHaveBeenCalled();
    });

    it("answers a reference the core refuses with the provider and a next step, not the CLI's sentence", async () => {
      vi.mocked(readConfig).mockResolvedValue(CHATGPT_BOX as never);
      vi.mocked(runOpenclawConfigSet).mockRejectedValue(new Error(
        'Cannot set model reference "openai/gpt-5.5" at agents.defaults.model.primary: '
        + "Unknown model: openai/gpt-5.5. Run openclaw models list to list available models.",
      ));

      const response = await post({ model: "openai/gpt-5.5" });
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.kind).toBe("model_unresolvable");
      expect(body.error).not.toMatch(/openclaw models list|Cannot set model reference/);
      expect(body.error).toMatch(/OpenAI Codex does not list gpt-5.5/);
      expect(restartGateway).not.toHaveBeenCalled();
    });
  });
});
