import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as childProcess from "child_process";
import fsp from "fs/promises";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

// The route writes auth-profiles.json through `fs/promises`; the surface
// reader reads the catalog cache through `fs`.promises. Two module ids, two
// mocks — and the `fs` one keeps the real module except for that one read, so
// nothing else that touches the filesystem loses its implementation.
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

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: actual,
    promises: { ...actual.promises, readFile: vi.fn() },
  };
});

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/home/clawbox/clawbox/data",
  getAll: vi.fn(),
  setMany: vi.fn(),
}));

vi.mock("@/lib/clawkeep", () => ({ unpairLocal: vi.fn() }));

// Out-of-band by design (see configure.test.ts) — stubbed so nothing logs
// after the test that triggered it has finished.
vi.mock("@/app/setup-api/ai-models/catalog/route", () => ({
  refreshInBackground: vi.fn(),
}));

const { parseFullyQualifiedModelImpl } = vi.hoisted(() => ({
  parseFullyQualifiedModelImpl(fq: string) {
    const idx = fq.indexOf("/");
    if (idx <= 0 || idx === fq.length - 1) return null;
    return { provider: fq.slice(0, idx), modelId: fq.slice(idx + 1) };
  },
}));

vi.mock("@/lib/openclaw-config", () => ({
  DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR: 24000,
  compactionReserveFloorForContext: () => 24000,
  restartGateway: vi.fn(),
  findOpenclawBin: vi.fn().mockReturnValue("/usr/local/bin/openclaw"),
  readConfig: vi.fn(),
  // The configure route reads the config STRICTLY before it removes an
  // openai-compat override, so the mock has to carry both readers.
  readConfigStrict: vi.fn().mockResolvedValue({}),
  inferConfiguredLocalModel: vi.fn(),
  runOpenclawConfigSet: vi.fn(),
  runOpenclawConfigSetBatch: vi.fn(),
  applyModelOverrideToAllAgentSessions: vi.fn(),
  parseFullyQualifiedModel: vi.fn(parseFullyQualifiedModelImpl),
  setProviderPlugins: vi.fn(),
  openclawIsAbsent: vi.fn().mockReturnValue(false),
  OpenclawUnavailableError: class OpenclawUnavailableError extends Error {},
}));

vi.mock("@/lib/llamacpp", () => ({
  getDefaultLlamaCppModel: vi.fn().mockReturnValue("gemma4-e2b-it-q4_0"),
  getLlamaCppContextWindow: vi.fn().mockReturnValue(131072),
  getLlamaCppMaxTokens: vi.fn().mockReturnValue(131072),
  getLlamaCppProxyBaseUrl: vi.fn().mockReturnValue("http://127.0.0.1/llamacpp/v1"),
}));

vi.mock("@/lib/local-ai-runtime", () => ({
  getLocalAiProxyBaseUrl: vi.fn(() => "http://127.0.0.1/local-ai"),
  getOllamaBaseUrl: vi.fn(() => "http://127.0.0.1:11434"),
}));

vi.mock("@/lib/local-ai-token", () => ({
  getLocalAiToken: vi.fn().mockReturnValue("a".repeat(64)),
  verifyLocalAiBearer: vi.fn().mockReturnValue(true),
  markLocalAiTokenMigrated: vi.fn(),
}));

import { promises as nodeFsPromises } from "fs";
import { getAll, setMany } from "@/lib/config-store";
import {
  readConfig,
  restartGateway,
  runOpenclawConfigSet,
  runOpenclawConfigSetBatch,
  applyModelOverrideToAllAgentSessions,
  inferConfiguredLocalModel,
  setProviderPlugins,
} from "@/lib/openclaw-config";
import { unpairLocal } from "@/lib/clawkeep";
import { findConfigSet } from "./config-set-calls";

const mockFs = vi.mocked(fsp);
const mockSurfaceRead = vi.mocked(nodeFsPromises.readFile);
const mockSpawn = vi.mocked(childProcess.spawn);

/** Model ids the `claude-cli` (Claude-subscription) surface really carries. */
const SURFACE_IDS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
];

/** The catalog route's disk cache for a surface provider, as it writes it. */
function surfaceCache(ids: string[]) {
  return JSON.stringify({
    provider: "claude-cli",
    models: ids.map((id) => ({ id, label: id, contextWindow: 200_000 })),
    defaultModelId: ids[0],
    allowCustom: false,
    fetchedAt: Date.now(),
  });
}

/** A spawned `openclaw` that exits 0 immediately — the happy-path stand-in. */
function successfulChild(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  emitter.stdin = { end: vi.fn() } as unknown as ChildProcess["stdin"];
  emitter.stdout = new EventEmitter() as unknown as ChildProcess["stdout"];
  emitter.stderr = new EventEmitter() as unknown as ChildProcess["stderr"];
  emitter.kill = vi.fn();
  queueMicrotask(() => emitter.emit("close", 0));
  return emitter;
}

/**
 * The wizard/Settings save is the SECOND write path to
 * `agents.defaults.model.primary` — the chat header's switch is the first, and
 * the one #520 guarded "for ids that arrive some other way". This is that
 * other way: the custom-model field validates the typed id for SHAPE only
 * ("we don't check against the curated list"), the picker deliberately exempts
 * a typed id from its greying-out rule, and the OAuth save posts whatever is
 * in that field verbatim. So a Claude-subscription box could be pinned, from
 * the wizard, to exactly the model the chat header now refuses.
 */
describe("POST /setup-api/ai-models/configure and the Claude subscription surface", () => {
  let configurePost: (request: Request) => Promise<Response>;

  /** A POST to this route carrying `body` as JSON. */
  function jsonRequest(body: unknown): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** The wizard's Claude sign-in save, with `body` overriding its fields. */
  function subscribe(body: Record<string, unknown> = {}) {
    return jsonRequest({
      provider: "anthropic",
      apiKey: "oauth-access-token",
      authMode: "subscription",
      ...body,
    });
  }

  /** Nothing was written: not the credential file, not one config key. */
  function expectNoSideEffects() {
    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(runOpenclawConfigSet).not.toHaveBeenCalled();
    expect(runOpenclawConfigSetBatch).not.toHaveBeenCalled();
    expect(restartGateway).not.toHaveBeenCalled();
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
    mockSurfaceRead.mockResolvedValue(surfaceCache(SURFACE_IDS) as never);

    vi.mocked(getAll).mockResolvedValue({});
    vi.mocked(setMany).mockResolvedValue();
    vi.mocked(readConfig).mockResolvedValue({} as never);
    vi.mocked(inferConfiguredLocalModel).mockReturnValue(null);
    vi.mocked(restartGateway).mockResolvedValue();
    vi.mocked(runOpenclawConfigSet).mockResolvedValue(undefined);
    vi.mocked(runOpenclawConfigSetBatch).mockResolvedValue(undefined);
    vi.mocked(applyModelOverrideToAllAgentSessions).mockResolvedValue({ filesUpdated: 0, sessionsUpdated: 0 });
    vi.mocked(setProviderPlugins).mockResolvedValue(undefined);
    vi.mocked(unpairLocal).mockResolvedValue(undefined);
    mockSpawn.mockImplementation(() => successfulChild());
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));

    const mod = await import("@/app/setup-api/ai-models/configure/route");
    configurePost = mod.POST;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("refuses a typed custom Claude id the subscription surface does not carry", async () => {
    const res = await configurePost(subscribe({ model: "claude-fable-5" }));

    expect(res.status).toBe(400);
    const { error } = await res.json();
    // Name the surface, exactly as the chat-header refusal does.
    expect(error).toContain("claude-cli");
    expect(error).toContain("claude-fable-5");
    // A rejection that has already persisted the credential is not a
    // rejection — it is a half-applied save the customer cannot see.
    expectNoSideEffects();
  });

  it("accepts a typed custom Claude id the subscription surface does carry", async () => {
    const res = await configurePost(subscribe({ model: "claude-opus-4-8" }));

    expect(res.status).toBe(200);
    expect(
      findConfigSet(
        vi.mocked(runOpenclawConfigSet),
        vi.mocked(runOpenclawConfigSetBatch),
        "agents.defaults.model.primary",
      )?.value,
    ).toBe("anthropic/claude-opus-4-8");
  });

  it("judges the provider DEFAULT too, not only a typed id", async () => {
    // The typed-id field is the way in that was reported, but the same write
    // carries the PROVIDERS-table default when nothing is typed. Guarding the
    // settled `config.defaultModel` covers both with one check.
    mockSurfaceRead.mockResolvedValue(
      surfaceCache(SURFACE_IDS.filter((id) => id !== "claude-sonnet-4-6")) as never,
    );

    const res = await configurePost(subscribe());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("claude-sonnet-4-6");
    expectNoSideEffects();
  });

  it("lets every Claude model through on an API-key save", async () => {
    // The save itself is what puts an anthropic key on the box, so this box is
    // not subscription-only once it lands — refusing here would block the very
    // switch the refusal message recommends.
    const res = await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      model: "claude-fable-5",
    }));

    expect(res.status).toBe(200);
  });

  it("lets a subscription save through when the box already holds an anthropic API key", async () => {
    // Both credentials means the API-only models still route.
    vi.mocked(readConfig).mockResolvedValue({
      auth: { profiles: { "anthropic:key": { provider: "anthropic", mode: "api_key" } } },
    } as never);

    const res = await configurePost(subscribe({ model: "claude-fable-5" }));

    expect(res.status).toBe(200);
  });

  it("lets the pick through when the surface could not be read at all", async () => {
    // UNKNOWN is not "no" — the same rule the pickers and the chat route obey.
    mockSurfaceRead.mockRejectedValue(new Error("ENOENT") as never);

    const res = await configurePost(subscribe({ model: "claude-fable-5" }));

    expect(res.status).toBe(200);
  });

  it("lets the pick through when the cached surface is empty", async () => {
    mockSurfaceRead.mockResolvedValue(surfaceCache([]) as never);

    const res = await configurePost(subscribe({ model: "claude-fable-5" }));

    expect(res.status).toBe(200);
  });

  it("does not read the Claude surface for a non-Claude provider", async () => {
    // The guard must cost nothing on a save it cannot apply to. On a Jetson a
    // stray cache read per save is not free.
    const res = await configurePost(jsonRequest({
      provider: "google",
      apiKey: "goog-key",
      model: "gemini-3-pro",
    }));

    expect(res.status).toBe(200);
    expect(mockSurfaceRead).not.toHaveBeenCalled();
  });
});
