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
  // The configure route reads the config STRICTLY before it removes an
  // openai-compat override, so the mock has to carry both readers.
  readConfigStrict: vi.fn().mockResolvedValue({}),
  inferConfiguredLocalModel: vi.fn(),
  runOpenclawConfigSet: vi.fn(),
  spawnOpenclawCli: vi.fn().mockResolvedValue(""),
  runOpenclawDoctorFix: vi.fn().mockResolvedValue(undefined),
  runOpenclawConfigSetBatch: vi.fn(),
  runOpenclawConfigUnset: vi.fn(),
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
  readConfigStrict,
  restartGateway,
  runOpenclawConfigSet,
  runOpenclawConfigSetBatch,
  applyModelOverrideToAllAgentSessions,
  parseFullyQualifiedModel,
} from "@/lib/openclaw-config";
import { configSetCalls as recordedConfigSetCalls, failConfigSetsMatching } from "./config-set-calls";

const mockSpawn = vi.mocked(childProcess.spawn);
const mockGetAll = vi.mocked(getAll);
const mockSetMany = vi.mocked(setMany);
const mockReadConfig = vi.mocked(readConfig);
const mockReadConfigStrict = vi.mocked(readConfigStrict);
const mockRunOpenclawConfigSet = vi.mocked(runOpenclawConfigSet);
const mockRunOpenclawConfigSetBatch = vi.mocked(runOpenclawConfigSetBatch);
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

  /**
   * Every `openclaw config set` assignment the route made, as [path, ...rest]
   * tuples — whether it went out on its own or inside a batch.
   */
  function configSetCalls(): string[][] {
    return recordedConfigSetCalls(mockRunOpenclawConfigSet, mockRunOpenclawConfigSetBatch)
      .map((call) => call.args);
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
    mockReadConfigStrict.mockResolvedValue({});
    vi.mocked(inferConfiguredLocalModel).mockReturnValue(null);
    mockSetMany.mockResolvedValue();
    vi.mocked(restartGateway).mockResolvedValue();
    mockSpawn.mockImplementation(() => createSuccessfulChildProcess());
    mockRunOpenclawConfigSet.mockResolvedValue(undefined);
    mockRunOpenclawConfigSetBatch.mockResolvedValue(undefined);
    vi.mocked(unpairLocal).mockResolvedValue(undefined);
    vi.mocked(applyModelOverrideToAllAgentSessions).mockResolvedValue({ filesUpdated: 0, sessionsUpdated: 0, sessionsSkipped: 0 });
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

    it("sets agents.defaults.mediaModels.image — the write that makes the tool appear", async () => {
      // Not `imageModel`: that is a separate key selecting the vision model.
      await connectClawai();

      const call = callFor("agents.defaults.mediaModels.image");
      expect(call?.[2]).toBe("--json");
      expect(JSON.parse(call?.[1] ?? "null")).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
      // The route also writes `imageModel` — the vision key, from a different
      // function (TASK-417). What must never happen is the two aliasing: the
      // image-generation slot has to name the image model and nothing else.
      const visionCall = callFor("agents.defaults.imageModel");
      expect(JSON.parse(visionCall?.[1] ?? "null")).not.toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
    });

    it("names the same model the boot migration writes", async () => {
      await connectClawai();

      const entry = JSON.parse(callFor("models.providers.openai.models")?.[1] ?? "[]")[0];
      expect(`openai/${entry.id}`).toBe(CLAWBOX_AI_IMAGE_MODEL);
    });

    it("provisions images on the fallback path too", async () => {
      // configureClawboxAi also runs from ensureFallbackModel — i.e. the user
      // is configuring some other provider and ClawBox AI is only the fallback.
      // Image generation belongs to the token, not to the chat choice.
      mockGetAll.mockResolvedValue({ clawai_token: CLAWAI_TOKEN });

      const res = await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-ant-key" }));

      expect(res.status).toBe(200);
      expect(callFor("models.providers.openai.apiKey")).toBeDefined();
      expect(callFor("agents.defaults.mediaModels.image")).toBeDefined();
    });

    it("does not touch the openai provider when there is no ClawBox AI token", async () => {
      const res = await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-ant-key" }));

      expect(res.status).toBe(200);
      expect(callFor("models.providers.openai.apiKey")).toBeUndefined();
      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
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
      expect(callFor("agents.defaults.mediaModels.image")).toBeDefined();
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
      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
      // …and the chat provider was configured regardless.
      expect(callFor("models.providers.deepseek")).toBeDefined();
    });

    it("treats an unreadable config as a fresh box with nothing to preserve", async () => {
      mockReadConfig.mockRejectedValue(new Error("ENOENT"));

      await connectClawai();

      expect(callFor("models.providers.openai.apiKey")?.[1]).toBe(CLAWAI_TOKEN);
    });
  });

  describe("upserts models[] instead of replacing it", () => {
    // `config set models.providers.openai.models` writes the whole array, so
    // building it from our entry alone deletes every other row the owner
    // configured. The boot migration in scripts/gateway-pre-start.sh has always
    // upserted; a box repaired at boot and a box configured through this route
    // have to end up with the same config.
    function writtenModels(): Array<Record<string, unknown>> {
      return JSON.parse(callFor("models.providers.openai.models")?.[1] ?? "null");
    }

    async function connectWithOpenaiProvider(openai: Record<string, unknown>) {
      mockReadConfig.mockResolvedValue({ models: { providers: { openai } } } as never);
      await connectClawai();
    }

    it("keeps a sibling row and appends ours", async () => {
      const sibling = { id: "house-model", name: "House model", api: "openai-completions", baseUrl: PROXY_URL };
      await connectWithOpenaiProvider({ models: [sibling] });

      expect(writtenModels()).toEqual([
        sibling,
        { id: CLAWBOX_AI_IMAGE_MODEL_ID, name: CLAWBOX_AI_IMAGE_MODEL_LABEL, baseUrl: PROXY_URL },
      ]);
    });

    it("repairs its own entry in place rather than duplicating it", async () => {
      // Same three repairs the boot migration applies: a blank `name` (the
      // config will not validate without one and the gateway then refuses to
      // start), a baseUrl left on a retired proxy, and a stray `api` that would
      // put the image model in the chat picker.
      await connectWithOpenaiProvider({
        apiKey: "claw_old",
        models: [{
          id: CLAWBOX_AI_IMAGE_MODEL_ID,
          name: "   ",
          baseUrl: "https://clawbox.com/api/ai",
          api: "openai-completions",
        }],
      });

      expect(writtenModels()).toEqual([
        { id: CLAWBOX_AI_IMAGE_MODEL_ID, name: CLAWBOX_AI_IMAGE_MODEL_LABEL, baseUrl: PROXY_URL },
      ]);
    });

    it("leaves a name the owner gave our entry alone", async () => {
      await connectWithOpenaiProvider({
        apiKey: "claw_old",
        models: [{ id: CLAWBOX_AI_IMAGE_MODEL_ID, name: "Drawing machine", baseUrl: PROXY_URL }],
      });

      expect(writtenModels()[0].name).toBe("Drawing machine");
    });

    it("starts a fresh array when models[] is present but not a list", async () => {
      await connectWithOpenaiProvider({ models: "nonsense" });

      expect(writtenModels()).toEqual([
        { id: CLAWBOX_AI_IMAGE_MODEL_ID, name: CLAWBOX_AI_IMAGE_MODEL_LABEL, baseUrl: PROXY_URL },
      ]);
    });

    it("drops non-object junk rows rather than writing back an invalid config", async () => {
      await connectWithOpenaiProvider({ models: [null, "gpt-5", 42] });

      expect(writtenModels()).toEqual([
        { id: CLAWBOX_AI_IMAGE_MODEL_ID, name: CLAWBOX_AI_IMAGE_MODEL_LABEL, baseUrl: PROXY_URL },
      ]);
    });
  });

  describe("will not make the portal token the credential for someone else's endpoint", () => {
    // models.providers.openai.apiKey is provider-wide — nothing scopes it to the
    // image model. getApiKeyForModel (dist/model-auth-CJEm9SNp.js:753 on
    // OpenClaw 2026.7.1-2) falls back to it for any `openai/*` request once
    // per-entry bindings, auth profiles and OPENAI_API_KEY come up empty, which
    // on a ClawBox they always do.
    async function backsOff(openai: Record<string, unknown>) {
      mockReadConfig.mockResolvedValue({ models: { providers: { openai } } } as never);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const res = await connectClawai();

        expect(res.status).toBe(200); // ClawBox AI chat still connected
        expect(callFor("models.providers.openai.apiKey")).toBeUndefined();
        expect(callFor("models.providers.openai.models")).toBeUndefined();
        expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
        expect(callFor("models.providers.deepseek")).toBeDefined();
        return warn.mock.calls.map((call) => call.join(" ")).join("\n");
      } finally {
        warn.mockRestore();
      }
    }

    it("backs off on a sibling row that resolves to api.openai.com", async () => {
      // `api` makes it a live chat row; the absent baseUrl resolves it to
      // api.openai.com, where the claw_ token would be sent as the bearer.
      const logged = await backsOff({ models: [{ id: "gpt-5", name: "GPT-5", api: "openai-completions" }] });

      expect(logged).toContain("Skipped ClawBox AI image provider");
      expect(logged).toContain("api.openai.com");
    });

    it("backs off on a sibling row pointing at a third-party host", async () => {
      await backsOff({
        models: [{ id: "local-gpt", name: "Local GPT", api: "openai-completions", baseUrl: "https://someone-elses-proxy.example/v1" }],
      });
    });

    it("backs off on a provider-level baseUrl that is not ours", async () => {
      // Every row without a baseUrl of its own inherits this one, including
      // OpenClaw's bundled openai catalog rows.
      const logged = await backsOff({ baseUrl: "https://someone-elses-proxy.example/v1" });

      expect(logged).toContain("someone-elses-proxy.example");
    });

    it("backs off on a baseUrl it cannot parse", async () => {
      await backsOff({ models: [{ id: "mystery", name: "Mystery", baseUrl: "not-a-url" }] });
    });

    it("proceeds when a sibling row points at the same proxy we do", async () => {
      mockReadConfig.mockResolvedValue({
        models: { providers: { openai: { models: [{ id: "house-model", name: "House model", api: "openai-completions", baseUrl: PROXY_URL }] } } },
      } as never);

      await connectClawai();

      expect(callFor("models.providers.openai.apiKey")?.[1]).toBe(CLAWAI_TOKEN);
    });

    it("proceeds on a box whose only openai row is ours", async () => {
      // Re-configuring must not back off on this route's own previous output.
      mockReadConfig.mockResolvedValue({
        models: { providers: { openai: { apiKey: "claw_old", models: [{ id: CLAWBOX_AI_IMAGE_MODEL_ID, name: CLAWBOX_AI_IMAGE_MODEL_LABEL, baseUrl: PROXY_URL }] } } },
      } as never);

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
      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
    });

    it("leaves a fallbacks-only config alone", async () => {
      // The write replaces the whole object, so testing `primary` alone would
      // delete the owner's fallbacks. OpenClaw's own gate (hasToolModelConfig,
      // dist/model-config.helpers-BS3FWcoO.js:25 on 2026.7.1-2) accepts primary
      // OR a non-empty fallback, so fallbacks-only is a working setup.
      await connectWithImageModel({ fallbacks: ["replicate/flux-pro"] });
      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
    });

    it("leaves a primary+fallbacks config alone", async () => {
      await connectWithImageModel({ primary: "replicate/flux-pro", fallbacks: ["stability/sd3"] });
      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
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

      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
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

      expect(JSON.parse(callFor("agents.defaults.mediaModels.image")?.[1] ?? "null")).toEqual({
        primary: CLAWBOX_AI_IMAGE_MODEL,
      });
    });
  });

  describe("what the failure path is allowed to write to the journal", () => {
    /** The single journal record the image-provider catch produced. */
    async function failImageWritesWith(message: string): Promise<string> {
      failConfigSetsMatching(
        mockRunOpenclawConfigSet,
        mockRunOpenclawConfigSetBatch,
        (path) => path.startsWith("models.providers.openai"),
        () => new Error(message),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await connectClawai();
        const records = warn.mock.calls
          .map((call) => call.map(String).join(" "))
          .filter((record) => record.includes("ClawBox AI image provider"));
        // One distinct record is what matters here — the route may report the
        // same failure more than once (the combined batch fails first, then the
        // image group fails again on its own boundary), but it must never
        // produce two DIFFERENT records from one subprocess message.
        expect(records.length).toBeGreaterThan(0);
        expect(new Set(records).size).toBe(1);
        return records[0];
      } finally {
        warn.mockRestore();
      }
    }

    it("does not let a subprocess error forge extra log records", async () => {
      // CodeQL "Log injection": the message is built from whatever `openclaw`
      // wrote to stderr, and a value reaches that CLI straight from this
      // route's request body. Unescaped CR/LF would let one API call decide how
      // many records the journal gets, and an ESC would be acted on by whatever
      // terminal tails it.
      const logged = await failImageWritesWith("boom\nWARN forged record\r\n[31mred");

      expect(logged).toContain("Failed to configure ClawBox AI image provider");
      expect(logged).not.toContain("\n[31m");
      expect(logged.split("\n")).toHaveLength(1);
      expect(logged).toContain("�");
    });

    it("bounds the record instead of letting the CLI size it", async () => {
      const logged = await failImageWritesWith("x".repeat(5000));

      expect(logged.length).toBeLessThan(400);
      expect(logged).toContain("chars]");
    });
  });

  describe("failure containment", () => {
    it("still connects ClawBox AI when the image writes fail", async () => {
      // A chat provider that works is worth more than an image tool.
      failConfigSetsMatching(
        mockRunOpenclawConfigSet,
        mockRunOpenclawConfigSetBatch,
        (path) => path.startsWith("models.providers.openai"),
        () => new Error("config write conflict"),
      );

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
