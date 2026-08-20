import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import fsp from "fs/promises";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import {
  CLAWBOX_AI_IMAGE_MODEL,
  CLAWBOX_AI_IMAGE_MODEL_ID,
  CLAWBOX_AI_IMAGE_MODEL_LABEL,
} from "@/lib/clawbox-ai-models";

// The ClawBox AI image-provider half of POST /setup-api/ai-models/configure
// (TASK-413). Without it a provisioned box cannot generate an image at all:
// OpenClaw registers `image_generate` only when an image-generation provider is
// configured, and ClawBox provisioning configured none.
//
// Mocks are the same set configure.test.ts uses — the route's collaborators,
// with `runOpenclawConfigSet` as the boundary every `openclaw config set` goes
// through, so the assertions below are about the exact commands the route runs.

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
    unlink: vi.fn(),
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

// Out-of-band catalog refresh the route deliberately does not await; stubbing
// it stops its late console write from racing worker teardown. See the long
// note in configure.test.ts.
vi.mock("@/app/setup-api/ai-models/catalog/route", () => ({
  refreshInBackground: vi.fn(),
}));

const { parseFullyQualifiedModelImpl, LLAMACPP_PROXY_BASE_URL } = vi.hoisted(() => ({
  parseFullyQualifiedModelImpl(fq: string) {
    const idx = fq.indexOf("/");
    if (idx <= 0 || idx === fq.length - 1) return null;
    return { provider: fq.slice(0, idx), modelId: fq.slice(idx + 1) };
  },
  LLAMACPP_PROXY_BASE_URL: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
}));

vi.mock("@/lib/openclaw-config", () => ({
  DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR: 24000,
  compactionReserveFloorForContext: (contextWindow: number) =>
    Number.isFinite(contextWindow) && contextWindow > 0
      ? Math.min(24000, Math.max(4096, Math.round(contextWindow / 4)))
      : 24000,
  restartGateway: vi.fn(),
  findOpenclawBin: vi.fn().mockReturnValue("/usr/local/bin/openclaw"),
  readConfig: vi.fn(),
  inferConfiguredLocalModel: vi.fn(),
  runOpenclawConfigSet: vi.fn(),
  applyModelOverrideToAllAgentSessions: vi.fn().mockResolvedValue(undefined),
  parseFullyQualifiedModel: vi.fn(parseFullyQualifiedModelImpl),
  setProviderPlugins: vi.fn().mockResolvedValue(undefined),
  openclawIsAbsent: vi.fn().mockReturnValue(false),
  OpenclawUnavailableError: class OpenclawUnavailableError extends Error {},
}));

vi.mock("@/lib/llamacpp", () => ({
  getDefaultLlamaCppModel: vi.fn().mockReturnValue("gemma4-e2b-it-q4_0"),
  getLlamaCppContextWindow: vi.fn().mockReturnValue(131072),
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
  getLocalAiToken: vi.fn().mockReturnValue("a".repeat(64)),
  verifyLocalAiBearer: vi.fn().mockReturnValue(true),
  markLocalAiTokenMigrated: vi.fn(),
}));

import { getAll, setMany } from "@/lib/config-store";
import { unpairLocal } from "@/lib/clawkeep";
import {
  inferConfiguredLocalModel,
  readConfig,
  restartGateway,
  runOpenclawConfigSet,
  applyModelOverrideToAllAgentSessions,
  parseFullyQualifiedModel,
} from "@/lib/openclaw-config";

const mockSpawn = vi.mocked(childProcess.spawn);
const mockGetAll = vi.mocked(getAll);
const mockSetMany = vi.mocked(setMany);
const mockReadConfig = vi.mocked(readConfig);
const mockRunOpenclawConfigSet = vi.mocked(runOpenclawConfigSet);
const mockFs = vi.mocked(fsp);

function createSuccessfulChildProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  emitter.stdin = { end: vi.fn() } as unknown as ChildProcess["stdin"];
  emitter.stdout = new EventEmitter() as unknown as ChildProcess["stdout"];
  emitter.stderr = new EventEmitter() as unknown as ChildProcess["stderr"];
  emitter.kill = vi.fn();
  queueMicrotask(() => emitter.emit("close", 0));
  return emitter;
}

const CLAWAI_TOKEN = "claw_token123";
const PROXY_URL = "https://clawbox.com/api/ai";

describe("POST /setup-api/ai-models/configure — ClawBox AI image provider", () => {
  let configurePost: (req: Request) => Promise<Response>;

  function jsonRequest(body: unknown): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** Every `openclaw config set` the route ran, as [path, ...rest] tuples. */
  function configSetCalls(): string[][] {
    return mockRunOpenclawConfigSet.mock.calls.map((call) => call[0] as string[]);
  }

  function callFor(path: string): string[] | undefined {
    return configSetCalls().find((args) => args[0] === path);
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
    mockFs.unlink.mockResolvedValue(undefined);
    mockGetAll.mockResolvedValue({});
    mockReadConfig.mockResolvedValue({});
    vi.mocked(inferConfiguredLocalModel).mockReturnValue(null);
    mockSetMany.mockResolvedValue();
    vi.mocked(restartGateway).mockResolvedValue();
    mockSpawn.mockImplementation(() => createSuccessfulChildProcess());
    mockRunOpenclawConfigSet.mockResolvedValue(undefined);
    vi.mocked(unpairLocal).mockResolvedValue(undefined);
    vi.mocked(applyModelOverrideToAllAgentSessions).mockResolvedValue({ filesUpdated: 0, sessionsUpdated: 0 });
    vi.mocked(parseFullyQualifiedModel).mockImplementation(parseFullyQualifiedModelImpl);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));

    const mod = await import("@/app/setup-api/ai-models/configure/route");
    configurePost = mod.POST;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  async function connectClawai(token = CLAWAI_TOKEN) {
    const res = await configurePost(jsonRequest({ provider: "clawai", apiKey: token }));
    expect(res.status).toBe(200);
    return res;
  }

  describe("provisioning", () => {
    it("points the openai image provider at the ClawBox AI proxy", async () => {
      await connectClawai();

      expect(callFor("models.providers.openai.apiKey")).toEqual([
        "models.providers.openai.apiKey",
        CLAWAI_TOKEN,
      ]);

      const modelsCall = callFor("models.providers.openai.models");
      expect(modelsCall?.[2]).toBe("--json");
      expect(JSON.parse(modelsCall?.[1] ?? "null")).toEqual([
        { id: CLAWBOX_AI_IMAGE_MODEL_ID, name: CLAWBOX_AI_IMAGE_MODEL_LABEL, baseUrl: PROXY_URL },
      ]);
    });

    it("writes leaf paths, never the whole provider object", async () => {
      // `config set models.providers.openai <blob>` would drop every other
      // openai setting the box carries.
      await connectClawai();

      const paths = configSetCalls().map((args) => args[0]);
      expect(paths).not.toContain("models.providers.openai");
      expect(paths).toContain("models.providers.openai.apiKey");
      expect(paths).toContain("models.providers.openai.models");
    });

    it("omits `api` so the image model stays out of the chat picker", async () => {
      // With `api` present the entry is offered by `openclaw models list` as a
      // conversational model that fails on every turn. The image path reads raw
      // config, so it does not need one.
      await connectClawai();

      const entry = JSON.parse(callFor("models.providers.openai.models")?.[1] ?? "[]")[0];
      expect(entry).not.toHaveProperty("api");
      expect(Object.keys(entry).sort()).toEqual(["baseUrl", "id", "name"]);
    });

    it("carries the `name` OpenClaw's schema requires", async () => {
      // A models[] entry without one fails config validation and the gateway
      // refuses to start.
      await connectClawai();

      const entry = JSON.parse(callFor("models.providers.openai.models")?.[1] ?? "[]")[0];
      expect(entry.name).toBe(CLAWBOX_AI_IMAGE_MODEL_LABEL);
      expect(String(entry.name).trim()).not.toBe("");
    });

    it("sets agents.defaults.imageGenerationModel — the write that makes the tool appear", async () => {
      // Not `imageModel`: that is a separate key selecting the vision model.
      await connectClawai();

      const call = callFor("agents.defaults.imageGenerationModel");
      expect(call?.[2]).toBe("--json");
      expect(JSON.parse(call?.[1] ?? "null")).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
      expect(callFor("agents.defaults.imageModel")).toBeUndefined();
    });

    it("names the same model the boot migration writes", async () => {
      await connectClawai();

      const entry = JSON.parse(callFor("models.providers.openai.models")?.[1] ?? "[]")[0];
      expect(`openai/${entry.id}`).toBe(CLAWBOX_AI_IMAGE_MODEL);
    });

    it("provisions images on the fallback path too", async () => {
      // configureClawboxAi also runs from ensureFallbackModel — i.e. the user
      // is configuring some other provider and ClawBox AI is only the fallback.
      // The image allowance belongs to the token, not to the chat choice.
      mockGetAll.mockResolvedValue({ clawai_token: CLAWAI_TOKEN });

      const res = await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-ant-key" }));

      expect(res.status).toBe(200);
      expect(callFor("models.providers.openai.apiKey")).toBeDefined();
      expect(callFor("agents.defaults.imageGenerationModel")).toBeDefined();
    });

    it("does not touch the openai provider when there is no ClawBox AI token", async () => {
      const res = await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-ant-key" }));

      expect(res.status).toBe(200);
      expect(callFor("models.providers.openai.apiKey")).toBeUndefined();
      expect(callFor("agents.defaults.imageGenerationModel")).toBeUndefined();
    });
  });

  describe("ownership of models.providers.openai.apiKey", () => {
    // ClawBox has never written this field — the openai setup path configures a
    // native auth profile — so a literal value there is the owner's own OpenAI
    // credential and we refuse rather than overwrite it.
    it.each<[string, unknown]>([
      ["absent", undefined],
      ["null", null],
      ["an empty string", ""],
      ["whitespace", "   "],
      ["a claw_ token we wrote", "claw_older_token"],
    ])("claims the slot when it holds %s", async (_label, apiKey) => {
      mockReadConfig.mockResolvedValue({ models: { providers: { openai: { apiKey } } } } as never);

      await connectClawai();

      expect(callFor("models.providers.openai.apiKey")?.[1]).toBe(CLAWAI_TOKEN);
      expect(callFor("agents.defaults.imageGenerationModel")).toBeDefined();
    });

    it.each<[string, unknown]>([
      ["a real OpenAI key", "sk-proj-users-own-key"],
      ["a padded OpenAI key", "  sk-proj-users-own-key  "],
      ["a number", 12345],
      ["an object", { $env: "OPENAI_API_KEY" }],
      ["an array", ["sk-proj-key"]],
    ])("backs off entirely when it holds %s", async (_label, apiKey) => {
      mockReadConfig.mockResolvedValue({ models: { providers: { openai: { apiKey } } } } as never);

      const res = await connectClawai();

      expect(res.status).toBe(200); // still a successful ClawBox AI connect
      expect(callFor("models.providers.openai.apiKey")).toBeUndefined();
      expect(callFor("models.providers.openai.models")).toBeUndefined();
      expect(callFor("agents.defaults.imageGenerationModel")).toBeUndefined();
      // …and the chat provider was configured regardless.
      expect(callFor("models.providers.deepseek")).toBeDefined();
    });

    it("treats an unreadable config as a fresh box with nothing to preserve", async () => {
      mockReadConfig.mockRejectedValue(new Error("ENOENT"));

      await connectClawai();

      expect(callFor("models.providers.openai.apiKey")?.[1]).toBe(CLAWAI_TOKEN);
    });
  });

  describe("does not steal an image model the owner already chose", () => {
    async function connectWithImageModel(imageGenerationModel: unknown) {
      mockReadConfig.mockResolvedValue({ agents: { defaults: { imageGenerationModel } } } as never);
      await connectClawai();
    }

    it("leaves an existing primary alone", async () => {
      await connectWithImageModel({ primary: "replicate/flux-pro" });
      expect(callFor("agents.defaults.imageGenerationModel")).toBeUndefined();
    });

    it("leaves a fallbacks-only config alone", async () => {
      // The write replaces the whole object, so testing `primary` alone would
      // delete the owner's fallbacks. OpenClaw's own gate (hasToolModelConfig,
      // dist/model-config.helpers-BS3FWcoO.js:25 on 2026.7.1-2) accepts primary
      // OR a non-empty fallback, so fallbacks-only is a working setup.
      await connectWithImageModel({ fallbacks: ["replicate/flux-pro"] });
      expect(callFor("agents.defaults.imageGenerationModel")).toBeUndefined();
    });

    it("leaves a primary+fallbacks config alone", async () => {
      await connectWithImageModel({ primary: "replicate/flux-pro", fallbacks: ["stability/sd3"] });
      expect(callFor("agents.defaults.imageGenerationModel")).toBeUndefined();
    });

    it("still provisions the provider block when the slot is taken", async () => {
      // The token and the model entry are ours regardless; only the slot is not.
      await connectWithImageModel({ fallbacks: ["replicate/flux-pro"] });

      expect(callFor("models.providers.openai.apiKey")?.[1]).toBe(CLAWAI_TOKEN);
      expect(callFor("models.providers.openai.models")).toBeDefined();
    });

    it("does not steal it on the fallback path either", async () => {
      mockGetAll.mockResolvedValue({ clawai_token: CLAWAI_TOKEN });
      mockReadConfig.mockResolvedValue({
        agents: { defaults: { imageGenerationModel: { fallbacks: ["replicate/flux-pro"] } } },
      } as never);

      await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-ant-key" }));

      expect(callFor("agents.defaults.imageGenerationModel")).toBeUndefined();
    });

    it.each<[string, unknown]>([
      ["absent", undefined],
      ["null", null],
      ["an empty object", {}],
      ["a blank primary", { primary: "   " }],
      ["an empty fallbacks list", { fallbacks: [] }],
      ["fallbacks holding only blanks", { fallbacks: ["", "  "] }],
      ["fallbacks that is not a list", { fallbacks: "replicate/flux-pro" }],
      ["a non-string primary", { primary: 42 }],
      ["a plain string", "openai/gpt-image-1-mini"],
    ])("claims the slot when it holds %s — OpenClaw resolves no model from it", async (_label, existing) => {
      await connectWithImageModel(existing);

      expect(JSON.parse(callFor("agents.defaults.imageGenerationModel")?.[1] ?? "null")).toEqual({
        primary: CLAWBOX_AI_IMAGE_MODEL,
      });
    });
  });

  describe("failure containment", () => {
    it("still connects ClawBox AI when the image writes fail", async () => {
      // A chat provider that works is worth more than an image tool.
      mockRunOpenclawConfigSet.mockImplementation(async (args: string[]) => {
        if (args[0]?.startsWith("models.providers.openai")) throw new Error("config write conflict");
      });

      const res = await configurePost(jsonRequest({ provider: "clawai", apiKey: CLAWAI_TOKEN }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockSetMany).toHaveBeenCalledWith(
        expect.objectContaining({ ai_model_configured: true, clawai_token: CLAWAI_TOKEN }),
      );
    });
  });
});
