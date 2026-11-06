import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The gateway's own WebSocket client, with the REAL error classes: the module
// under test narrows on them.
vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>();
  return {
    ...actual,
    gatewayWsCall: vi.fn(),
    waitForGatewayRpcReady: vi.fn(async () => true),
  };
});

vi.mock("@/lib/port-probe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/port-probe")>();
  return { ...actual, isPortOpen: vi.fn(async () => true) };
});

vi.mock("@/lib/openclaw-config", () => ({
  restartGateway: vi.fn(async () => {}),
  gatewayReadyWaitMs: () => 30000,
}));

import {
  awaitGatewayHotApply,
  diffConfigPaths,
  gatewayHotApplyWaitMs,
  gatewayReloadKind,
  readGatewayConfigBaseline,
  refreshGatewayModelAuth,
  restartGatewayAnsweringEarly,
  restartRequiredPaths,
  settleConfigWrite,
  waitForGatewayBack,
} from "@/lib/gateway-hot-apply";
import {
  GatewayRpcError,
  GatewayWsUnavailableError,
  gatewayWsCall,
  waitForGatewayRpcReady,
} from "@/lib/openclaw-gateway-ws";
import { isPortOpen } from "@/lib/port-probe";
import { restartGateway } from "@/lib/openclaw-config";
import { markGatewayRestartBegun } from "@/lib/gateway-restart-tracker";

const call = vi.mocked(gatewayWsCall);
const portOpen = vi.mocked(isPortOpen);

/** A `config.get` answer: the runtime has applied `applied`, the file is at `revision`. */
function configGet(hash: string, revision: string | null, applied: string | null) {
  return { hash, configRevisionHash: revision, appliedConfigHash: applied, config: {} };
}

beforeEach(() => {
  vi.clearAllMocks();
  portOpen.mockResolvedValue(true);
  vi.mocked(waitForGatewayRpcReady).mockResolvedValue(true);
  vi.mocked(restartGateway).mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.GATEWAY_HOT_APPLY_WAIT_MS;
  vi.restoreAllMocks();
});

describe("gatewayReloadKind — the core's reload table, longest prefix wins", () => {
  it.each([
    // What a model switch writes: all applied live.
    ["agents.defaults.model.primary", "hot"],
    ["agents.defaults.model.fallbacks", "hot"],
    ["agents.defaults.models.openai/gpt-5.5.agentRuntime", "hot"],
    ["agents.defaults.imageModel", "hot"],
    ["models.mode", "hot"],
    ["models.providers.llamacpp.baseUrl", "hot"],
    ["auth.profiles.openai:default", "hot"],
    ["auth.order.openai", "hot"],
    ["plugins.entries.anthropic.enabled", "hot"],
    ["plugins.allow", "hot"],
    ["tools.media.audio.baseUrl", "hot"],
    ["tts.providers.openai.apiKey", "hot"],
    ["gateway.controlUi.allowedOrigins", "hot"],
    // Read on use, no reload action at all.
    ["meta.lastTouchedAt", "none"],
    ["messages.tts.provider", "none"],
    ["session.dmScope", "none"],
    ["gateway.reload.mode", "none"],
  ])("%s → %s", (path, kind) => {
    expect(gatewayReloadKind(path)).toBe(kind);
  });

  it.each([
    "gateway.auth.token",
    "gateway.auth.mode",
    "gateway.port",
    "gateway.bind",
    "secrets.egressProxy",
    "mcp.apps.listen",
    "discovery.wideArea",
    // ClawBox keeps the restart for plugin code arriving or leaving.
    "plugins.installs.deepseek",
    "plugins.load.paths",
    // A path the table does not name fails safe, as it does in the core.
    "somethingNew.entirely",
    "memory.search",
    "<root>",
  ])("%s → restart", (path) => {
    expect(gatewayReloadKind(path)).toBe("restart");
  });
});

describe("diffConfigPaths / restartRequiredPaths", () => {
  it("names the leaves that changed, and arrays as one value", () => {
    const before = {
      agents: { defaults: { model: { primary: "a/one", fallbacks: ["a/two"] } } },
      gateway: { auth: { mode: "token", token: "t1" } },
    };
    const after = {
      agents: { defaults: { model: { primary: "b/one", fallbacks: ["a/two"] } } },
      gateway: { auth: { mode: "token", token: "t1" } },
      models: { providers: { llamacpp: { baseUrl: "http://x" } } },
    };
    expect(diffConfigPaths(before, after).sort()).toEqual([
      "agents.defaults.model.primary",
      "models.providers.llamacpp.baseUrl",
    ]);
    expect(diffConfigPaths({ a: { list: [1, 2] } }, { a: { list: [1, 3] } })).toEqual(["a.list"]);
    expect(diffConfigPaths(before, structuredClone(before))).toEqual([]);
  });

  it("counts an empty object appearing or vanishing as a change at its own path", () => {
    expect(diffConfigPaths({}, { plugins: { entries: {} } })).toEqual(["plugins.entries"]);
    expect(diffConfigPaths({ tts: {} }, {})).toEqual(["tts"]);
  });

  it("is empty for a save that only hot-applies", () => {
    expect(restartRequiredPaths(
      { agents: { defaults: { model: { primary: "a/x" } } }, gateway: { auth: { token: "same" } } },
      {
        agents: { defaults: { model: { primary: "b/y" } } },
        gateway: { auth: { token: "same" } },
        plugins: { entries: { anthropic: { enabled: true } } },
        meta: { lastTouchedAt: "now" },
      },
    )).toEqual([]);
  });

  it("names a rotated gateway token", () => {
    expect(restartRequiredPaths(
      { gateway: { auth: { mode: "token", token: "old" } } },
      { gateway: { auth: { mode: "token", token: "new" } } },
    )).toEqual(["gateway.auth.token"]);
  });

  it("fails safe for a snapshot that could not be read", () => {
    // An unreadable openclaw.json comes in as {}, so the gateway block is "new".
    expect(restartRequiredPaths({}, { gateway: { auth: { mode: "token" } } })).toEqual(["gateway.auth.mode"]);
  });
});

describe("readGatewayConfigBaseline", () => {
  it("keeps the raw-file hash", async () => {
    call.mockResolvedValueOnce(configGet("h0", "r0", "r0"));
    await expect(readGatewayConfigBaseline()).resolves.toEqual({ hash: "h0" });
    expect(call).toHaveBeenCalledWith("config.get", {}, expect.objectContaining({ timeoutMs: expect.any(Number) }));
  });

  it("answers null, never throws, when the gateway does not answer", async () => {
    call.mockRejectedValueOnce(new GatewayWsUnavailableError("connect ECONNREFUSED"));
    await expect(readGatewayConfigBaseline()).resolves.toBeNull();
  });
});

describe("awaitGatewayHotApply", () => {
  it("has nothing to wait for when nothing was written", async () => {
    await expect(awaitGatewayHotApply({ baseline: null, configChanged: false, credentialsWritten: false }))
      .resolves.toEqual({ applied: true, how: "nothing-to-apply" });
    expect(call).not.toHaveBeenCalled();
  });

  it("waits until the runtime reports the NEW revision applied, then refreshes the auth state", async () => {
    call
      // Still the old file: the watcher has not seen the write.
      .mockResolvedValueOnce(configGet("h0", "r0", "r0"))
      // The new file, not applied yet.
      .mockResolvedValueOnce(configGet("h1", "r1", "r0"))
      // Applied.
      .mockResolvedValueOnce(configGet("h1", "r1", "r1"))
      // models.authRefresh
      .mockResolvedValueOnce({ refreshed: true });

    const result = await awaitGatewayHotApply({
      baseline: { hash: "h0" },
      configChanged: true,
      credentialsWritten: true,
      budgetMs: 5_000,
    });

    expect(result).toEqual({ applied: true, how: "hot-reload" });
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      "config.get",
      "config.get",
      "config.get",
      "models.authRefresh",
    ]);
    expect(call).toHaveBeenLastCalledWith("models.authRefresh", { operation: "update" }, expect.anything());
  });

  it("does not take a stale answer about the OLD file as an acknowledgment", async () => {
    // Runtime and file agree — about the file as it was before the save.
    call.mockResolvedValue(configGet("h0", "r0", "r0"));

    const result = await awaitGatewayHotApply({
      baseline: { hash: "h0" },
      configChanged: true,
      credentialsWritten: false,
      budgetMs: 600,
    });

    expect(result).toEqual({ applied: false, why: "not-confirmed" });
  });

  it("does not confirm a revision the gateway refused to load", async () => {
    // An invalid file has no revision hash; the last good runtime stays.
    call.mockResolvedValue(configGet("h1", null, "r0"));

    await expect(awaitGatewayHotApply({
      baseline: { hash: "h0" },
      configChanged: true,
      credentialsWritten: false,
      budgetMs: 600,
    })).resolves.toEqual({ applied: false, why: "not-confirmed" });
  });

  it("calls a gateway that answered nothing and listens on nothing down", async () => {
    portOpen.mockResolvedValue(false);

    await expect(awaitGatewayHotApply({ baseline: null, configChanged: true, credentialsWritten: true }))
      .resolves.toEqual({ applied: false, why: "gateway-down" });
    expect(call).not.toHaveBeenCalled();
  });

  it("polls a gateway that listens but did not answer the baseline (busy), without a hash to compare", async () => {
    call.mockResolvedValueOnce(configGet("h1", "r1", "r1"));

    await expect(awaitGatewayHotApply({ baseline: null, configChanged: true, credentialsWritten: false, budgetMs: 2_000 }))
      .resolves.toEqual({ applied: true, how: "hot-reload" });
  });

  it("recognises a gateway that went away mid-wait as restarting by itself", async () => {
    call
      .mockResolvedValueOnce(configGet("h1", "r1", "r0"))
      .mockRejectedValueOnce(new GatewayWsUnavailableError("connect ECONNREFUSED"));
    portOpen.mockResolvedValue(false);

    await expect(awaitGatewayHotApply({ baseline: { hash: "h0" }, configChanged: true, credentialsWritten: false, budgetMs: 5_000 }))
      .resolves.toEqual({ applied: false, why: "gateway-restarting" });
  });

  it("keeps polling through a busy moment while the port stays open", async () => {
    call
      .mockRejectedValueOnce(new GatewayWsUnavailableError("gateway handshake timed out"))
      .mockResolvedValueOnce(configGet("h1", "r1", "r1"));

    await expect(awaitGatewayHotApply({ baseline: { hash: "h0" }, configChanged: true, credentialsWritten: false, budgetMs: 5_000 }))
      .resolves.toEqual({ applied: true, how: "hot-reload" });
  });

  it("gives up at once when this server holds no token it can ask with", async () => {
    call.mockRejectedValue(new GatewayWsUnavailableError("no gateway token"));

    await expect(awaitGatewayHotApply({ baseline: null, configChanged: true, credentialsWritten: false, budgetMs: 5_000 }))
      .resolves.toEqual({ applied: false, why: "not-confirmed" });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("refreshes the auth state even when openclaw.json did not change (a re-pasted key)", async () => {
    call.mockResolvedValueOnce({ refreshed: true });

    await expect(awaitGatewayHotApply({ baseline: { hash: "h0" }, configChanged: false, credentialsWritten: true }))
      .resolves.toEqual({ applied: true, how: "hot-reload" });
    expect(call).toHaveBeenCalledWith("models.authRefresh", { operation: "update" }, expect.anything());
  });

  it("is not confirmed when the auth state could not be rebuilt", async () => {
    call.mockRejectedValueOnce(new GatewayRpcError("refused", "UNAVAILABLE"));

    await expect(awaitGatewayHotApply({ baseline: { hash: "h0" }, configChanged: false, credentialsWritten: true }))
      .resolves.toEqual({ applied: false, why: "auth-refresh-failed" });
  });
});

describe("refreshGatewayModelAuth", () => {
  it("falls back to models.authStatus { refresh: true } on a core without models.authRefresh", async () => {
    call
      .mockRejectedValueOnce(new GatewayRpcError("unknown method: models.authRefresh", "INVALID_REQUEST"))
      .mockResolvedValueOnce({});

    await expect(refreshGatewayModelAuth()).resolves.toBe(true);
    expect(call).toHaveBeenLastCalledWith("models.authStatus", { refresh: true }, expect.anything());
  });

  it("answers false, never throws", async () => {
    call.mockRejectedValueOnce(new GatewayWsUnavailableError("gone"));
    await expect(refreshGatewayModelAuth()).resolves.toBe(false);
  });
});

describe("settleConfigWrite", () => {
  it("asks for a restart, without waiting, when only a restart applies the change", async () => {
    await expect(settleConfigWrite({
      before: { gateway: { auth: { token: "a" } } },
      after: { gateway: { auth: { token: "b" } } },
      baseline: { hash: "h0" },
      label: "test",
    })).resolves.toBe("restart-required");
    expect(call).not.toHaveBeenCalled();
  });

  it("answers applied once the gateway confirms a hot change", async () => {
    call.mockResolvedValueOnce(configGet("h1", "r1", "r1"));
    await expect(settleConfigWrite({
      before: { agents: { defaults: { model: { primary: "a/x" } } } },
      after: { agents: { defaults: { model: { primary: "llamacpp/y" } } } },
      baseline: { hash: "h0" },
      label: "test",
    })).resolves.toBe("applied");
    // A selection, not a credential: no auth refresh.
    expect(call.mock.calls.map(([method]) => method)).toEqual(["config.get"]);
  });

  it("answers applied for a write that changed nothing, without asking", async () => {
    await expect(settleConfigWrite({ before: { a: 1 }, after: { a: 1 }, baseline: null, label: "test" }))
      .resolves.toBe("applied");
    expect(call).not.toHaveBeenCalled();
  });

  it("passes on a gateway restarting by itself, and a down one as a restart", async () => {
    call
      .mockResolvedValueOnce(configGet("h1", "r1", "r0"))
      .mockRejectedValueOnce(new GatewayWsUnavailableError("connect ECONNREFUSED"));
    portOpen.mockResolvedValueOnce(false);
    const change = { before: { models: { mode: "merge" } }, after: { models: { mode: "replace" } } };
    await expect(settleConfigWrite({ ...change, baseline: { hash: "h0" }, label: "test" })).resolves.toBe("gateway-restarting");

    portOpen.mockResolvedValueOnce(false);
    await expect(settleConfigWrite({ ...change, baseline: null, label: "test" })).resolves.toBe("restart-required");
  });
});

describe("gatewayHotApplyWaitMs", () => {
  it("is ten seconds unless an operator overrides it with a sane value", () => {
    expect(gatewayHotApplyWaitMs()).toBe(10_000);
    process.env.GATEWAY_HOT_APPLY_WAIT_MS = "2500";
    expect(gatewayHotApplyWaitMs()).toBe(2500);
    process.env.GATEWAY_HOT_APPLY_WAIT_MS = "soon";
    expect(gatewayHotApplyWaitMs()).toBe(10_000);
  });
});

describe("restartGatewayAnsweringEarly", () => {
  it("throws a restart refused inside the window — the failure the owner must act on", async () => {
    vi.mocked(restartGateway).mockRejectedValueOnce(new Error("Unit clawbox-gateway.service is masked."));
    await expect(restartGatewayAnsweringEarly({ refusalWindowMs: 1_000 })).rejects.toThrow(/masked/);
    expect(restartGateway).toHaveBeenCalledWith({ awaitReady: false });
  });

  it("returns while systemd is still restarting, and `back` follows the gateway answering", async () => {
    let finishRestart!: () => void;
    vi.mocked(restartGateway).mockImplementationOnce(() => new Promise<void>((resolve) => { finishRestart = resolve; }));

    const early = await restartGatewayAnsweringEarly({ refusalWindowMs: 20, readyWaitMs: 1234 });

    expect(waitForGatewayRpcReady).not.toHaveBeenCalled();
    finishRestart();
    await expect(early.back).resolves.toBe(true);
    expect(waitForGatewayRpcReady).toHaveBeenCalledWith(1234);
  });

  it("defaults `back` to twice the port budget", async () => {
    const early = await restartGatewayAnsweringEarly({ refusalWindowMs: 20 });
    await early.back;
    expect(waitForGatewayRpcReady).toHaveBeenCalledWith(60000);
  });

  it("turns a restart that fails after the window into `back: false`, never an unhandled rejection", async () => {
    let failRestart!: (err: Error) => void;
    vi.mocked(restartGateway).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { failRestart = reject; }));

    const early = await restartGatewayAnsweringEarly({ refusalWindowMs: 20 });
    failRestart(new Error("Command timed out"));

    await expect(early.back).resolves.toBe(false);
    expect(waitForGatewayRpcReady).not.toHaveBeenCalled();
  });
});

describe("waitForGatewayBack", () => {
  it("waits out a restart in flight, then for the gateway to answer", async () => {
    const over = markGatewayRestartBegun();
    const waiting = waitForGatewayBack(10_000);
    await new Promise((r) => setTimeout(r, 30));
    expect(waitForGatewayRpcReady).not.toHaveBeenCalled();
    over();
    await expect(waiting).resolves.toBe(true);
    expect(waitForGatewayRpcReady).toHaveBeenCalled();
  });

  it("gives up when the restart outlives the budget", async () => {
    const over = markGatewayRestartBegun();
    try {
      await expect(waitForGatewayBack(50)).resolves.toBe(false);
    } finally {
      over();
    }
  });
});
