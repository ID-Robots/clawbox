import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/openclaw-config", () => ({
  spawnOpenclawCli: vi.fn(),
  restartGateway: vi.fn(),
  gatewayIsAbsent: () => false,
  gatewayReadyWaitMs: () => 1000,
  GatewayNotReadyError: class GatewayNotReadyError extends Error {
    constructor(message = "gateway did not come back") {
      super(message);
      this.name = "GatewayNotReadyError";
    }
  },
}));
vi.mock("@/lib/openclaw-auth-store", () => ({ readGatewayProviderAuth: vi.fn() }));
vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>()),
  waitForGatewayRpcReady: vi.fn(async () => true),
}));
vi.mock("@/lib/gateway-unit-job", () => ({
  runUnitJob: vi.fn(),
  UNIT_JOB_SETTLE_BUDGET_MS: 360_000,
  unitIsStopped: (state: { activeState: string }) => state.activeState === "inactive" || state.activeState === "failed",
}));

import { GatewayRpcError, GatewayWsUnavailableError } from "@/lib/openclaw-gateway-ws";
import {
  _setAuthOpsDepsForTests,
  logoutOpenclawAuthProfiles,
  saveOpenclawApiKey,
  setOpenclawAuthOrder,
  withOpenclawGatewayStopped,
} from "@/lib/openclaw-auth-ops";

/**
 * OpenClaw 2026.11.3 refuses `models auth` writes from the CLI while its
 * gateway owns the state (docs/cli/models.md "Auth profiles"): with the
 * gateway up these go to its RPCs, and only a gateway that is not there gets
 * the CLI, offline.
 */
function harness(opts: { up?: boolean; held?: string[] | null; refuse?: string; unitUp?: boolean; comesUp?: boolean } = {}) {
  let calls = 0;
  const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
    calls += 1;
    // `comesUp`: the first ask finds a gateway still starting, the next one answers.
    if (opts.up === false && !(opts.comesUp && calls > 1)) throw new GatewayWsUnavailableError("connect ECONNREFUSED");
    if (opts.refuse) throw new GatewayRpcError(opts.refuse, "UNAVAILABLE");
    if (method === "models.authSetApiKey") return { provider: params.provider, profileId: `${String(params.provider)}:default` };
    return { ok: true };
  });
  const cli = vi.fn(async () => "");
  const stopGateway = vi.fn(async () => {});
  const startGateway = vi.fn(async () => {});
  const waitForGateway = vi.fn(async () => opts.comesUp === true);
  _setAuthOpsDepsForTests({
    gatewayAuthRpc: rpc,
    offlineAuthCli: cli,
    stopGateway,
    startGateway,
    storeProfiles: () => (opts.held === undefined ? [] : opts.held),
    // By default a socket that does not answer belongs to a unit that is down.
    gatewayUnitUp: async () => opts.unitUp === true,
    waitForGateway,
  });
  return { rpc, cli, stopGateway, startGateway, waitForGateway };
}

afterEach(() => _setAuthOpsDepsForTests(null));

describe("saveOpenclawApiKey", () => {
  it("hands the key to the gateway's models.authSetApiKey while it runs, when the store holds the profile", async () => {
    const h = harness({ held: ["google:default"] });
    const saved = await saveOpenclawApiKey("google", "google:default", "AIza-test-key");
    expect(h.rpc).toHaveBeenCalledWith("models.authSetApiKey", { provider: "google", apiKey: "AIza-test-key" }, 60_000);
    expect(h.cli).not.toHaveBeenCalled();
    expect(saved).toEqual({ via: "gateway", profileId: "google:default" });
  });

  it("takes out a copy the gateway made under another id, and saves at ClawBox's id offline", async () => {
    // A provider with a `models.providers` entry: the gateway writes
    // `<provider>:manual` even beside `<provider>:default`.
    const h = harness({ held: ["openrouter:default"] });
    h.rpc.mockImplementation((async (method: string) => (method === "models.authSetApiKey" ? { provider: "openrouter", profileId: "openrouter:manual" } : {})) as never);
    const saved = await saveOpenclawApiKey("openrouter", "openrouter:default", "sk-or-test");
    expect(h.rpc).toHaveBeenCalledWith("models.authLogout", { provider: "openrouter", profileIds: ["openrouter:manual"] }, 60_000);
    expect(h.cli).toHaveBeenCalledWith(
      ["models", "auth", "paste-api-key", "--provider", "openrouter", "--profile-id", "openrouter:default"],
      { stdinData: "sk-or-test\n", timeoutMs: 60_000 },
    );
    expect(h.stopGateway).toHaveBeenCalledTimes(1);
    expect(saved).toEqual({ via: "cli", profileId: "openrouter:default" });
  });

  it("never takes out a profile the store held before, even when the gateway wrote into it", async () => {
    const h = harness({ held: ["openrouter:default", "openrouter:manual"] });
    h.rpc.mockImplementation((async (method: string) => (method === "models.authSetApiKey" ? { provider: "openrouter", profileId: "openrouter:manual" } : {})) as never);
    await saveOpenclawApiKey("openrouter", "openrouter:default", "sk-or-test");
    expect(h.rpc).not.toHaveBeenCalledWith("models.authLogout", expect.anything(), expect.anything());
  });

  it("saves a FIRST key at ClawBox's id offline, the gateway stopped and started around it", async () => {
    // models.authSetApiKey would create `<provider>:manual` for a provider the
    // store holds no API-key profile of.
    const h = harness({ held: [], unitUp: true });
    const order: string[] = [];
    h.stopGateway.mockImplementation(async () => { order.push("stop"); });
    h.cli.mockImplementation(async () => { order.push("paste"); return ""; });
    h.startGateway.mockImplementation(async () => { order.push("start"); });
    const saved = await saveOpenclawApiKey("openrouter", "openrouter:default", "sk-or-test");
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.cli).toHaveBeenCalledWith(
      ["models", "auth", "paste-api-key", "--provider", "openrouter", "--profile-id", "openrouter:default"],
      { stdinData: "sk-or-test\n", timeoutMs: 60_000 },
    );
    expect(order).toEqual(["stop", "paste", "start"]);
    expect(saved).toEqual({ via: "cli", profileId: "openrouter:default" });
  });

  it("pastes offline through the CLI, key on stdin, when no gateway answers", async () => {
    const h = harness({ up: false });
    const saved = await saveOpenclawApiKey("deepseek", "deepseek:default", "claw_test");
    expect(h.cli).toHaveBeenCalledWith(
      ["models", "auth", "paste-api-key", "--provider", "deepseek", "--profile-id", "deepseek:default"],
      { stdinData: "claw_test\n", timeoutMs: 60_000 },
    );
    expect(saved.via).toBe("cli");
  });

  it("waits for a gateway that is starting — it already owns the state — and asks it, never the CLI", async () => {
    // Seen in CI: the wizard restarted the gateway, and the key save that came
    // while it started went to the CLI with --profile-id, which it refused.
    const h = harness({ up: false, unitUp: true, comesUp: true, held: ["deepseek:default"] });
    const saved = await saveOpenclawApiKey("deepseek", "deepseek:default", "claw_test");
    expect(h.waitForGateway).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledTimes(2);
    expect(h.cli).not.toHaveBeenCalled();
    expect(saved.via).toBe("gateway");
  });

  it("says the assistant is starting when a gateway that owns the state never answers, and writes nothing around it", async () => {
    const h = harness({ up: false, unitUp: true, comesUp: false, held: ["deepseek:default"] });
    await expect(saveOpenclawApiKey("deepseek", "deepseek:default", "claw_test")).rejects.toThrow(/starting/);
    expect(h.cli).not.toHaveBeenCalled();
  });

  it("passes the gateway's refusal on and does not retry it through the CLI", async () => {
    const h = harness({ held: ["openai:default"], refuse: "The API-key profile belongs to another sign-in. Manage that saved sign-in first" });
    await expect(saveOpenclawApiKey("openai", "openai:default", "sk-test")).rejects.toThrow(/belongs to another sign-in/);
    expect(h.cli).not.toHaveBeenCalled();
  });
});

describe("logoutOpenclawAuthProfiles", () => {
  it("asks models.authLogout for the ids the store holds, and only those", async () => {
    const h = harness({ held: ["deepseek:default", "deepseek:other"] });
    const removed = await logoutOpenclawAuthProfiles("deepseek", ["deepseek:default", "deepseek:ghost"]);
    expect(h.rpc).toHaveBeenCalledWith("models.authLogout", { provider: "deepseek", profileIds: ["deepseek:default"] }, 60_000);
    expect(removed).toEqual(["deepseek:default"]);
  });

  it("asks nothing when the store holds none of them", async () => {
    const h = harness({ held: [] });
    expect(await logoutOpenclawAuthProfiles("xai", ["xai:default"])).toEqual([]);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("logs out offline through the CLI, one id at a time, when no gateway answers", async () => {
    const h = harness({ up: false, held: null });
    await logoutOpenclawAuthProfiles("anthropic", ["anthropic:a", "anthropic:b"]);
    expect(h.cli.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      ["models", "auth", "logout", "anthropic:a", "--yes"],
      ["models", "auth", "logout", "anthropic:b", "--yes"],
    ]);
  });
});

describe("setOpenclawAuthOrder", () => {
  it("names every profile the store holds, the asked ones first", async () => {
    const h = harness({ held: ["openai:chatgpt", "openai:default", "openai:work"] });
    await setOpenclawAuthOrder("openai", ["openai:default", "openai:missing"]);
    expect(h.rpc).toHaveBeenCalledWith("models.authOrderSet", { provider: "openai", profileIds: ["openai:default", "openai:chatgpt", "openai:work"] }, 60_000);
  });

  it("clears the order by leaving the ids out", async () => {
    const h = harness({ held: [] });
    await setOpenclawAuthOrder("openai", null);
    expect(h.rpc).toHaveBeenCalledWith("models.authOrderSet", { provider: "openai" }, 60_000);
  });

  it("sets or clears offline through the CLI when no gateway answers", async () => {
    const h = harness({ up: false, held: ["anthropic:a"] });
    await setOpenclawAuthOrder("anthropic", ["anthropic:a"]);
    await setOpenclawAuthOrder("anthropic", []);
    expect(h.cli.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      ["models", "auth", "order", "set", "--provider", "anthropic", "anthropic:a"],
      ["models", "auth", "order", "clear", "--provider", "anthropic"],
    ]);
  });
});

describe("withOpenclawGatewayStopped", () => {
  it("takes a gateway that was started but is still coming up as started", async () => {
    const { restartGateway, GatewayNotReadyError } = await import("@/lib/openclaw-config");
    vi.mocked(restartGateway).mockRejectedValueOnce(new GatewayNotReadyError("gateway did not come back"));
    _setAuthOpsDepsForTests({ stopGateway: async () => undefined });
    await expect(withOpenclawGatewayStopped(async () => "done")).resolves.toBe("done");
    // ...after waiting for it once more, so nobody is handed an assistant that cannot answer yet.
    const { waitForGatewayRpcReady } = await import("@/lib/openclaw-gateway-ws");
    expect(vi.mocked(waitForGatewayRpcReady)).toHaveBeenCalledWith(3000);
    vi.mocked(restartGateway).mockRejectedValueOnce(new Error("Job for clawbox-gateway.service failed"));
    await expect(withOpenclawGatewayStopped(async () => "done")).rejects.toThrow(/failed/);
  });

  it("fails a start that still answers nothing after the extra wait", async () => {
    const { restartGateway, GatewayNotReadyError } = await import("@/lib/openclaw-config");
    const { waitForGatewayRpcReady } = await import("@/lib/openclaw-gateway-ws");
    vi.mocked(restartGateway).mockRejectedValueOnce(new GatewayNotReadyError("gateway did not come back"));
    vi.mocked(waitForGatewayRpcReady).mockResolvedValueOnce(false);
    _setAuthOpsDepsForTests({ stopGateway: async () => undefined });
    await expect(withOpenclawGatewayStopped(async () => "done")).rejects.toThrow(/did not come back/);
  });

  it("gives up on a slow stop after a minute for a caller answering a request, and waits it out for one that asks to", async () => {
    const { runUnitJob } = await import("@/lib/gateway-unit-job");
    vi.mocked(runUnitJob).mockResolvedValue({ kind: "returned" });
    _setAuthOpsDepsForTests({ startGateway: async () => undefined });

    await withOpenclawGatewayStopped(async () => "done");
    expect(vi.mocked(runUnitJob).mock.calls.at(-1)?.[2]).toMatchObject({ unit: "clawbox-gateway.service", timeoutMs: 15_000, settleBudgetMs: 45_000 });

    // The account pool's token pastes: the unit may take TimeoutStopSec=330.
    await withOpenclawGatewayStopped(async () => "done", { waitOutStop: true });
    expect(vi.mocked(runUnitJob).mock.calls.at(-1)?.[2]).toMatchObject({ unit: "clawbox-gateway.service", timeoutMs: 15_000, settleBudgetMs: 360_000 });
  });

  it("still fails a stop that outlives even the unit's own budget, the work not run and the gateway started again", async () => {
    const { runUnitJob } = await import("@/lib/gateway-unit-job");
    vi.mocked(runUnitJob).mockResolvedValue({ kind: "in-flight", state: null, waitedMs: 360_000 });
    const startGateway = vi.fn(async () => undefined);
    _setAuthOpsDepsForTests({ startGateway });
    const work = vi.fn(async () => "done");
    await expect(withOpenclawGatewayStopped(work, { waitOutStop: true })).rejects.toThrow(/still stopping/);
    expect(work).not.toHaveBeenCalled();
    expect(startGateway).toHaveBeenCalledTimes(1);
  });

  it("does not run offline work beside a gateway that a restart brought back while its stop was being waited for", async () => {
    const { runUnitJob } = await import("@/lib/gateway-unit-job");
    // The stop's client gave up, a restart asked for elsewhere took the stop
    // job's place, and the job that settled left the unit UP.
    vi.mocked(runUnitJob).mockResolvedValue({ kind: "settled", state: { job: "", activeState: "active", subState: "running", result: "success" }, waitedMs: 40_000 });
    const startGateway = vi.fn(async () => undefined);
    _setAuthOpsDepsForTests({ startGateway });
    const work = vi.fn(async () => "done");
    await expect(withOpenclawGatewayStopped(work, { waitOutStop: true })).rejects.toThrow(/did not stay stopped/);
    expect(work).not.toHaveBeenCalled();
    expect(startGateway).toHaveBeenCalledTimes(1);

    // A stop that settled with the unit down is a stop.
    vi.mocked(runUnitJob).mockResolvedValue({ kind: "settled", state: { job: "", activeState: "inactive", subState: "dead", result: "success" }, waitedMs: 40_000 });
    await expect(withOpenclawGatewayStopped(work, { waitOutStop: true })).resolves.toBe("done");
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("reports the stop's own failure when the start after it fails too", async () => {
    const h = harness();
    h.stopGateway.mockRejectedValueOnce(new Error("the gateway is still stopping"));
    h.startGateway.mockRejectedValueOnce(new Error("restart refused"));
    await expect(withOpenclawGatewayStopped(async () => "done")).rejects.toThrow(/still stopping/);
    expect(h.startGateway).toHaveBeenCalledTimes(1);
  });

  it("starts the gateway again when the stop itself throws", async () => {
    const h = harness();
    h.stopGateway.mockRejectedValueOnce(new Error("the gateway is still stopping"));
    const work = vi.fn(async () => "done");
    await expect(withOpenclawGatewayStopped(work)).rejects.toThrow(/still stopping/);
    expect(work).not.toHaveBeenCalled();
    expect(h.startGateway).toHaveBeenCalledTimes(1);
  });

  it("stops the gateway, runs the offline work and starts it again, also when the work fails", async () => {
    const h = harness();
    const order: string[] = [];
    h.stopGateway.mockImplementation(async () => { order.push("stop"); });
    h.startGateway.mockImplementation(async () => { order.push("start"); });
    await expect(withOpenclawGatewayStopped(async () => { order.push("work"); throw new Error("refused"); })).rejects.toThrow("refused");
    expect(order).toEqual(["stop", "work", "start"]);
  });
});
