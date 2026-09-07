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
    // Present, and RESOLVING by default, so a ClawBox AI save exercises the
    // ordinary box — the one whose deepseek provider plugin is already
    // installed. Omit it and every such case throws at `fs.access`, falls into
    // the missing-plugin branch and spends the save installing a plugin, which
    // is not the path these cases are about.
    access: vi.fn(),
  },
}));

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/home/clawbox/clawbox/data",
  getAll: vi.fn(),
  setMany: vi.fn(),
  // `get`/`set` are how the route reads and clears the persisted ClawBox AI
  // credential refusal (@/lib/clawai-credential-refusal, TASK-727). Omit them
  // and `clawaiCredentialRefusalOnRecord()` throws into its own catch and
  // answers `false` for every case in this file — so the image-ops gate would
  // never be exercised here, and nothing would say so. Backed by the same
  // `store` the other two use, so a clear the route performs is visible to a
  // read taken after it.
  get: vi.fn(),
  set: vi.fn(),
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

// The Hermes apply, which on this SKU is what tells the agent anything at all.
// Partial, so `ClawaiApplyError` stays the real class the route catches.
const applyClawaiToHermesMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-clawai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-clawai")>()),
  applyClawaiToHermes: applyClawaiToHermesMock,
}));

// The transport the refresh ends at. Mocked HERE rather than mocking
// `refreshCodingAgentToolsIfReadinessChanged` itself, so the real guard runs and
// the assertion is about the agent being asked, not about a call being made.
// Spread the real module: the refresh families import its shared log sentences
// (`MCP_RELOAD_ASKED`), and a factory that lists only the two functions makes
// every one of them fail to import here rather than in production.
vi.mock("@/lib/hermes-mcp-reload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-mcp-reload")>()),
  reloadMcpServers: vi.fn(),
  reportMcpReloadRefused: vi.fn(),
}));

import { getAll, setMany, get as configGet, set as configSet } from "@/lib/config-store";
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
    mockFs.access.mockResolvedValue(undefined);
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
    // The same store, so the refusal gate reads what this request wrote.
    vi.mocked(configGet).mockImplementation(async (key: string) => store[key]);
    vi.mocked(configSet).mockImplementation(async (key: string, value: unknown) => {
      if (value === undefined) delete store[key];
      else store[key] = value;
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

    // The stand-in does the ONE thing the cases below pin about the real apply:
    // it performs the coding-agent refresh from the snapshot it is handed
    // (`hermes-clawai.ts` does that and the provider and image refreshes too;
    // its own suites pin those). Without this the route's cases would be
    // asserting over a helper that does nothing.
    applyClawaiToHermesMock.mockReset();
    applyClawaiToHermesMock.mockImplementation(
      async (_token: string, _tier: string, options?: { codingAgentReadyBefore?: boolean }) => {
        const { refreshCodingAgentToolsIfReadinessChanged } = await import("@/lib/coding-agent-mcp-refresh");
        if (options?.codingAgentReadyBefore !== undefined) {
          const after = (await mockGetCodingAgentStatus()).ready;
          await refreshCodingAgentToolsIfReadinessChanged(options.codingAgentReadyBefore, after);
        }
        return { provider: "clawai", model: "deepseek-v4-flash", tier: "flash", explicitPickKept: false };
      },
    );

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
    // And the refusal gate really ASKED the store, rather than throwing into
    // its own catch over a `get` the factory did not provide. Without this the
    // mock could be trimmed back to `getAll`/`setMany` and every case here
    // would go on passing over an image-ops gate that never ran (TASK-727).
    expect(vi.mocked(configGet)).toHaveBeenCalledWith("clawai_credential_refused_at");
  });

  it("hands the credential to HERMES, which is the agent answering on this box", async () => {
    // The defect: everything the route does above configures OpenClaw, and on
    // the dual SKU Hermes is what the owner is talking to. It keeps its own
    // provider catalogue, image backend and speech slot, so
    // `ai_set_provider("clawai")` went on answering "That provider is not set
    // up on this device" over a token that had just been pasted and stored.
    const res = await configurePost(jsonRequest({ provider: "clawai", apiKey: CLAWAI_TOKEN }));

    expect(res.status).toBe(200);
    expect(applyClawaiToHermesMock).toHaveBeenCalledTimes(1);
    const [token, tier, options] = applyClawaiToHermesMock.mock.calls[0];
    expect(token).toBe(CLAWAI_TOKEN);
    expect(typeof tier).toBe("string");
    // The two snapshots the route holds and the apply cannot take for itself:
    // the token is already in the store by then, so its own reads would answer
    // about THIS save — ready true whatever the box looked like a moment ago,
    // and no account change on a real re-link.
    expect(options).toMatchObject({ codingAgentReadyBefore: false });
    expect(options).toHaveProperty("previousClawaiToken");
  });

  it("asks for ONE reload, not two, when it hands the save to Hermes", async () => {
    // The apply performs the coding-agent, provider and image refreshes from
    // its own before/after pair. A second global reload from this route would
    // respawn every MCP child again and invalidate the model's prompt cache a
    // second time for one save.
    await configurePost(jsonRequest({ provider: "clawai", apiKey: CLAWAI_TOKEN }));

    expect(applyClawaiToHermesMock).toHaveBeenCalledTimes(1);
    expect(mockReloadMcpServers).toHaveBeenCalledTimes(1);
  });

  it("still answers 200 when Hermes will not take the credential", async () => {
    // OpenClaw is configured and the token is on disk by then: a Hermes write
    // that fails must not turn a save that landed into an error. It is logged,
    // loudly, because the agent's own view is what the owner judges it by.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    applyClawaiToHermesMock.mockRejectedValue(new Error("hermes config set failed"));

    const res = await configurePost(jsonRequest({ provider: "clawai", apiKey: CLAWAI_TOKEN }));

    expect(res.status).toBe(200);
    expect(store.clawai_token).toBe(CLAWAI_TOKEN);
    expect(err.mock.calls.flat().join(" ")).toMatch(/Hermes did not take it/);
  });

  it("does not touch Hermes for a save that is not ClawBox AI", async () => {
    await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-ant-test" }));
    expect(applyClawaiToHermesMock).not.toHaveBeenCalled();
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

  it("does not reload — or even ASK — on a save that writes no ClawBox AI credential", async () => {
    const res = await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-ant-test" }));

    expect(res.status).toBe(200);
    expect(mockReloadMcpServers).not.toHaveBeenCalled();
    // The cost guard, pinned. Asserting only "no reload" would hold even if the
    // route probed on EVERY provider save — with no `clawai_token` the verdict
    // is false before and after either way — and each probe is a config read
    // plus PATH scans for `claude`, the wrapper and `setpriv`, plus a readdir of
    // the owner's project folder, on a Jetson.
    expect(mockGetCodingAgentStatus).not.toHaveBeenCalled();
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
    // The BEFORE probe. The route never gets a verdict to compare against, so
    // it must not buy a reload on a guess — and must not turn the save into a
    // 500 either.
    mockGetCodingAgentStatus.mockRejectedValue(new Error("cannot read the store"));

    const res = await configurePost(jsonRequest({ provider: "clawai", apiKey: CLAWAI_TOKEN }));

    expect(res.status).toBe(200);
    expect(mockReloadMcpServers).not.toHaveBeenCalled();
  });

  it("still answers 200 when the probe throws AFTER the credential is written", async () => {
    // The other half, and the one that matters more: by then the token IS on
    // disk. The save has landed and must be reported as landed.
    //
    // On this SKU the post-write probe is the APPLY's — the route hands it the
    // before-snapshot and the apply reads `ready` again for itself — so a probe
    // that throws is a Hermes hand-off that failed, and the route's own refresh
    // is the backstop: the credential changed, the tool list has to be asked
    // for either way. The one thing that must NOT happen is a 500 over a save
    // that landed.
    vi.spyOn(console, "error").mockImplementation(() => {});
    applyClawaiToHermesMock.mockImplementation(async () => {
      // Asserted INSIDE the apply, so the ordering is pinned and not just the
      // count: a regression that handed Hermes the credential BEFORE storing it
      // would still answer 200 and still refresh.
      expect(store.clawai_token).toBe(CLAWAI_TOKEN);
      throw new Error("cannot read the store");
    });

    const res = await configurePost(jsonRequest({ provider: "clawai", apiKey: CLAWAI_TOKEN }));

    expect(res.status).toBe(200);
    expect(store.clawai_token).toBe(CLAWAI_TOKEN);
    // The apply was reached, and the route still asked for the rebuild the save
    // earned.
    expect(applyClawaiToHermesMock).toHaveBeenCalledTimes(1);
    expect(mockReloadMcpServers).toHaveBeenCalledTimes(1);
    // And the owner is TOLD. The apply is a sequence of independent
    // `hermes config set` calls that throws on the first failing one, so it can
    // stop with Hermes pointed at the clawai provider and the previous
    // provider's model still named — every turn then fails while this route
    // answers 200. Saying nothing here is the false-success shape; the journal
    // line is not a surface the owner has.
    expect((await res.json()).warning).toMatch(/on-device agent has not taken the credential/);
  });

  it("does not ask for a reload when the route's own backstop probe throws too", async () => {
    // Both probes gone: the apply failed and the route's own post-write read of
    // `getCodingAgentStatus` throws as well. A reload respawns every MCP child
    // and invalidates the model's prompt cache, so an UNKNOWN verdict must not
    // buy one — and the save still has to be reported as landed.
    vi.spyOn(console, "error").mockImplementation(() => {});
    applyClawaiToHermesMock.mockImplementation(async () => {
      throw new Error("hermes did not take it");
    });
    // Ready BEFORE (the route's own snapshot, taken ahead of the write), then
    // unreadable afterwards.
    mockGetCodingAgentStatus
      .mockImplementationOnce(readyFromStore)
      .mockRejectedValue(new Error("cannot read the store"));

    const res = await configurePost(jsonRequest({ provider: "clawai", apiKey: CLAWAI_TOKEN }));

    expect(res.status).toBe(200);
    expect(store.clawai_token).toBe(CLAWAI_TOKEN);
    expect(mockReloadMcpServers).not.toHaveBeenCalled();
  });

  /*
   * The OTHER fix this card names — swapping `openclawIsAbsent()` for
   * `(await getActiveHarness()) === "hermes"` at the Hermes early return — is
   * NOT taken, and this case is why.
   *
   * That early return's local-model arm is `isLocalScope && (isLlamaCpp ||
   * isOllama)`, and a PRIMARY-scope local save does not match it. It does not
   * fall through to the branch's closing 400 either, which is worse: for a
   * local provider the `apiKey` slot carries the MODEL ID (both
   * `/setup-api/llamacpp/install` and `useOllamaModels` post it that way), so
   * `normalizedApiKey` is non-empty and the save would match the branch's THIRD
   * arm — handed to `applyCloudProviderKeyToHermes` with a model id as the API
   * key. Today it takes the OpenClaw path and is registered with Hermes on the
   * way out, by the block whose comment says in as many words "This branch runs
   * on the `dual` SKU, where OpenClaw exists but Hermes is the harness actually
   * answering". `@/lib/hermes-cloud-provider` is deliberately NOT mocked here,
   * so an attempted swap fails loudly rather than quietly.
   */
  it("keeps configuring a primary-scope local model on dual, rather than diverting it", async () => {
    // The shape `configureLlamaCpp` actually sends: for a local provider the
    // `apiKey` slot carries the model id.
    const res = await configurePost(jsonRequest({
      provider: "llamacpp",
      apiKey: "gemma4-e2b-it-q4_0",
      authMode: "local",
    }));

    expect(res.status).toBe(200);
    expect(store.ai_model_configured).toBe(true);
  });
});
