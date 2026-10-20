import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import fsp from "fs/promises";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";

// The ClawBox AI MUSIC half of POST /setup-api/ai-models/configure.
//
// OpenClaw registers `music_generate` only when a music-generation provider is
// configured, and ClawBox provisioning configured none, so a Max box had no way
// to make a track. The write rides the same gates the cloud voice does — the
// media flag first (off unless the store says `music`), then the Max plan
// (internal tier `pro`) — and lands on the bundled `fal` provider pointed at the
// proxy's shared media route, because that provider has no chat catalog to leak
// into a picker and is not one ClawBox offers owners for their own key.
//
// The literals below are spelled out rather than imported on purpose: this file
// is the contract the proxy's media route is built against, and a renamed
// constant must show up here as a failing test rather than move the contract
// silently.

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

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
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => {}),
}));

vi.mock("@/lib/clawkeep", () => ({
  unpairLocal: vi.fn(),
}));

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

vi.mock("@/lib/gateway-hot-apply", async (importOriginal) =>
  (await import("@/tests/helpers/gateway-hot-apply")).gatewayHotApplyMock(importOriginal));
vi.mock("@/lib/openclaw-config", async () => ({
  ...(await import("./config-write-passthrough")).configWritePassthrough,
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

vi.mock("@/lib/openclaw-core-generation", () => ({
  installedOpenclawCoreGeneration: vi.fn(async () => "v2"),
}));

vi.mock("@/lib/local-ai-token", () => ({
  getLocalAiToken: vi.fn().mockReturnValue("a".repeat(64)),
  verifyLocalAiBearer: vi.fn().mockReturnValue(true),
  markLocalAiTokenMigrated: vi.fn(),
}));

import { getAll, setMany, get as configGet } from "@/lib/config-store";
import { unpairLocal } from "@/lib/clawkeep";
import {
  inferConfiguredLocalModel,
  readConfig,
  readConfigStrict,
  restartGateway,
  runOpenclawConfigSet,
  runOpenclawConfigSetBatch,
  runOpenclawConfigUnset,
  applyModelOverrideToAllAgentSessions,
  parseFullyQualifiedModel,
} from "@/lib/openclaw-config";
import { configSetCalls as recordedConfigSetCalls } from "./config-set-calls";
import { installedOpenclawCoreGeneration } from "@/lib/openclaw-core-generation";

const mockSpawn = vi.mocked(childProcess.spawn);
const mockGetAll = vi.mocked(getAll);
const mockSetMany = vi.mocked(setMany);
const mockConfigGet = vi.mocked(configGet);
const mockReadConfig = vi.mocked(readConfig);
const mockReadConfigStrict = vi.mocked(readConfigStrict);
const mockRunOpenclawConfigSet = vi.mocked(runOpenclawConfigSet);
const mockRunOpenclawConfigSetBatch = vi.mocked(runOpenclawConfigSetBatch);
const mockRunOpenclawConfigUnset = vi.mocked(runOpenclawConfigUnset);
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
const MEDIA_BASE_URL = "https://clawbox.com/api/ai/media";

/** The music slot, and the provider entry the slot names. */
const MUSIC_SLOT = "agents.defaults.mediaModels.music";
const MUSIC_REF = "fal/google/lyria-3-pro-preview";
const MUSIC_PROVIDER = "models.providers.fal";
const MUSIC_KEY = `${MUSIC_PROVIDER}.apiKey`;
const MUSIC_BASE_URL = `${MUSIC_PROVIDER}.baseUrl`;

/** The store keys the gate reads: the media flag and the two tier stamps. */
const FLAGS_KEY = "clawai_media_flags";
const PLAN_KEY = "clawai_plan_tier";
const BADGE_KEY = "clawai_tier";

describe("POST /setup-api/ai-models/configure — ClawBox AI music provider", () => {
  let configurePost: (req: Request) => Promise<Response>;
  let store: Record<string, unknown>;

  function jsonRequest(body: unknown): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function configSetCalls(): string[][] {
    return recordedConfigSetCalls(mockRunOpenclawConfigSet, mockRunOpenclawConfigSetBatch)
      .map((call) => call.args);
  }

  function callFor(path: string): string[] | undefined {
    return configSetCalls().find((args) => args[0] === path);
  }

  function unsetPaths(): string[] {
    return mockRunOpenclawConfigUnset.mock.calls.map((call) => String(call[0]));
  }

  /** A box whose store says this about the flag and the plan. */
  function box(stamps: { flags?: unknown; plan?: string; badge?: string }) {
    store = {};
    if (stamps.flags !== undefined) store[FLAGS_KEY] = stamps.flags;
    if (stamps.plan !== undefined) store[PLAN_KEY] = stamps.plan;
    if (stamps.badge !== undefined) store[BADGE_KEY] = stamps.badge;
  }

  /** What the box's OpenClaw config already carries. */
  function openclawConfig(config: Record<string, unknown>) {
    mockReadConfig.mockResolvedValue(config as never);
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    store = {};

    mockFs.readFile.mockResolvedValue(JSON.stringify({ version: 1, profiles: {} }));
    mockFs.writeFile.mockResolvedValue();
    mockFs.rename.mockResolvedValue();
    mockFs.chown.mockResolvedValue();
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.rm.mockResolvedValue(undefined);
    mockFs.unlink.mockResolvedValue(undefined);
    mockGetAll.mockResolvedValue({});
    mockConfigGet.mockImplementation(async (key: string) => store[key] as never);
    mockReadConfig.mockResolvedValue({});
    mockReadConfigStrict.mockResolvedValue({});
    vi.mocked(inferConfiguredLocalModel).mockReturnValue(null);
    vi.mocked(installedOpenclawCoreGeneration).mockResolvedValue("v2");
    mockSetMany.mockResolvedValue();
    vi.mocked(restartGateway).mockResolvedValue();
    mockSpawn.mockImplementation(() => createSuccessfulChildProcess());
    mockRunOpenclawConfigSet.mockResolvedValue(undefined);
    mockRunOpenclawConfigSetBatch.mockResolvedValue(undefined);
    mockRunOpenclawConfigUnset.mockResolvedValue(undefined);
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

  describe("arming", () => {
    it("points music_generate at the proxy on a Max box with the music flag on", async () => {
      box({ flags: ["music"], plan: "pro" });

      await connectClawai();

      const slot = callFor(MUSIC_SLOT);
      expect(slot?.[2]).toBe("--json");
      expect(JSON.parse(slot?.[1] ?? "null")).toEqual({ primary: MUSIC_REF });
      expect(callFor(MUSIC_KEY)).toEqual([MUSIC_KEY, CLAWAI_TOKEN]);
      expect(callFor(MUSIC_BASE_URL)).toEqual([MUSIC_BASE_URL, MEDIA_BASE_URL]);
    });

    it("writes leaf paths and no models[] row on the fal entry", async () => {
      box({ flags: ["music"], plan: "pro" });

      await connectClawai();

      const paths = configSetCalls().map((args) => args[0]);
      expect(paths).not.toContain(MUSIC_PROVIDER);
      expect(paths).not.toContain(`${MUSIC_PROVIDER}.models`);
    });

    it("arms on the device badge while the plan has never been recorded", async () => {
      // The ARM side may fall back to the badge, as the cloud voice does: the
      // worst it can do is write our own fields, which the next boot takes
      // back once the plan is on record.
      box({ flags: ["music"], badge: "pro" });

      await connectClawai();

      expect(JSON.parse(callFor(MUSIC_SLOT)?.[1] ?? "null")).toEqual({ primary: MUSIC_REF });
    });

    it("accepts the flag as a comma list, the way a hand-edited store spells it", async () => {
      box({ flags: "video_frames, music", plan: "pro" });

      await connectClawai();

      expect(callFor(MUSIC_SLOT)).toBeDefined();
    });

    it("arms on the fallback path too", async () => {
      box({ flags: ["music"], plan: "pro" });
      mockGetAll.mockResolvedValue({ clawai_token: CLAWAI_TOKEN });

      const res = await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-ant-key" }));

      expect(res.status).toBe(200);
      expect(callFor(MUSIC_SLOT)).toBeDefined();
    });
  });

  describe("not armed", () => {
    it.each([
      ["Free", "free"],
      ["Pro", "flash"],
    ])("writes no music slot on a %s plan", async (_label, plan) => {
      box({ flags: ["music"], plan });

      await connectClawai();

      expect(callFor(MUSIC_SLOT)).toBeUndefined();
      expect(callFor(MUSIC_KEY)).toBeUndefined();
      expect(callFor(MUSIC_BASE_URL)).toBeUndefined();
    });

    it("writes nothing on a Max box while the music flag is off — the default", async () => {
      box({ plan: "pro" });

      await connectClawai();

      expect(callFor(MUSIC_SLOT)).toBeUndefined();
      expect(callFor(MUSIC_KEY)).toBeUndefined();
    });

    it("ignores flag words it does not know", async () => {
      box({ flags: ["musik", "video_frames"], plan: "pro" });

      await connectClawai();

      expect(callFor(MUSIC_SLOT)).toBeUndefined();
    });

    it("lets a recorded Pro plan outrank a Max badge", async () => {
      // The plan is what the account pays for; the badge is only a default.
      box({ flags: ["music"], plan: "flash", badge: "pro" });

      await connectClawai();

      expect(callFor(MUSIC_SLOT)).toBeUndefined();
    });

    it("writes neither half on a v1 core, which has no music slot", async () => {
      box({ flags: ["music"], plan: "pro" });
      vi.mocked(installedOpenclawCoreGeneration).mockResolvedValue("v1");

      await connectClawai();

      expect(callFor(MUSIC_SLOT)).toBeUndefined();
      expect(callFor(MUSIC_KEY)).toBeUndefined();
    });

    it("leaves a music model the owner chose alone, and still arms nothing over it", async () => {
      box({ flags: ["music"], plan: "pro" });
      openclawConfig({ agents: { defaults: { mediaModels: { music: { primary: "minimax/music-2.6" } } } } });

      await connectClawai();

      expect(callFor(MUSIC_SLOT)).toBeUndefined();
      expect(unsetPaths()).not.toContain(MUSIC_SLOT);
    });

    it("never overwrites an owner's own fal key", async () => {
      box({ flags: ["music"], plan: "pro" });
      openclawConfig({ models: { providers: { fal: { apiKey: "fal-users-own-key" } } } });

      await connectClawai();

      expect(callFor(MUSIC_KEY)).toBeUndefined();
      expect(callFor(MUSIC_SLOT)).toBeUndefined();
    });

    it("never sends the portal token to a fal route the owner points elsewhere", async () => {
      box({ flags: ["music"], plan: "pro" });
      openclawConfig({ models: { providers: { fal: { baseUrl: "https://fal.run" } } } });

      await connectClawai();

      expect(callFor(MUSIC_KEY)).toBeUndefined();
      expect(callFor(MUSIC_SLOT)).toBeUndefined();
    });

    it("stands down when the owner has their own fal sign-in", async () => {
      box({ flags: ["music"], plan: "pro" });
      openclawConfig({ auth: { profiles: { "fal:default": { provider: "fal", mode: "api_key" } } } });

      await connectClawai();

      expect(callFor(MUSIC_KEY)).toBeUndefined();
      expect(callFor(MUSIC_SLOT)).toBeUndefined();
    });

    it("stands down when the owner set FAL_KEY in the config env", async () => {
      box({ flags: ["music"], plan: "pro" });
      openclawConfig({ env: { vars: { FAL_KEY: "fal-users-own-key" } } });

      await connectClawai();

      expect(callFor(MUSIC_KEY)).toBeUndefined();
    });
  });

  describe("withdrawing", () => {
    /** Exactly what an armed box carries. */
    function armedBox(extraFal: Record<string, unknown> = {}) {
      openclawConfig({
        models: { providers: { fal: { apiKey: "claw_old", baseUrl: MEDIA_BASE_URL, ...extraFal } } },
        agents: { defaults: { mediaModels: { music: { primary: MUSIC_REF } } } },
      });
    }

    it("takes our slot and our fal entry back once the plan is recorded below Max", async () => {
      box({ flags: ["music"], plan: "flash" });
      armedBox();

      await connectClawai();

      expect(unsetPaths()).toEqual(expect.arrayContaining([MUSIC_SLOT, MUSIC_PROVIDER]));
      expect(callFor(MUSIC_SLOT)).toBeUndefined();
    });

    it("takes them back when the music flag is switched off", async () => {
      box({ plan: "pro" });
      armedBox();

      await connectClawai();

      expect(unsetPaths()).toEqual(expect.arrayContaining([MUSIC_SLOT, MUSIC_PROVIDER]));
    });

    it("withdraws nothing on the badge alone while the plan is unknown", async () => {
      // Not knowing is not a downgrade: the WITHDRAW side reads the plan only.
      box({ flags: ["music"], badge: "flash" });
      armedBox();

      await connectClawai();

      expect(unsetPaths()).not.toContain(MUSIC_SLOT);
      expect(unsetPaths()).not.toContain(MUSIC_PROVIDER);
    });

    it("keeps an owner's own settings on the fal entry and removes only our leaves", async () => {
      box({ flags: ["music"], plan: "free" });
      armedBox({ headers: { "X-Team": "house" } });

      await connectClawai();

      expect(unsetPaths()).toEqual(expect.arrayContaining([MUSIC_SLOT, MUSIC_KEY, MUSIC_BASE_URL]));
      expect(unsetPaths()).not.toContain(MUSIC_PROVIDER);
    });

    it("never withdraws a slot the owner added fallbacks to", async () => {
      box({ flags: ["music"], plan: "free" });
      openclawConfig({
        agents: { defaults: { mediaModels: { music: { primary: MUSIC_REF, fallbacks: ["minimax/music-2.6"] } } } },
      });

      await connectClawai();

      expect(unsetPaths()).not.toContain(MUSIC_SLOT);
    });
  });
});
