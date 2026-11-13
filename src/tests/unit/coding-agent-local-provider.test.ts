/**
 * The `local` coding provider and the local-only AI lock (TASK-2501 PR-E).
 *
 *  1. `local` is Claude Code on the box's own engine: its run carries no
 *     ClawBox AI proxy, no model override and no credential — only where the
 *     box's Messages-API route is — and it is denied WebSearch and WebFetch.
 *  2. Under the lock (`ai_cloud_lock`, read failing closed by feature-engine)
 *     the box's engine is the ONLY provider: the default, the offered list,
 *     the connected list and every team role move there; a cloud provider is
 *     refused in words — Codex with the reason it cannot run on the engine —
 *     and no run makes pictures or speech. The stored choices are not touched.
 *  3. Without the lock nothing changes for a normal box: `local` is not
 *     offered unless the owner put it there.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const configGet = vi.hoisted(() => vi.fn());
const configGetAll = vi.hoisted(() => vi.fn());
const configSet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: configGet,
  getAll: configGetAll,
  set: configSet,
}));

const getAnthropicConnection = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-anthropic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-anthropic")>()),
  getAnthropicConnection,
}));
const getOpenAIConnection = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-openai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-openai")>()),
  getOpenAIConnection,
}));
// The lock, as PR-C reads it: one boolean per call, failing closed. Mocked so
// each case says which side of it the box is on.
const cloudAiLockOn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/feature-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/feature-engine")>()),
  cloudAiLockOn,
}));
const resolveLocalEngine = vi.hoisted(() => vi.fn());
vi.mock("@/lib/local-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/local-engine")>()),
  resolveLocalEngine,
}));

import os from "node:os";
import path from "node:path";
import { CODEX_LOCAL_REFUSAL, CODING_AGENT_PROVIDER_CONFIG_KEY, LOCAL_ENGINE_MODEL, lockedProviderRefusal } from "@/lib/coding-provider";
import {
  buildRunArgs,
  buildRunEnv,
  CodingAgentError,
  getCodingAgentStatus,
  getCodingProvider,
  getConnectedProviders,
  harnessStateDir,
  HELPER_MODEL,
  LOCAL_DENIED_TOOLS,
  setCodingProvider,
  setConnectedProviders,
  startRun,
  subagentDefinitionsFor,
  teamRoleModelMap,
} from "@/lib/coding-agent";
import { NO_ENGINE_ERROR } from "@/lib/local-anthropic-route";

const ENGINE = {
  kind: "clawext" as const,
  model: "dsv41-flash",
  modelRef: "clawext/dsv41-flash",
  chatUrl: "http://192.0.2.9:8899/v1/chat/completions",
  authorization: "Bearer engine-secret-key",
  contextTokens: 1_000_000,
  maxOutputTokens: 32_000,
  parallel: 1,
  imageInput: false,
};
const CONNECTED = { connected: true, hasKey: true, hasLogin: false, source: "key" as const };
const OPENAI_READY = { connected: true, hasKey: true, hasLogin: false, source: "key" as const, status: "connected", limitedUntil: null, codexInstalled: true };

/** A box that had every cloud account set up and a team pinned to them, before the owner turned the lock on. */
const CLOUD_BOX = {
  coding_agent_enabled: true,
  clawai_token: "claw_token",
  [CODING_AGENT_PROVIDER_CONFIG_KEY]: "anthropic",
  coding_agent_providers: ["clawbox-ai", "anthropic", "openai"],
  coding_agent_role_models: { planner: { provider: "anthropic", model: "claude-fable-5-2", effort: "high" }, worker: { provider: "openai", model: "economy" } },
  coding_agent_gen_images: true,
  coding_agent_gen_audio: true,
};

beforeEach(() => {
  configGet.mockReset().mockImplementation(async (key: string) => (CLOUD_BOX as Record<string, unknown>)[key]);
  configGetAll.mockReset().mockResolvedValue(CLOUD_BOX);
  configSet.mockReset().mockResolvedValue(undefined);
  getAnthropicConnection.mockReset().mockResolvedValue(CONNECTED);
  getOpenAIConnection.mockReset().mockResolvedValue(OPENAI_READY);
  cloudAiLockOn.mockReset().mockResolvedValue(false);
  resolveLocalEngine.mockReset().mockResolvedValue(ENGINE);
});

describe("a local run's environment and command line", () => {
  it("names the box's route and nothing a cloud run carries — no proxy, no model override, no credential", () => {
    const saved = { ...process.env };
    process.env.CLAWBOX_AI_PROXY_URL = "https://proxy.example/api/ai";
    process.env.CLAUDE_DS_MODEL = "deepseek-v4-flash[1m]";
    process.env.CLAUDE_DS_CONFIG_DIR = "/tmp/other-state";
    try {
      const env = buildRunEnv({ provider: "local", model: LOCAL_ENGINE_MODEL });
      expect(env.CLAUDE_DS_PROVIDER).toBe("local");
      expect(env.CLAUDE_DS_LOCAL_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1(:\d+)?\/setup-api\/local-ai\/anthropic$/);
      expect(env.CLAWBOX_AI_PROXY_URL).toBeUndefined();
      expect(env.CLAUDE_DS_MODEL).toBeUndefined();
      expect(env.CLAUDE_DS_CONFIG_DIR).toBeUndefined();
      expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
      // Neither the engine's key nor any token: the wrapper derives what it needs.
      expect(Object.values(env).join("\n")).not.toMatch(/engine-secret-key|clawbox-local-/);
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });

  it("gives a cloud run no local route", () => {
    expect(buildRunEnv({ provider: "clawbox-ai" }).CLAUDE_DS_LOCAL_BASE_URL).toBeUndefined();
    expect(buildRunEnv({ provider: "anthropic" }).CLAUDE_DS_LOCAL_BASE_URL).toBeUndefined();
  });

  it("denies WebSearch and WebFetch by rule on a local run only", () => {
    const denied = (provider: "local" | "clawbox-ai") => {
      const args = buildRunArgs({ provider, run: { id: "run-k3x9q2ab", directory: "/tmp/x" } });
      return args.slice(args.indexOf("--disallowedTools") + 1);
    };
    expect([...LOCAL_DENIED_TOOLS]).toEqual(["WebSearch", "WebFetch"]);
    expect(denied("local")).toEqual(expect.arrayContaining(["WebSearch", "WebFetch"]));
    expect(denied("clawbox-ai")).not.toContain("WebSearch");
    // Neither is a tool the run is handed in the first place.
    const args = buildRunArgs({ provider: "local", run: { id: "run-k3x9q2ab", directory: "/tmp/x" } });
    expect(args[args.indexOf("--tools") + 1]).not.toMatch(/WebSearch|WebFetch/);
  });

  it("runs its helpers on the alias the wrapper fills with the engine's model", () => {
    expect(HELPER_MODEL.local).toBe("haiku");
    for (const def of Object.values(subagentDefinitionsFor("local"))) expect((def as { model: string }).model).toBe("haiku");
  });

  it("keeps its Claude Code state apart from ClawBox AI's", () => {
    const saved = process.env.CLAUDE_DS_LOCAL_CONFIG_DIR;
    delete process.env.CLAUDE_DS_LOCAL_CONFIG_DIR;
    try {
      expect(harnessStateDir("local")).toBe(path.join(process.env.HOME || os.homedir(), ".claude-ds-local"));
      expect(harnessStateDir("local")).not.toBe(harnessStateDir("clawbox-ai"));
    } finally {
      if (saved !== undefined) process.env.CLAUDE_DS_LOCAL_CONFIG_DIR = saved;
    }
  });
});

describe("with no lock, nothing changes for a normal box", () => {
  it("keeps the owner's default and offered accounts, without the box's engine", async () => {
    const status = await getCodingAgentStatus();
    expect(status.cloudAiLocked).toBe(false);
    expect(status.provider).toBe("anthropic");
    expect(status.providers).toEqual(["clawbox-ai", "anthropic", "openai"]);
    expect(status.connectedProviders).toEqual(["clawbox-ai", "anthropic", "openai"]);
    expect(status.generateMedia).toBe(true);
    expect(status.localEngineModel).toBe("dsv41-flash");
    expect(await getCodingProvider()).toBe("anthropic");
  });

  it("still lets the owner put a run on the box's engine, which is ready when the engine is", async () => {
    expect(await setCodingProvider("local")).toBe("local");
    const status = await getCodingAgentStatus();
    expect(status.readiness.providers.find((p) => p.id === "local")!.problems).toEqual([]);
  });

  it("says why a local run cannot start on a box with no engine", async () => {
    resolveLocalEngine.mockResolvedValue(null);
    const status = await getCodingAgentStatus();
    expect(status.readiness.providers.find((p) => p.id === "local")!.problems).toEqual([NO_ENGINE_ERROR]);
    expect(status.localEngineModel).toBeNull();
  });
});

describe("under the local-only AI lock", () => {
  beforeEach(() => {
    cloudAiLockOn.mockResolvedValue(true);
  });

  it("runs on the box's engine alone, says so, and makes no media — without rewriting what the owner stored", async () => {
    const status = await getCodingAgentStatus();
    expect(status.cloudAiLocked).toBe(true);
    expect(status.provider).toBe("local");
    expect(status.providers).toEqual(["local"]);
    expect(status.connectedProviders).toEqual(["local"]);
    expect(status.generateMedia).toBe(false);
    expect(status.localEngineModel).toBe("dsv41-flash");
    expect(await getCodingProvider()).toBe("local");
    expect(await getConnectedProviders()).toEqual(["local"]);
    expect(configSet).not.toHaveBeenCalled();
  });

  it("marks every cloud provider not ready with the lock's words — Codex with why it cannot run on the engine", async () => {
    const { readiness } = await getCodingAgentStatus();
    const problems = (id: string) => readiness.providers.find((p) => p.id === id)!.problems;
    expect(problems("anthropic")).toEqual([lockedProviderRefusal("anthropic")]);
    expect(problems("clawbox-ai")).toEqual([lockedProviderRefusal("clawbox-ai")]);
    expect(problems("openai")).toEqual([lockedProviderRefusal("openai")]);
    expect(problems("openai")[0]).toContain(CODEX_LOCAL_REFUSAL);
    expect(CODEX_LOCAL_REFUSAL).toMatch(/Responses API \(\/v1\/responses\)/);
    expect(problems("local")).toEqual([]);
  });

  it("puts every team role on the box's engine, the stored pins kept for later", async () => {
    const map = await teamRoleModelMap();
    for (const role of ["planner", "worker", "reviewer"] as const) {
      expect(map[role]).toMatchObject({ provider: "local", model: LOCAL_ENGINE_MODEL });
    }
    // The planner's stored effort is the owner's, and stays.
    expect(map.planner.effort).toBe("high");
  });

  it("refuses to store a cloud provider as the default or on the connected list", async () => {
    await expect(setCodingProvider("anthropic")).rejects.toThrow(/local-only AI lock is on/);
    await expect(setCodingProvider("openai")).rejects.toThrow(/Responses API/);
    await expect(setConnectedProviders(["local", "clawbox-ai"])).rejects.toBeInstanceOf(CodingAgentError);
    expect(configSet).not.toHaveBeenCalled();
    await expect(setConnectedProviders(["local"])).resolves.toMatchObject({ providers: ["local"] });
  });

  it("refuses a run named for a cloud provider, in the lock's words", async () => {
    const refusal = async (provider: string) => {
      try {
        await startRun({ task: "Do the thing", directory: "/nonexistent-for-this-test", source: "owner", provider });
        return "";
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    };
    expect(await refusal("anthropic")).toMatch(/local-only AI lock is on/);
    expect(await refusal("clawbox-ai")).toMatch(/local-only AI lock is on/);
    const codex = await refusal("openai");
    expect(codex).toMatch(/Codex cannot run on the box's own engine/);
    expect(codex).toMatch(/Responses API/);
  });

  it("refuses a local run on a box with no engine, before anything spawns", async () => {
    resolveLocalEngine.mockResolvedValue(null);
    const { readiness } = await getCodingAgentStatus();
    expect(readiness.providers.find((p) => p.id === "local")!.problems).toEqual([NO_ENGINE_ERROR]);
    expect(readiness.anyProviderReady).toBe(false);
    let message = "";
    try {
      await startRun({ task: "Do the thing", directory: "/nonexistent-for-this-test", source: "owner" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(NO_ENGINE_ERROR);
  });
});
