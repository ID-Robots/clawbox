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

// The catalogue is told out-of-band when the plugin gate changes the provider
// set; the real module forks `openclaw models list`.
vi.mock("@/app/setup-api/ai-models/catalog/route", () => ({
  notifyProviderSetChanged: vi.fn(),
  refreshInBackground: vi.fn(),
}));
vi.mock("@/lib/openclaw-config", () => ({
  inferConfiguredLocalModel: vi.fn(),
  findOpenclawBin: vi.fn(() => "/usr/local/bin/openclaw"),
  // Strict: the ON half of the plugin gate decides from ABSENCE, and plain
  // `readConfig` cannot tell an unreadable config from one carrying no flag.
  readConfigStrict: vi.fn(async () => ({})),
  readConfig: vi.fn(),
  restartGateway: vi.fn(),
  // The route tells "the gateway has not come back" apart from every other
  // restart failure with `instanceof`, so the mock owes a real class: a plain
  // `vi.fn()` here would make the check itself throw, and leaving the export
  // out makes it `instanceof undefined`.
  GatewayNotReadyError: class GatewayNotReadyError extends Error {
    constructor(message = "gateway did not come back") {
      super(message);
      this.name = "GatewayNotReadyError";
    }
  },
  runOpenclawConfigSet: configSetMock,
  // The route writes the primary in a batch now. Record every assignment of
  // a batch on `runOpenclawConfigSet` too, the way config-set-calls flattens
  // both forms for the configure suites: the assertions here are about which
  // assignments were made, not about how many processes carried them.
  runOpenclawConfigSetBatch: vi.fn(async (ops: string[][]) => {
    for (const op of ops) await configSetMock(op);
  }),
  // The disarm half of the Codex runtime arm. A batch entry carries only
  // value/ref/provider — there is no delete — and a null value is refused by
  // the schema, so removing the key is its own `config unset` spawn.
  runOpenclawConfigUnset: vi.fn(),
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

// TASK-668. The recorded per-provider model counts the catalog route writes
// after each enumeration. Empty by default — nothing recorded is UNKNOWN, and
// unknown changes nothing about the list this route serves.
vi.mock("@/lib/provider-runnable", () => ({
  readProviderRunnable: vi.fn(async () => new Map<string, string>()),
}));

import { getAll } from "@/lib/config-store";
import { GatewayNotReadyError, inferConfiguredLocalModel, readConfig, readConfigStrict, restartGateway, runOpenclawConfigSet, runOpenclawConfigUnset, applyModelOverrideToAllAgentSessions, parseFullyQualifiedModel, setProviderPlugins, runOpenclawConfigSetBatch } from "@/lib/openclaw-config";
import { sqliteGet, sqliteSet } from "@/lib/sqlite-store";
import { notifyProviderSetChanged } from "@/app/setup-api/ai-models/catalog/route";
import { readProviderRunnable } from "@/lib/provider-runnable";
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
      // The row POST /setup-api/providers/default reads for "Make default ->
      // Anthropic" when the box has no Anthropic model of its own.
      "anthropic/claude-opus-5",
      "llamacpp/gemma4-e2b-it-q4_0",
    ]);
  });

  describe("a provider the box can run no model from", () => {
    /** The three-profile box of the test above: ClawBox AI, OpenAI, Anthropic. */
    function threeProviderBox(primary: string) {
      vi.mocked(readConfig).mockResolvedValue({
        auth: {
          profiles: {
            "deepseek:default": { provider: "deepseek", mode: "api_key" },
            "openai:default": { provider: "openai", mode: "token" },
            "anthropic:default": { provider: "anthropic", mode: "token" },
          },
        },
        models: { mode: "replace", providers: {} },
        agents: { defaults: { model: { primary } } },
      } as never);
    }

    it("is not offered, even though its credential is right there", async () => {
      // Under `models.mode: "replace"` the core answers `openclaw models list
      // --provider anthropic` with nothing, so every Anthropic row in this
      // dropdown is a button whose only outcome is a refusal from the gateway.
      threeProviderBox("deepseek/deepseek-v4-flash");
      vi.mocked(readProviderRunnable).mockResolvedValue(
        new Map([["anthropic", "none"], ["openai", "some"]]) as never,
      );

      const body = await (await GET()).json();

      const labels = body.options.map((option: { label: string }) => option.label);
      expect(labels).not.toContain("Anthropic Claude");
      expect(labels).toEqual(expect.arrayContaining(["ClawBox AI", "OpenAI GPT"]));
    });

    it("keeps the row when the model in question is the one the box is running", async () => {
      // The header pill names it. A dropdown that omits the active model shows
      // the customer a model that is in no list.
      threeProviderBox("anthropic/claude-opus-5");
      vi.mocked(readProviderRunnable).mockResolvedValue(
        new Map([["anthropic", "none"]]) as never,
      );

      const body = await (await GET()).json();

      expect(body.options.map((option: { model: string | null }) => option.model))
        .toContain("anthropic/claude-opus-5");
    });

    it("keeps every row when nothing has been recorded", async () => {
      // The false-failure guard: an empty record is "nobody has asked", and
      // beta's list is what it must produce.
      threeProviderBox("deepseek/deepseek-v4-flash");

      const body = await (await GET()).json();

      expect(body.options.map((option: { label: string }) => option.label))
        .toEqual(expect.arrayContaining(["ClawBox AI", "OpenAI GPT", "Anthropic Claude"]));
    });
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

  it("answers 502 when the switch landed but the gateway did not come back", async () => {
    // The primary is already written when the restart runs, so a gateway that
    // never starts listening again is neither the 200 this route used to give
    // (the box still answers on the OLD model) nor the 500 "Failed to switch
    // chat model" the outer catch would give — that would be a false failure
    // over a change that IS on disk.
    vi.mocked(restartGateway).mockRejectedValue(new GatewayNotReadyError());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llamacpp/gemma4-e2b-it-q4_0" }),
    }));
    const body = await response.json();
    errorSpy.mockRestore();

    expect(response.status).toBe(502);
    expect(body.warning).toMatch(/did not come back/i);
    // The switch still happened: the body describes the new model, not an error.
    expect(body.error).toBeUndefined();
    expect(runOpenclawConfigSet).toHaveBeenCalledWith([
      "agents.defaults.model.primary",
      "llamacpp/gemma4-e2b-it-q4_0",
    ]);
  });

  it("answers 502, not 500, when the restart is refused outright", async () => {
    // A masked unit (an update in flight) or a denied sudo is still not a failed
    // switch: the primary is on disk either way, and 500 "Failed to switch chat
    // model" over a written model is the same false failure by another route.
    // The warning distinguishes it, because the owner's next step differs.
    vi.mocked(restartGateway).mockRejectedValue(new Error("Unit is masked"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llamacpp/gemma4-e2b-it-q4_0" }),
    }));
    const body = await response.json();
    errorSpy.mockRestore();

    expect(response.status).toBe(502);
    expect(body.warning).toMatch(/could not be restarted/i);
    expect(body.error).toBeUndefined();
    // Never the raw exec text: it carries unit and path internals.
    expect(JSON.stringify(body)).not.toContain("Unit is masked");
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
      'agents.defaults.models["openai/gpt-5.5"].agentRuntime.id',
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
      'agents.defaults.models["openai/gpt-5.6-sol"].agentRuntime.id',
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

  it("never represents the OpenAI row by the ClawBox AI image entry", async () => {
    // Every paired box carries `gpt-image-1-mini` in models.providers.openai
    // .models[] (the image provider rides the openai plugin), and with an
    // OpenAI key on the box it was the FIRST configured openai model — so the
    // dropdown's OpenAI row was `openai/gpt-image-1-mini`, an image model
    // offered as a chat model that fails on every turn. The row builder now
    // applies the same allowlist the picker does.
    vi.mocked(readConfig).mockResolvedValue({
      auth: {
        profiles: {
          "deepseek:default": { provider: "deepseek", mode: "api_key" },
          "openai:default": { provider: "openai", mode: "api_key" },
        },
      },
      models: {
        mode: "merge",
        providers: {
          deepseek: { models: [{ id: "deepseek-v4-flash", name: "ClawBox AI Flash" }] },
          openai: {
            apiKey: "claw_token123",
            models: [{ id: "gpt-image-1-mini", name: "ClawBox AI Images", baseUrl: "https://clawbox.com/api/ai", api: "openai-completions" }],
          },
        },
      },
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
    } as never);

    const body = await (await GET()).json();

    const openai = body.options.find((option: { provider: string }) => option.provider === "openai");
    expect(openai.model).toBe("openai/gpt-5.4");
    expect(body.options.some((option: { model: string | null }) => option.model?.includes("gpt-image"))).toBe(false);
  });

  it("drops a remembered primary the picker refuses instead of letting it own the row", async () => {
    // An older build could write the image entry as the primary; that box
    // would otherwise show `openai/gpt-image-1-mini` as its OpenAI row
    // forever, because the remembered active model wins the provider's slot.
    // This box carries no other openai row, so the assertion below is
    // satisfied by the hard-coded provider default — the `models[]` filter is
    // covered by "never represents the OpenAI row…" and by the
    // configured-rows test directly below.
    vi.mocked(getAll).mockResolvedValue({ ai_model_provider: "openai" });
    vi.mocked(readConfig).mockResolvedValue({
      auth: {
        profiles: {
          "openai:default": { provider: "openai", mode: "api_key" },
        },
      },
      models: {
        mode: "merge",
        providers: {
          openai: { models: [{ id: "gpt-image-1-mini", name: "ClawBox AI Images", baseUrl: "https://clawbox.com/api/ai", api: "openai-completions" }] },
        },
      },
      agents: { defaults: { model: { primary: "openai/gpt-image-1-mini" } } },
    } as never);

    const body = await (await GET()).json();

    const openai = body.options.find((option: { provider: string }) => option.provider === "openai");
    expect(openai.model).toBe("openai/gpt-5.4");
    expect(body.activeOptionId).toBeNull();
  });

  it("builds the OpenAI row from OpenAI's own default, not the drifting store's provider", async () => {
    // `ai_model_provider` only refreshes at configure-time, so it drifts (#162)
    // — that is why the provider hint comes from the LIVE primary. Resolving
    // the MODEL from the stale store while forcing the hint to the live
    // provider builds a row whose label says OpenAI and whose model belongs to
    // whatever the store last remembered. POST /setup-api/providers/default
    // reads `option.model` off this very row and writes it to the primary.
    vi.mocked(getAll).mockResolvedValue({ ai_model_provider: "clawai" });
    vi.mocked(readConfig).mockResolvedValue({
      auth: { profiles: {} },
      models: { mode: "merge", providers: {} },
      agents: { defaults: { model: { primary: "openai/gpt-image-1-mini" } } },
    } as never);

    const body = await (await GET()).json();

    const openai = body.options.find((option: { provider: string }) => option.provider === "openai");
    expect(openai?.model).toBe("openai/gpt-5.4");
  });

  it("keeps an owner's own openai row that the picker's curation list does not carry", async () => {
    // The catalog allowlist exists to curate a NOISY UPSTREAM catalog down for
    // a picker. `models.providers.openai.models[]` is not that catalog — it is
    // what the owner configured, and this route's own sibling
    // (`foreignOpenAiRoute`) treats a row there as "the owner's own work".
    // Filtering it through the curation regex leaves the row represented by a
    // hard-coded default their endpoint does not serve.
    vi.mocked(getAll).mockResolvedValue({ ai_model_provider: "openai" });
    vi.mocked(readConfig).mockResolvedValue({
      auth: { profiles: { "openai:default": { provider: "openai", mode: "api_key" } } },
      models: {
        mode: "merge",
        providers: {
          openai: {
            baseUrl: "https://myproxy.example/v1",
            models: [{ id: "llama-3.3-70b", name: "Llama 3.3 70B" }],
          },
        },
      },
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
    } as never);

    const body = await (await GET()).json();

    const openai = body.options.find((option: { provider: string }) => option.provider === "openai");
    expect(openai?.model).toBe("openai/llama-3.3-70b");
  });

  it("builds the OpenAI row from the owner's configured rows even when the primary IS the image ref", async () => {
    // The `models[]` filter lives in branch 2 of the row builder, and branch 1
    // — "the active model belongs to this provider" — wins whenever the
    // primary is the image ref, which is exactly the box this guard exists
    // for. The row was then created much later from the hard-coded
    // DEFAULT_PROVIDER_MODELS, never from what the owner actually configured:
    // on a self-hosted openai-compatible endpoint that is an id the endpoint
    // does not serve, and POST /setup-api/providers/default writes it to the
    // primary, so the mismatch is a write and not a display bug.
    vi.mocked(getAll).mockResolvedValue({ ai_model_provider: "openai" });
    vi.mocked(readConfig).mockResolvedValue({
      auth: { profiles: { "openai:default": { provider: "openai", mode: "api_key" } } },
      models: {
        mode: "merge",
        providers: {
          openai: {
            baseUrl: "https://myproxy.example/v1",
            models: [
              { id: "gpt-image-1-mini", name: "ClawBox AI Images", baseUrl: "https://clawbox.com/api/ai" },
              { id: "llama-3.3-70b", name: "Llama 3.3 70B" },
            ],
          },
        },
      },
      agents: { defaults: { model: { primary: "openai/gpt-image-1-mini" } } },
    } as never);

    const body = await (await GET()).json();

    const openai = body.options.find((option: { provider: string }) => option.provider === "openai");
    expect(openai?.model).toBe("openai/llama-3.3-70b");
  });

  it("refuses the image entry at the custom-model door, before any write", async () => {
    // A valid-SHAPED `openai/*` id that every paired box carries in
    // models.providers.openai.models[]; as the primary it fails every turn.
    vi.mocked(readConfig).mockResolvedValue({
      auth: { profiles: { "openai:default": { provider: "openai", mode: "api_key" } } },
      agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
    } as never);

    const response = await POST(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-image-1-mini" }),
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("not a chat model");
    expect(runOpenclawConfigSet).not.toHaveBeenCalled();
    expect(restartGateway).not.toHaveBeenCalled();
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
  // A compat provider's configured entry REPLACES the plugin's catalogue —
  // "configured providers in openclaw.json override the plugin's modelCatalog
  // entirely" (ai-models/configure) — so `openclaw models list --provider
  // google` answers exactly this array. Appending a row to it is therefore the
  // provider's enumeration changing, made by a server-side write, and nothing
  // was counting it: the plugin gate below answers only about the anthropic
  // flag, which this write does not touch.
  describe("registering a compat model the provider did not list", () => {
    const googleBox = (models: { id: string; name: string }[]) => ({
      auth: { profiles: { "google:default": { provider: "google", mode: "api_key" } } },
      models: {
        mode: "merge",
        providers: {
          google: {
            apiKey: "k",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
            api: "openai-completions",
            models,
          },
        },
      },
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-pro" } } },
    });

    const pick = (model: string) => POST(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    }));

    it("counts the change when a row is actually appended", async () => {
      vi.mocked(readConfig).mockResolvedValue(
        googleBox([{ id: "gemini-3-flash", name: "gemini-3-flash" }]) as never,
      );

      const response = await pick("google/gemini-3-pro");

      expect(response.status).toBe(200);
      expect(runOpenclawConfigSet).toHaveBeenCalledWith([
        "models.providers.google.models",
        JSON.stringify([
          { id: "gemini-3-flash", name: "gemini-3-flash" },
          { id: "gemini-3-pro", name: "gemini-3-pro" },
        ]),
        "--json",
      ]);
      expect(vi.mocked(notifyProviderSetChanged)).toHaveBeenCalledWith("google");
    });

    it("says nothing when the model was already listed", async () => {
      // Nothing was written, so nothing changed — announcing here would spend
      // an enumeration on every repeat pick.
      vi.mocked(readConfig).mockResolvedValue(
        googleBox([{ id: "gemini-3-pro", name: "gemini-3-pro" }]) as never,
      );

      const response = await pick("google/gemini-3-pro");

      expect(response.status).toBe(200);
      expect(vi.mocked(notifyProviderSetChanged)).not.toHaveBeenCalled();
    });
  });

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
        body: JSON.stringify({ model: "anthropic/claude-opus-5" }),
      }));
      const body = await response.json();

      expect(body.error).toBeUndefined();
      expect(response.status).toBe(200);
      expect(runOpenclawConfigSetBatch).toHaveBeenCalledWith([
        ENABLE_OP,
        ["agents.defaults.model.primary", "anthropic/claude-opus-5"],
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
        body: JSON.stringify({ model: "anthropic/claude-opus-5" }),
      }));
      const body = await response.json();

      // The batch is #589's and the 409 is #584's, and BOTH have to survive the
      // merge: the plugin enable rides in the batch this wraps, and the owner
      // still gets the model-unresolvable answer instead of the CLI's sentence.
      expect(response.status).toBe(409);
      expect(body.kind).toBe("model_unresolvable");
      expect(body.error).not.toMatch(/openclaw models list|Cannot set model reference/);
      expect(runOpenclawConfigSet).not.toHaveBeenCalledWith(expect.arrayContaining([ENABLE_OP[0]]));
      expect(setProviderPlugins).not.toHaveBeenCalled();
      expect(restartGateway).not.toHaveBeenCalled();
    });

    // A plugin that is off enumerates NOTHING, so switching it back on is the
    // same provider-set change as switching it off — in the other direction,
    // in this same file, and the catalogue was told about neither. It is also
    // the change nothing could see: the enable rides in the batch, so by the
    // time the OFF half re-reads the config the flag is already true and it
    // correctly reports no flip. Unanswered it is not a one-off staleness
    // either — an empty enumeration is recorded as a failed refresh whose wait
    // DOUBLES up to the six-hour interval, so a provider whose plugin has been
    // off for a while is not re-asked for six hours after the pick that made
    // it listable.
    describe("counting the ON half for the catalogue", () => {
      // The handler's state comes from `readConfig`; the ON half reads the flag
      // again, STRICTLY, at the last moment before the batch — so both are set
      // here, and the strict one is what decides the announcement.
      const pluginOff = (enabled: boolean) => {
        const config = {
          auth: {
            profiles: {
              "deepseek:default": { provider: "deepseek", mode: "api_key" },
              "anthropic:default": { provider: "anthropic", mode: "api_key" },
            },
          },
          agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
          plugins: { entries: { anthropic: { enabled } } },
        };
        vi.mocked(readConfig).mockResolvedValue(config as never);
        vi.mocked(readConfigStrict).mockResolvedValue(config as never);
      };

      it("counts the change when the batch switched the plugin on", async () => {
        pluginOff(false);

        const response = await POST(new Request("http://localhost/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "anthropic/claude-opus-5" }),
        }));

        expect(response.status).toBe(200);
        expect(vi.mocked(notifyProviderSetChanged)).toHaveBeenCalledWith("anthropic");
      });

      it("says nothing when the plugin was already on", async () => {
        // The enable op is emitted either way — it is what makes the core
        // validate the reference — so its presence is not a state change.
        // Announcing one per Claude pick would spend a ~3-minute `openclaw
        // models list` on a Jetson for a box that did not change.
        pluginOff(true);

        const response = await POST(new Request("http://localhost/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "anthropic/claude-opus-5" }),
        }));

        expect(response.status).toBe(200);
        expect(vi.mocked(notifyProviderSetChanged)).not.toHaveBeenCalled();
      });

      it("counts it when the flag could not be read at all", async () => {
        // The strict read throws on an EACCES or a config caught half-written,
        // and the batch still lands. Unknown is not "already on": silence would
        // leave the catalogue on the pre-enable enumeration, whose failed-
        // refresh wait doubles toward six hours.
        pluginOff(true);
        vi.mocked(readConfigStrict).mockRejectedValue(new Error("EACCES"));

        const response = await POST(new Request("http://localhost/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "anthropic/claude-opus-5" }),
        }));

        expect(response.status).toBe(200);
        expect(vi.mocked(notifyProviderSetChanged)).toHaveBeenCalledWith("anthropic");
      });

      it("says nothing when the batch was refused", async () => {
        // Atomic: a refused batch is applied to one snapshot and validated as
        // a whole, so the flag is exactly where it was. Counting here would be
        // this route's own false success.
        pluginOff(false);
        vi.mocked(runOpenclawConfigSetBatch).mockRejectedValue(new Error(UNKNOWN_MODEL));

        const response = await POST(new Request("http://localhost/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "anthropic/claude-opus-5" }),
        }));

        expect(response.status).toBe(409);
        expect(vi.mocked(notifyProviderSetChanged)).not.toHaveBeenCalled();
      });
    });

    it("carries the plugin enable inside the try that answers the 409", async () => {
      // Pins the merge shape itself: one batch, enable ahead of the primary,
      // and the refusal converted. Taking either side wholesale loses one of
      // the two — silently, because each side's own tests still pass.
      vi.mocked(runOpenclawConfigSetBatch).mockRejectedValue(new Error(UNKNOWN_MODEL));

      await POST(new Request("http://localhost/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "anthropic/claude-opus-5" }),
      }));

      const batch = vi.mocked(runOpenclawConfigSetBatch).mock.calls.at(-1)?.[0] as string[][];
      expect(batch[0]).toEqual(ENABLE_OP);
      expect(batch.some((op) => op[0] === "agents.defaults.model.primary")).toBe(true);
      expect(batch.findIndex((op) => op[0] === ENABLE_OP[0]))
        .toBeLessThan(batch.findIndex((op) => op[0] === "agents.defaults.model.primary"));
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

    // A box holding BOTH OpenAI credentials — the ChatGPT sign-in and an API
    // key — is the state the namespace used to disambiguate for free. Under
    // `openai/<id>` the reference says nothing, so every one of these
    // decisions has to come from the ROW the pick was made on.
    const DUAL_BOX = {
      auth: {
        profiles: {
          "openai:default": { provider: "openai", mode: "api_key" },
          "openai:chatgpt": { provider: "openai", mode: "oauth" },
        },
      },
      agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
    };

    it("keeps the API-key row separate when the box holds both", async () => {
      vi.mocked(readConfig).mockResolvedValue(DUAL_BOX as never);

      const body = await (await GET()).json();

      const providers = body.options.map((option: { provider: string }) => option.provider);
      expect(providers).toContain("openai");
      expect(providers).toContain("codex");
      // The API-key row is NOT subscription-routed — its `-pro` tiers work.
      expect(body.subscriptionProviders).not.toContain("openai");
      // The ChatGPT row is, whatever else the box holds: a turn on it goes to
      // the ChatGPT account, which refuses the API-only tiers.
      expect(body.subscriptionProviders).toContain("codex");
    });

    it("arms the runtime for a pick made on the ChatGPT row of a dual box", async () => {
      vi.mocked(readConfig).mockResolvedValue(DUAL_BOX as never);

      const response = await post({ model: "openai/gpt-5.5", provider: "codex" });

      expect(response.status).toBe(200);
      expect(runOpenclawConfigSet).toHaveBeenCalledWith(["agents.defaults.model.primary", "openai/gpt-5.5"]);
      // Without this entry the turn leaves the ChatGPT account for
      // api.openai.com and the box silently spends the API key instead.
      expect(runOpenclawConfigSet).toHaveBeenCalledWith([
        'agents.defaults.models["openai/gpt-5.5"].agentRuntime.id',
        "codex",
      ]);
    });

    // The arm was WRITE-ONLY: two routes added it and the only remover is
    // gateway-pre-start's v1-gated cleanup, so on the pinned core nothing on
    // the box cleared it. Harmless while it could only sit on a `codex/<id>`
    // key no other lane could name — not harmless now that both OpenAI lanes
    // write `openai/<id>`, because the leftover keeps sending the SAME
    // reference through the ChatGPT account after the owner picks the API-key
    // row, and the header pill flips back on the next GET.
    const ARMED_DUAL_BOX = {
      ...DUAL_BOX,
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
        },
      },
    };

    it("clears the runtime arm when the same model is picked on the API-key row", async () => {
      vi.mocked(readConfig).mockResolvedValue(ARMED_DUAL_BOX as never);

      const response = await post({ model: "openai/gpt-5.5", provider: "openai" });

      expect(response.status).toBe(200);
      expect(runOpenclawConfigUnset).toHaveBeenCalledWith(
        'agents.defaults.models["openai/gpt-5.5"].agentRuntime',
      );
    });

    it("clears it on the same-model no-op door too", async () => {
      // Already the primary AND armed: the old repair was one-sided, so this
      // returned 200 having changed nothing while the turn stayed on the
      // subscription.
      const armedNow = {
        ...DUAL_BOX,
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          },
        },
      };
      // The disarm changes the file, so the answer's re-read sees it gone —
      // the request must not report the row it just moved the owner off.
      vi.mocked(readConfig)
        .mockResolvedValueOnce(armedNow as never)
        .mockResolvedValue({
          ...DUAL_BOX,
          agents: { defaults: { model: { primary: "openai/gpt-5.5" }, models: {} } },
        } as never);

      const response = await post({ model: "openai/gpt-5.5", provider: "openai" });

      expect(response.status).toBe(200);
      expect(runOpenclawConfigUnset).toHaveBeenCalledWith(
        'agents.defaults.models["openai/gpt-5.5"].agentRuntime',
      );
      await expect(response.json()).resolves.toMatchObject({ activeLabel: "OpenAI GPT" });
    });

    it("says so instead of answering clean when the disarm fails", async () => {
      // A 200 that looks like a switch, over a box still routing that model to
      // the ChatGPT account, is the false success this whole finding is about.
      vi.mocked(readConfig).mockResolvedValue(ARMED_DUAL_BOX as never);
      vi.mocked(runOpenclawConfigUnset).mockRejectedValue(new Error("config unset failed"));

      const response = await post({ model: "openai/gpt-5.5", provider: "openai" });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.warning).toMatch(/still routes it through your ChatGPT account/);
    });

    it("leaves the arm alone when the pick IS the subscription's", async () => {
      vi.mocked(readConfig).mockResolvedValue(ARMED_DUAL_BOX as never);

      await post({ model: "openai/gpt-5.5", provider: "codex" });

      expect(runOpenclawConfigUnset).not.toHaveBeenCalled();
    });

    it("writes the arm on a config path the CLI can actually parse", async () => {
      // The CLI's path grammar splits an unquoted segment on `.`, and every
      // ChatGPT model id carries one, so the dotted form is read as
      // `models -> "openai/gpt-5" -> "5"` and answers
      // `Config validation failed: ... Unrecognized key: "5"` — taking the
      // whole batch, primary included, with it. Bracket-quoted is the form the
      // CLI itself echoes back. Measured on the pinned 2026.8.1 core.
      vi.mocked(readConfig).mockResolvedValue(CHATGPT_BOX as never);

      await post({ model: "openai/gpt-5.4-mini" });

      const batch = vi.mocked(runOpenclawConfigSetBatch).mock.calls.at(-1)?.[0] as string[][];
      const arm = batch.find((op) => op[0].includes("agentRuntime"));
      expect(arm?.[0]).toBe('agents.defaults.models["openai/gpt-5.4-mini"].agentRuntime.id');
      expect(arm?.[0]).not.toContain("models.openai/");
    });

    it("attributes an armed openai/<id> to the ChatGPT row, not the API-key one", async () => {
      // The pill flipped to "OpenAI GPT" the moment the owner picked ChatGPT,
      // because the GET could only read the namespace back.
      vi.mocked(readConfig).mockResolvedValue({
        ...DUAL_BOX,
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          },
        },
      } as never);

      const body = await (await GET()).json();

      expect(body.activeLabel).toBe("OpenAI Codex");
      const codexRow = body.options.find((option: { provider: string }) => option.provider === "codex");
      expect(codexRow.model).toBe("openai/gpt-5.5");
      const openaiRow = body.options.find((option: { provider: string }) => option.provider === "openai");
      expect(openaiRow.model).not.toBe("openai/gpt-5.5");
    });

    it("refuses an API-only tier picked on the ChatGPT row of a dual box", async () => {
      vi.mocked(readConfig).mockResolvedValue(DUAL_BOX as never);

      const response = await post({ model: "openai/gpt-5.5-pro", provider: "codex" });

      expect(response.status).toBe(400);
      const refusal = await response.json();
      // Names the lever the owner has NOT pulled. This box HOLDS an API key,
      // so "switch to API-key mode" would name one they already have; the
      // actionable step is the other row, which routes this very model.
      expect(refusal.error).toContain("Pick it on the OpenAI GPT row instead");
      expect(refusal.error).not.toContain("requires OpenAI API-key mode");
      // The supported list is built from the catalogue, so the GPT-5.6
      // generation the allowlist accepts cannot fall out of the sentence.
      expect(refusal.error).toContain("GPT-5.6 Sol");
      expect(runOpenclawConfigSet).not.toHaveBeenCalled();
    });

    it("still lets the API-key row run an API-only tier on the same box", async () => {
      vi.mocked(readConfig).mockResolvedValue(DUAL_BOX as never);

      const response = await post({ model: "openai/gpt-5.5-pro", provider: "openai" });

      expect(response.status).toBe(200);
      expect(runOpenclawConfigSet).toHaveBeenCalledWith(["agents.defaults.model.primary", "openai/gpt-5.5-pro"]);
      expect(runOpenclawConfigSet).not.toHaveBeenCalledWith([
        'agents.defaults.models["openai/gpt-5.5-pro"].agentRuntime.id',
        "codex",
      ]);
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
        'agents.defaults.models["openai/gpt-5.5"].agentRuntime.id',
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
