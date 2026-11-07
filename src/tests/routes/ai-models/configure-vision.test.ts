import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import fsp from "fs/promises";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import {
  CLAWBOX_AI_CHAT_MODEL,
  CLAWBOX_AI_FLASH_MODEL_ID,
  CLAWBOX_AI_VISION_FALLBACK_MODEL_ID,
} from "@/lib/clawbox-ai-models";
import {
  RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS,
  RETIRED_CLAWBOX_AI_VISION_MODEL_IDS,
} from "@/lib/clawbox-ai-retired-models";

// ClawBox AI's ONE model (TASK-2261) as POST /setup-api/ai-models/configure
// writes it: `deepseek-v4-flash` for chat, and for looking at a picture while
// the vision check — the proxy SHOWN a picture — says Flash sees; the vision
// fallback while it does not; nothing while neither does. The provider gets
// one chat row; `agents.defaults.imageModel` points at the model that sees
// (TASK-417: with that slot empty, a turn whose chat model cannot see throws
// "No image model configured"); and a re-link moves every slot that still
// names a retired id onto Flash, while leaving the owner's own choices alone.
//
// Mocks are the same set configure-images.test.ts uses — the route's
// collaborators, with `runOpenclawConfigSet` as the boundary every
// `openclaw config set` goes through, so the assertions below are about the
// exact commands the route runs.

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

// PARTIAL mock — only the setup-gate read is replaceable, and it is pinned
// rather than left to the filesystem. Without it `readSetupGateFacts()` runs
// for real, reads `${CLAWBOX_ROOT}/data/config.json` under the hermetic floor
// vitest.config.ts sets, gets ENOENT and answers `setupComplete: false` — so
// every case in this file silently exercised the FIRST-RUN WIZARD branch
// (`awaitReady: false`), which is not the box these Settings-side cases
// describe. Deterministic, but named by accident; the first assertion on
// restartGateway's argument added here would have pinned the wrong one.
vi.mock("@/lib/route-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/route-auth")>("@/lib/route-auth");
  return { ...actual, readSetupGateFacts: () => ({ setupComplete: true, passwordConfigured: true }) };
});

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
  // `get`/`set` are how `@/lib/clawai-credential-refusal` reads and clears the
  // persisted ClawBox AI credential refusal. Both of its calls sit inside a
  // catch that answers a DEFAULT, so omitting them here would not fail this
  // file — it would quietly make every case take the "no refusal on record"
  // branch. Guarded by openclaw-config-mock-completeness.test.ts.
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => {}),
}));

vi.mock("@/lib/clawkeep", () => ({
  unpairLocal: vi.fn(),
}));

// Out-of-band catalog refresh the route deliberately does not await; stubbing
// it stops its late console write from racing worker teardown. See the long
// note in configure.test.ts.
vi.mock("@/app/setup-api/ai-models/catalog/route", () => ({
  refreshInBackground: vi.fn(),
  notifyProviderSetChanged: vi.fn(),
}));

const { parseFullyQualifiedModelImpl, LLAMACPP_PROXY_BASE_URL } = vi.hoisted(() => ({
  parseFullyQualifiedModelImpl(fq: string) {
    const idx = fq.indexOf("/");
    if (idx <= 0 || idx === fq.length - 1) return null;
    return { provider: fq.slice(0, idx), modelId: fq.slice(idx + 1) };
  },
  LLAMACPP_PROXY_BASE_URL: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
}));

// The gateway applies a save live unless a test says otherwise (TASK-1535):
// classification real, gateway I/O mocked — see the helper.
vi.mock("@/lib/gateway-hot-apply", async (importOriginal) =>
  (await import("@/tests/helpers/gateway-hot-apply")).gatewayHotApplyMock(importOriginal));
vi.mock("@/lib/openclaw-config", async () => ({
  ...(await import("./config-write-passthrough")).configWritePassthrough,
  // A REAL class, not `vi.fn()` and not an omitted export: the configure route
  // narrows on `instanceof GatewayNotReadyError` to tell "the gateway has not
  // finished coming back" from "the restart was refused", and `instanceof
  // undefined` throws a TypeError the first time a test makes it reject.
  GatewayNotReadyError: class GatewayNotReadyError extends Error {
    constructor(message = "gateway did not come back") {
      super(message);
      this.name = "GatewayNotReadyError";
    }
  },
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
  // The real declaration: the row a 2026.10+ core gets (src/lib/llamacpp.ts).
  LLAMACPP_REASONING_COMPAT: { supportedReasoningEfforts: ["none", "high"], reasoningEffortMap: { off: "none" } },
  llamaCppThinkingDefaultOp: (ref: string) => [`agents.defaults.models[${JSON.stringify(ref)}].params.thinking`, "off"],
}));

vi.mock("@/lib/local-ai-runtime", () => ({
  getLocalAiProxyBaseUrl: vi.fn((provider: string) =>
    provider === "llamacpp"
      ? LLAMACPP_PROXY_BASE_URL
      : `http://127.0.0.1/setup-api/local-ai/${provider}`,
  ),
}));

// The INSTALLED core decides which of the two image-model homes is written
// (TASK-755), and on a machine with no core the honest answer is `unknown`,
// which writes neither. Every case here is about a box that HAS one, so the
// generation is stated rather than inherited from wherever the suite runs.
vi.mock("@/lib/openclaw-core-generation", () => ({
  installedOpenclawCoreGeneration: vi.fn(async () => "v2"),
  installedOpenclawCoreAtLeast: vi.fn(async () => true),
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

const [VISION_EXP] = RETIRED_CLAWBOX_AI_VISION_MODEL_IDS;
const FALLBACK = CLAWBOX_AI_VISION_FALLBACK_MODEL_ID;
const FALLBACK_REF = `deepseek/${FALLBACK}`;

/**
 * What the proxy says when the vision check shows a model the probe picture:
 * a string is the model's answer, a number the status it refuses with. Every
 * other request is "network disabled".
 */
function proxySays(answers: Record<string, string | number>) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input).endsWith("/chat/completions")) {
      const answer = answers[JSON.parse(String(init?.body ?? "{}")).model];
      if (typeof answer === "number") {
        return new Response(JSON.stringify({ error: { message: "unknown variant `image_url`, expected `text`" } }), { status: answer });
      }
      if (typeof answer === "string") {
        return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), { status: 200 });
      }
    }
    throw new Error("network disabled in tests");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const RETIRED_CHAT_REF = `deepseek/${RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS[0]}`;

describe("POST /setup-api/ai-models/configure — ClawBox AI's one model", () => {
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

  it("restarts only for the provider plugin it installed, and answers before the gateway is back", async () => {
    // The branch this file's cases actually describe, said out loud. The vision
    // writes are `agents.defaults.*` / `models.*`, which the gateway hot-applies
    // (TASK-1535); what still restarts it here is the box this suite models,
    // which has no ClawBox AI provider plugin on disk until this save installs
    // it. The restart is answered early: never a wait for the port.
    const { awaitGatewayHotApply } = await import("@/lib/gateway-hot-apply");
    const res = await connectClawai();
    expect((await res.json()).gatewayRestarting).toBe(true);
    expect(awaitGatewayHotApply).not.toHaveBeenCalled();
    expect(restartGateway).toHaveBeenCalledWith({ awaitReady: false });
  });

  it("writes one model row, which takes pictures too", async () => {
    await connectClawai();

    // `input: ["text", "image"]` is load-bearing twice over: it lets an
    // attached picture reach the chat model directly, and resolveImageRuntime
    // refuses an image model whose catalog entry does not advertise it.
    expect(deepseekModels()).toEqual([
      expect.objectContaining({ id: CLAWBOX_AI_FLASH_MODEL_ID, input: ["text", "image"], reasoning: true }),
    ]);
  });

  it("offers no retired id on the provider, the Max plan included", async () => {
    await configurePost(jsonRequest({ provider: "clawai", apiKey: CLAWAI_TOKEN, clawaiTier: "pro" }));
    const ids = deepseekModels().map((m) => m.id);
    expect(ids).toEqual([CLAWBOX_AI_FLASH_MODEL_ID]);
    for (const retired of [...RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS, ...RETIRED_CLAWBOX_AI_VISION_MODEL_IDS]) {
      expect(ids).not.toContain(retired);
    }
  });

  it("registers it on the ClawBox AI proxy provider, not on openai", async () => {
    await connectClawai();

    const provider = JSON.parse(callFor("models.providers.deepseek")?.[1] ?? "null");
    expect(provider.baseUrl).toBe(PROXY_URL);
    expect(provider.api).toBe("openai-completions");
    expect(callFor("models.providers.openai.models")).toBeUndefined();
  });

  it("points agents.defaults.imageModel at the one model", async () => {
    await connectClawai();

    const call = callFor("agents.defaults.imageModel");
    expect(call?.[2]).toBe("--json");
    expect(JSON.parse(call?.[1] ?? "null")).toEqual({ primary: CLAWBOX_AI_CHAT_MODEL });
  });

  it("asks the proxy whether Flash can see by SHOWING it a picture", async () => {
    const fetchMock = proxySays({ [CLAWBOX_AI_FLASH_MODEL_ID]: "Red" });
    await connectClawai();
    const probe = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/chat/completions"));
    const body = JSON.parse(String(probe?.[1]?.body));
    expect(body.model).toBe(CLAWBOX_AI_FLASH_MODEL_ID);
    expect(body.messages[0].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url" })]));
    expect(deepseekModels()[0].input).toEqual(["text", "image"]);
  });

  it("keeps Flash text-only and sends pictures to the fallback when Flash cannot see", async () => {
    proxySays({ [CLAWBOX_AI_FLASH_MODEL_ID]: 400, [FALLBACK]: "red" });
    await connectClawai();

    expect(deepseekModels()).toEqual([
      expect.objectContaining({ id: CLAWBOX_AI_FLASH_MODEL_ID, input: ["text"] }),
      expect.objectContaining({ id: FALLBACK, input: ["text", "image"], maxTokens: 128_000 }),
    ]);
    // Never a chat model: no reasoning controls on the fallback row.
    expect(deepseekModels()[1].reasoning).toBeUndefined();
    expect(JSON.parse(callFor("agents.defaults.imageModel")?.[1] ?? "null")).toEqual({ primary: FALLBACK_REF });
  });

  it("arms no picture slot when neither can see, and removes ours", async () => {
    proxySays({ [CLAWBOX_AI_FLASH_MODEL_ID]: 400, [FALLBACK]: 400 });
    await connectClawai();
    expect(deepseekModels()).toEqual([expect.objectContaining({ id: CLAWBOX_AI_FLASH_MODEL_ID, input: ["text"] })]);
    expect(callFor("agents.defaults.imageModel")).toBeUndefined();

    const { runOpenclawConfigUnset } = await import("@/lib/openclaw-config");
    vi.mocked(runOpenclawConfigUnset).mockClear();
    mockReadConfig.mockResolvedValue({ agents: { defaults: { imageModel: { primary: CLAWBOX_AI_CHAT_MODEL } } } });
    await connectClawai();
    expect(vi.mocked(runOpenclawConfigUnset).mock.calls.map((c) => c[0])).toContain("agents.defaults.imageModel");

    vi.mocked(runOpenclawConfigSet).mockClear();
    vi.mocked(runOpenclawConfigSetBatch).mockClear();
    mockReadConfig.mockResolvedValue({
      agents: { defaults: { imageModel: { primary: CLAWBOX_AI_CHAT_MODEL, fallbacks: ["google/gemini-2.5-flash"] } } },
    });
    await connectClawai();
    expect(JSON.parse(callFor("agents.defaults.imageModel")?.[1] ?? "null")).toEqual({ fallbacks: ["google/gemini-2.5-flash"] });
  });

  it("keeps the fallback a box already uses when the question cannot be answered", async () => {
    mockReadConfig.mockResolvedValue({ agents: { defaults: { imageModel: { primary: FALLBACK_REF } } } });
    await connectClawai();
    expect(callFor("agents.defaults.imageModel")).toBeUndefined();
    expect(deepseekModels().map((m) => m.id)).toEqual([CLAWBOX_AI_FLASH_MODEL_ID, FALLBACK]);
  });

  it("does not touch imageGenerationModel", async () => {
    await connectClawai();

    // Two independent config keys with no aliasing. The image-generation slot
    // says where pictures come from; imageModel says what looks at one.
    expect(JSON.parse(callFor("agents.defaults.mediaModels.image")?.[1] ?? "null"))
      .toEqual({ primary: "litellm/gpt-image-1-mini" });
    expect(JSON.parse(callFor("agents.defaults.imageModel")?.[1] ?? "null"))
      .toEqual({ primary: CLAWBOX_AI_CHAT_MODEL });
  });

  it("keeps a vision model the owner already chose, the OpenAI model of the same name included", async () => {
    // configureClawboxAi also runs when ClawBox AI is merely being added as a
    // fallback for some other provider, so an occupied slot is a decision made
    // elsewhere.
    for (const owner of [{ primary: "google/gemini-2.5-flash" }, { primary: `openai/${FALLBACK}` }]) {
      vi.mocked(runOpenclawConfigSet).mockClear();
      vi.mocked(runOpenclawConfigSetBatch).mockClear();
      mockReadConfig.mockResolvedValue({ agents: { defaults: { imageModel: owner } } });

      await connectClawai();

      expect(callFor("agents.defaults.imageModel")).toBeUndefined();
    }
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

  it("leaves a bare string the OWNER wrote alone (TASK-755)", async () => {
    mockReadConfig.mockResolvedValue({
      agents: { defaults: { imageModel: "google/gemini-2.5-flash" } },
    });

    await connectClawai();

    expect(callFor("agents.defaults.imageModel")).toBeUndefined();
  });

  it("moves the separate vision model's id, or the fallback, onto Flash when it sees, keeping the owner's fallbacks", async () => {
    proxySays({ [CLAWBOX_AI_FLASH_MODEL_ID]: "Red" });
    for (const id of [VISION_EXP, FALLBACK]) {
      vi.mocked(runOpenclawConfigSet).mockClear();
      vi.mocked(runOpenclawConfigSetBatch).mockClear();
      mockReadConfig.mockResolvedValue({
        agents: { defaults: { imageModel: { primary: `deepseek/${id}`, fallbacks: ["google/gemini-2.5-flash"] } } },
      });

      await connectClawai();

      expect(JSON.parse(callFor("agents.defaults.imageModel")?.[1] ?? "null"))
        .toEqual({ primary: CLAWBOX_AI_CHAT_MODEL, fallbacks: ["google/gemini-2.5-flash"] });
    }
  });

  it("moves OUR old id even as a bare string, into the object shape", async () => {
    proxySays({ [CLAWBOX_AI_FLASH_MODEL_ID]: "Red" });
    mockReadConfig.mockResolvedValue({
      agents: { defaults: { imageModel: `deepseek/${VISION_EXP}` } },
    });

    await connectClawai();

    expect(JSON.parse(callFor("agents.defaults.imageModel")?.[1] ?? "null"))
      .toEqual({ primary: CLAWBOX_AI_CHAT_MODEL });
  });

  it("claims an imageModel that is empty in OpenClaw's sense", async () => {
    mockReadConfig.mockResolvedValue({
      agents: { defaults: { imageModel: { primary: "  ", fallbacks: ["", " "] } } },
    });

    await connectClawai();

    expect(JSON.parse(callFor("agents.defaults.imageModel")?.[1] ?? "null"))
      .toEqual({ primary: CLAWBOX_AI_CHAT_MODEL });
  });

  it("moves fallbacks and per-agent models off the retired Max-plan id on a re-link", async () => {
    // The provider write drops that row, so a slot left naming it would point
    // at a model this box no longer defines.
    mockReadConfig.mockResolvedValue({
      models: { providers: { deepseek: { apiKey: CLAWAI_TOKEN, baseUrl: PROXY_URL, models: [] } } },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-5", fallbacks: [RETIRED_CHAT_REF] },
          compaction: { model: RETIRED_CHAT_REF },
        },
        list: [{ id: "helper", model: RETIRED_CHAT_REF }, { id: "other", model: "anthropic/claude-opus-5" }],
      },
      // `agents.list` is OpenClaw's, not a key this repo's config type models.
    } as never);

    await connectClawai();

    expect(JSON.parse(callFor("agents.defaults.model")?.[1] ?? "null"))
      .toEqual({ primary: "anthropic/claude-opus-5", fallbacks: [CLAWBOX_AI_CHAT_MODEL] });
    expect(JSON.parse(callFor("agents.defaults.compaction")?.[1] ?? "null")).toEqual({ model: CLAWBOX_AI_CHAT_MODEL });
    expect(JSON.parse(callFor("agents.list")?.[1] ?? "null")).toEqual([
      { id: "helper", model: CLAWBOX_AI_CHAT_MODEL },
      { id: "other", model: "anthropic/claude-opus-5" },
    ]);
  });

  it("lets this call's own primary win over the move", async () => {
    // The move is computed from the config as it was BEFORE this save, so it
    // is written first: the primary the save itself picks lands after it.
    mockReadConfig.mockResolvedValue({
      agents: { defaults: { model: { primary: RETIRED_CHAT_REF, fallbacks: [] } } },
    });

    await connectClawai();

    // Every write that sets the primary, in order: the move's whole slot and
    // the save's own `.primary`.
    const primaries = configSetCalls().flatMap((args) => {
      if (args[0] === "agents.defaults.model.primary") return [args[1]];
      if (args[0] === "agents.defaults.model") return [JSON.parse(args[1]).primary];
      return [];
    });
    expect(primaries.length).toBeGreaterThan(0);
    expect(primaries[primaries.length - 1]).toBe(CLAWBOX_AI_CHAT_MODEL);
  });

  it("writes a retired key of the models map with --replace, which the CLI needs to drop it", async () => {
    mockReadConfig.mockResolvedValue({
      agents: { defaults: { models: { [RETIRED_CHAT_REF]: { alias: "max" } } } },
    } as never);

    await connectClawai();

    const call = callFor("agents.defaults.models");
    expect(JSON.parse(call?.[1] ?? "null")).toEqual({ [CLAWBOX_AI_CHAT_MODEL]: { alias: "max" } });
    expect(call).toContain("--replace");
  });

  it("leaves `deepseek/…` alone on a box whose deepseek provider is a raw DeepSeek account", async () => {
    mockReadConfig.mockResolvedValue({
      models: { providers: { deepseek: { apiKey: "sk-raw", baseUrl: "https://api.deepseek.com", models: [] } } },
      agents: { defaults: { model: { primary: "anthropic/claude-opus-5", fallbacks: [RETIRED_CHAT_REF] } } },
    });

    await connectClawai();

    expect(callFor("agents.defaults.model")).toBeUndefined();
  });

  it("still configures chat when the image-understanding write fails", async () => {
    // Non-fatal by design: a chat provider that works is worth more than a
    // picture slot, so this must not fail the whole Connect ClawBox AI flow.
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
