import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import fsp from "fs/promises";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import {
  CLAWBOX_AI_LEGACY_VISION_MODEL_ID,
  CLAWBOX_AI_VISION_MODEL,
  CLAWBOX_AI_VISION_MODEL_ID,
  CLAWBOX_AI_VISION_MODEL_LABEL,
  CLAWBOX_AI_VISION_MAX_TOKENS,
} from "@/lib/clawbox-ai-models";

// The ClawBox AI vision half of POST /setup-api/ai-models/configure
// (TASK-417). Without it a provisioned box accepts an image attachment and then
// answers that it cannot see it: both chat tiers are text-only, so OpenClaw
// hands the turn a media path, and the `image` tool that would read it resolves
// its model from `agents.defaults.imageModel` — which provisioning never wrote,
// so runWithImageModelFallback throws "No image model configured".
//
// Mocks are the same set configure-images.test.ts uses — the route's
// collaborators, with `runOpenclawConfigSet` as the boundary every
// `openclaw config set` goes through, so the assertions below are about the
// exact commands the route runs.

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

// The vision id is RESOLVED against the proxy before the route writes it:
// DeepSeek's model when served, the previous one until then. The resolver has
// its own unit file; here it answers "preferred allowed" unless a test says
// otherwise, so no route test touches the network.
const resolveVisionMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clawbox-ai-vision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clawbox-ai-vision")>()),
  resolveVisionModelId: resolveVisionMock,
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

type ModelEntry = {
  id?: string;
  name?: string;
  input?: unknown;
  maxTokens?: unknown;
  reasoning?: unknown;
  compat?: unknown;
  [key: string]: unknown;
};

describe("POST /setup-api/ai-models/configure — ClawBox AI vision model", () => {
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

  /** The models[] the route wrote for the ClawBox AI (deepseek) provider. */
  function deepseekModels(): ModelEntry[] {
    const call = callFor("models.providers.deepseek");
    const provider = JSON.parse(call?.[1] ?? "null") as { models?: ModelEntry[] } | null;
    return provider?.models ?? [];
  }

  function visionEntry(): ModelEntry | undefined {
    return deepseekModels().find((m) => m.id === CLAWBOX_AI_VISION_MODEL_ID);
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    resolveVisionMock.mockResolvedValue({ id: CLAWBOX_AI_VISION_MODEL_ID, verified: true, reason: "proxy-allows" });
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

  it("registers a vision entry that advertises image input", async () => {
    await connectClawai();

    // `input: ["text", "image"]` is the load-bearing part: resolveImageRuntime
    // refuses a media-understanding model whose catalog entry does not
    // advertise image input.
    expect(visionEntry()).toEqual({
      id: CLAWBOX_AI_VISION_MODEL_ID,
      name: CLAWBOX_AI_VISION_MODEL_LABEL,
      input: ["text", "image"],
      maxTokens: CLAWBOX_AI_VISION_MAX_TOKENS,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("registers it on the ClawBox AI proxy provider, not on openai", async () => {
    await connectClawai();

    // The deepseek entry IS the proxy: it already carries
    // api=openai-completions, the proxy baseUrl and the claw_ token. OpenClaw's
    // `openai` provider defaults to openai-responses, which the proxy does not
    // speak.
    const provider = JSON.parse(callFor("models.providers.deepseek")?.[1] ?? "null");
    expect(provider.baseUrl).toBe(PROXY_URL);
    expect(provider.api).toBe("openai-completions");

    const openaiModels = JSON.parse(callFor("models.providers.openai.models")?.[1] ?? "[]") as ModelEntry[];
    expect(openaiModels.some((m) => m.id === CLAWBOX_AI_VISION_MODEL_ID)).toBe(false);
  });

  it("points agents.defaults.imageModel at it", async () => {
    await connectClawai();

    const call = callFor("agents.defaults.imageModel");
    expect(call?.[2]).toBe("--json");
    expect(JSON.parse(call?.[1] ?? "null")).toEqual({ primary: CLAWBOX_AI_VISION_MODEL });
  });

  it("leaves the two chat tiers text-only and non-reasoning-free", async () => {
    await connectClawai();

    const chat = deepseekModels().filter((m) => m.id !== CLAWBOX_AI_VISION_MODEL_ID);
    expect(chat).toHaveLength(2);
    for (const entry of chat) {
      expect(entry.input).toEqual(["text"]);
      expect(entry.reasoning).toBe(true);
    }
    // The vision entry is a one-shot describe and never negotiates thinking.
    expect(visionEntry()?.reasoning).toBeUndefined();
    expect(visionEntry()?.compat).toBeUndefined();
  });

  it("does not touch imageGenerationModel", async () => {
    await connectClawai();

    // Two independent config keys with no aliasing. imageGenerationModel says
    // where pictures come from; imageModel says what looks at one.
    expect(JSON.parse(callFor("agents.defaults.mediaModels.image")?.[1] ?? "null"))
      .toEqual({ primary: "openai/gpt-image-1-mini" });
    expect(JSON.parse(callFor("agents.defaults.imageModel")?.[1] ?? "null"))
      .toEqual({ primary: CLAWBOX_AI_VISION_MODEL });
  });

  it("keeps a vision model the owner already chose", async () => {
    // configureClawboxAi also runs when ClawBox AI is merely being added as a
    // fallback for some other provider, so an occupied slot is a decision made
    // elsewhere.
    mockReadConfig.mockResolvedValue({
      agents: { defaults: { imageModel: { primary: "google/gemini-2.5-flash" } } },
    });

    await connectClawai();

    expect(callFor("agents.defaults.imageModel")).toBeUndefined();
    // The entry is still registered — availability is not the same as default.
    expect(visionEntry()).toBeDefined();
  });

  it("treats a fallbacks-only imageModel as already configured", async () => {
    // The write replaces the whole object, so claiming the slot here would
    // delete the owner's fallbacks. Same rule OpenClaw's hasToolModelConfig
    // applies.
    mockReadConfig.mockResolvedValue({
      agents: { defaults: { imageModel: { fallbacks: ["google/gemini-2.5-flash"] } } },
    });

    await connectClawai();

    expect(callFor("agents.defaults.imageModel")).toBeUndefined();
  });

  it("claims an imageModel that is empty in OpenClaw's sense", async () => {
    mockReadConfig.mockResolvedValue({
      agents: { defaults: { imageModel: { primary: "  ", fallbacks: ["", " "] } } },
    });

    await connectClawai();

    expect(JSON.parse(callFor("agents.defaults.imageModel")?.[1] ?? "null"))
      .toEqual({ primary: CLAWBOX_AI_VISION_MODEL });
  });

  it("still configures chat when the vision write fails", async () => {
    // Non-fatal by design: a chat provider that works is worth more than a
    // vision model, so this must not fail the whole Connect ClawBox AI flow.
    failConfigSetsMatching(
      mockRunOpenclawConfigSet,
      mockRunOpenclawConfigSetBatch,
      (path) => path === "agents.defaults.imageModel",
      () => new Error("config set exploded"),
    );

    const res = await configurePost(jsonRequest({ provider: "clawai", apiKey: CLAWAI_TOKEN }));

    expect(res.status).toBe(200);
    expect(callFor("models.providers.deepseek")).toBeDefined();
  });
});
