import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import fsp from "fs/promises";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";

/**
 * TASK-577, SITE 1 — the dual SKU.
 *
 * `getCodingAgentStatus().ready` is `enabled` AND the coding harness installed
 * AND ClawBox AI connected, and "connected" IS the `clawai_token` key in the
 * device store. The ClawBox MCP server registers `coding_agent_run` /
 * `_status` / `_stop` only when that is true, and it asks ONCE while it boots —
 * it is then a long-lived stdio child of the agent. So a save that flips
 * readiness without asking the agent to rebuild its tool list leaves Settings
 * saying "ready" over an agent that has none of the three tools.
 *
 * Every OTHER writer of `clawai_token` already closes that: the Hermes route
 * snapshots the verdict before its write and `applyClawaiToHermes` refreshes,
 * and `coding-agent-mcp-refresh`'s own docblock states the invariant —
 * "`applyClawaiToHermes` is what writes `clawai_token`, and every Hermes connect
 * entry point funnels through it". THIS route is the counter-example, and it is
 * reachable on the dual SKU: `openclawIsAbsent()` is `readEdition() === hermes`,
 * so on `edition=dual` with `active_harness=hermes` the route takes the OpenClaw
 * path, writes the token with its own `setMany`, and nothing tells the running
 * Hermes agent.
 *
 * Mocks are configure-images.test.ts's set (the route's collaborators), plus the
 * harness, the coding-agent status and the reload transport — so what is
 * asserted is the reload actually being ASKED FOR, not that a helper was called.
 */

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
}));

vi.mock("@/lib/clawkeep", () => ({
  unpairLocal: vi.fn(),
}));

// With the harness pinned to Hermes below, the real one of these reaches for the
// Hermes dashboard and the whole request waits on a socket that is not there.
// Neither is under test: the switch is bookkeeping the route does after the
// credential write.
vi.mock("@/lib/provider-enablement", () => ({
  getDisabledProviders: async () => new Set<string>(),
  setProviderEnabled: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/provider-runnable", () => ({
  forgetProviderEnumerations: vi.fn(async () => {}),
  recordProviderEnumeration: vi.fn(async () => {}),
  readProviderRunnable: vi.fn(async () => new Map()),
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

vi.mock("@/lib/openclaw-config", () => ({
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

// PARTIAL — a whole-module factory here HANGS the route: `@/lib/harness` has
// nine other exports and the ones this graph reaches are then `undefined`.
vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: vi.fn(),
}));

vi.mock("@/lib/coding-agent", () => ({ getCodingAgentStatus: vi.fn() }));

// The transport the refresh ends at. Mocked HERE rather than mocking
// `refreshCodingAgentToolsIfReadinessChanged` itself, so the real guard runs and
// the assertion is about the agent being asked, not about a call being made.
vi.mock("@/lib/hermes-mcp-reload", () => ({
  reloadMcpServers: vi.fn(),
  reportMcpReloadRefused: vi.fn(),
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
import { getActiveHarness } from "@/lib/harness";
import { getCodingAgentStatus } from "@/lib/coding-agent";
import { reloadMcpServers } from "@/lib/hermes-mcp-reload";


const mockSpawn = vi.mocked(childProcess.spawn);
const mockGetAll = vi.mocked(getAll);
const mockSetMany = vi.mocked(setMany);
const mockReadConfig = vi.mocked(readConfig);
const mockReadConfigStrict = vi.mocked(readConfigStrict);
const mockRunOpenclawConfigSet = vi.mocked(runOpenclawConfigSet);
const mockRunOpenclawConfigSetBatch = vi.mocked(runOpenclawConfigSetBatch);
const mockFs = vi.mocked(fsp);
let mockGetActiveHarness: ReturnType<typeof vi.mocked<typeof getActiveHarness>>;
let mockGetCodingAgentStatus: ReturnType<typeof vi.mocked<typeof getCodingAgentStatus>>;
let mockReloadMcpServers: ReturnType<typeof vi.mocked<typeof reloadMcpServers>>;

/**
 * The same three-part rule `getCodingAgentStatus` applies, with the two halves
 * this route cannot move (the switch, the installed harness) pinned on: what is
 * left is exactly "is ClawBox AI connected", which IS `clawai_token` in the
 * store. Bound to the live `store` below rather than to a fixed answer, so a
 * fixture cannot pass for the route doing the right thing.
 */
let store: Record<string, unknown> = {};
async function readyFromStore(): Promise<Awaited<ReturnType<typeof getCodingAgentStatus>>> {
  const token = store.clawai_token;
  return { ready: typeof token === "string" && token.trim() !== "" } as Awaited<
    ReturnType<typeof getCodingAgentStatus>
  >;
}

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

describe("POST /setup-api/ai-models/configure — the coding agent's tool list on the dual SKU", () => {
  let configurePost: (req: Request) => Promise<Response>;

  function jsonRequest(body: unknown): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
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
    mockReadConfig.mockResolvedValue({});
    mockReadConfigStrict.mockResolvedValue({});
    vi.mocked(inferConfiguredLocalModel).mockReturnValue(null);
    vi.mocked(restartGateway).mockResolvedValue();
    mockSpawn.mockImplementation(() => createSuccessfulChildProcess());
    mockRunOpenclawConfigSet.mockResolvedValue(undefined);
    mockRunOpenclawConfigSetBatch.mockResolvedValue(undefined);
    vi.mocked(unpairLocal).mockResolvedValue(undefined);
    vi.mocked(applyModelOverrideToAllAgentSessions).mockResolvedValue({ filesUpdated: 0, sessionsUpdated: 0, sessionsSkipped: 0 });
    vi.mocked(parseFullyQualifiedModel).mockImplementation(parseFullyQualifiedModelImpl);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));

    // A real store, because the fact under test is one the route WRITES: a
    // fixture that answered a fixed `ready` would pass whatever the route did.
    store = {};
    mockGetAll.mockImplementation(async () => ({ ...store }));
    mockSetMany.mockImplementation(async (entries: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(entries)) {
        if (value === undefined) delete store[key];
        else store[key] = value;
      }
    });
    // Resolved from the SAME post-reset module registry the route imports, the
    // way configure-hermes.test.ts does: a handle captured at file scope is a
    // different `vi.fn()` after `vi.resetModules()`, so an implementation set on
    // it never reaches the route — and `getActiveHarness` then answers
    // `undefined` where the route awaits a harness.
    const harnessMod = await import("@/lib/harness");
    mockGetActiveHarness = vi.mocked(harnessMod.getActiveHarness);
    // The dual SKU: the openclaw binary EXISTS (so `openclawIsAbsent()` is
    // false and the route takes the OpenClaw path), and Hermes is the agent
    // actually answering.
    mockGetActiveHarness.mockResolvedValue("hermes");

    const codingMod = await import("@/lib/coding-agent");
    mockGetCodingAgentStatus = vi.mocked(codingMod.getCodingAgentStatus);
    mockGetCodingAgentStatus.mockImplementation(readyFromStore);

    const reloadMod = await import("@/lib/hermes-mcp-reload");
    mockReloadMcpServers = vi.mocked(reloadMod.reloadMcpServers);
    mockReloadMcpServers.mockResolvedValue(true);

    const ocMod = await import("@/lib/openclaw-config");
    vi.mocked(ocMod.openclawIsAbsent).mockReturnValue(false);

    const mod = await import("@/app/setup-api/ai-models/configure/route");
    configurePost = mod.POST;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks the agent to rebuild its tool list when this save connects ClawBox AI", async () => {
    const res = await configurePost(jsonRequest({ provider: "clawai", apiKey: CLAWAI_TOKEN }));

    expect(res.status).toBe(200);
    expect(store.clawai_token).toBe(CLAWAI_TOKEN);
    expect(mockReloadMcpServers).toHaveBeenCalledTimes(1);
  });

  it("does not charge a reload for a save that changed nothing about readiness", async () => {
    // The guard half. A reload respawns every MCP child and invalidates the
    // model's prompt cache, so the next turn re-pays for a cached system
    // prompt — a re-save of a token this box already holds must not buy that.
    store.clawai_token = CLAWAI_TOKEN;

    const res = await configurePost(jsonRequest({ provider: "clawai", apiKey: CLAWAI_TOKEN }));

    expect(res.status).toBe(200);
    expect(mockReloadMcpServers).not.toHaveBeenCalled();
  });

  it("does not reload on a save that writes no ClawBox AI credential", async () => {
    const res = await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-ant-test" }));

    expect(res.status).toBe(200);
    expect(mockReloadMcpServers).not.toHaveBeenCalled();
  });

  it("samples the verdict BEFORE the write, not after it", async () => {
    // The ordering trap the Hermes route documents: read `ready` one line later
    // and the answer is always true, the before/after guard sees no change, and
    // the box ends up with a panel that says ready over an agent that has none
    // of the three tools.
    const readyWhenAsked: boolean[] = [];
    mockGetCodingAgentStatus.mockImplementation(async () => {
      const ready = typeof store.clawai_token === "string" && (store.clawai_token as string).trim() !== "";
      readyWhenAsked.push(ready);
      return { ready } as Awaited<ReturnType<typeof getCodingAgentStatus>>;
    });

    await configurePost(jsonRequest({ provider: "clawai", apiKey: CLAWAI_TOKEN }));

    expect(readyWhenAsked).toEqual([false, true]);
  });

  it("still answers 200 when the agent refuses the reload", async () => {
    // The credential IS written by the time the refresh runs. A best-effort
    // rebuild that could not be done must not turn the owner's save into an
    // error — the switch is enforced route-side either way and the tool list
    // catches up at the next respawn.
    mockReloadMcpServers.mockResolvedValue(false);

    const res = await configurePost(jsonRequest({ provider: "clawai", apiKey: CLAWAI_TOKEN }));

    expect(res.status).toBe(200);
    expect(store.clawai_token).toBe(CLAWAI_TOKEN);
  });

  it("still answers 200 when the readiness probe itself throws", async () => {
    mockGetCodingAgentStatus.mockRejectedValue(new Error("cannot read the store"));

    const res = await configurePost(jsonRequest({ provider: "clawai", apiKey: CLAWAI_TOKEN }));

    expect(res.status).toBe(200);
    expect(mockReloadMcpServers).not.toHaveBeenCalled();
  });

  /*
   * The OTHER fix this card names — swapping `openclawIsAbsent()` for
   * `(await getActiveHarness()) === "hermes"` at the Hermes early return — is
   * NOT taken, and this case is why. That early return's local-model arm is
   * `isLocalScope && (isLlamaCpp || isOllama)`; a PRIMARY-scope local save on a
   * dual box does not match it, matches neither of the other two arms, and
   * would fall through to the branch's closing 400. Today that save takes the
   * OpenClaw path and is registered with Hermes on the way out — the block at
   * the end of it that says in as many words "This branch runs on the `dual`
   * SKU, where OpenClaw exists but Hermes is the harness actually answering".
   * Pinned so the predicate swap cannot be made without this failing first.
   */
  it("keeps configuring a primary-scope local model on dual, rather than refusing it", async () => {
    const res = await configurePost(jsonRequest({ provider: "llamacpp" }));

    expect(res.status).toBe(200);
    expect(store.ai_model_configured).toBe(true);
  });
});
