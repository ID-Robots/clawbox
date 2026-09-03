import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

/**
 * The defect these cover: on the Hermes SKU the on-demand start gate was
 * derived from `~/.openclaw/openclaw.json`, which on that edition can never
 * carry `agents.defaults.model.primary` — the configure route returns early via
 * `openclawIsAbsent()` long before writing it. So `bootLlamaCppServer` always
 * logged "no llama.cpp primary or local fallback configured" and returned
 * without starting, while the caller went on to poll for 20 minutes for a
 * server nobody had launched.
 *
 * Every pre-existing test ran with an OpenClaw config present, which is exactly
 * why this was invisible.
 */

const spawnMock = vi.fn();
vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const readConfigMock = vi.fn();
vi.mock("@/lib/openclaw-config", () => ({
  readConfig: (...args: unknown[]) => readConfigMock(...args),
}));

const getAllMock = vi.fn();
vi.mock("@/lib/config-store", () => ({
  getAll: (...args: unknown[]) => getAllMock(...args),
  DATA_DIR: "/tmp/clawbox-test-data",
  CONFIG_ROOT: "/tmp/clawbox-test-root",
}));

const llamaCppMocks = {
  getConfiguredLlamaCppModelAlias: vi.fn(),
  getLocalAiConfigStoreAlias: vi.fn(),
  getLlamaCppLaunchSpec: vi.fn(),
  queryLlamaCppModels: vi.fn(),
  readLlamaCppPid: vi.fn(),
  isLlamaCppPidRunning: vi.fn(),
  clearLlamaCppPid: vi.fn(),
  ensureLlamaCppRuntimeDir: vi.fn(),
  writeLlamaCppPid: vi.fn(),
};
vi.mock("@/lib/llamacpp-server", () => llamaCppMocks);

vi.mock("@/lib/llamacpp", () => ({
  getDefaultLlamaCppModel: vi.fn(() => "gemma4-e2b-it-q4_0"),
}));

const LAUNCH_SPEC = {
  alias: "gemma4-e2b-it-q4_0",
  baseUrl: "http://127.0.0.1:8080/v1",
  host: "127.0.0.1",
  port: 8080,
  hfRepo: "google/gemma-4-E2B-it-qat-q4_0-gguf",
  hfFile: "gemma-4-E2B_q4_0-it.gguf",
  binPath: "/usr/local/bin/llama-server",
  hfBinPath: "/home/clawbox/.local/bin/hf",
  scriptPath: "/home/clawbox/clawbox/scripts/start-llamacpp.sh",
  pidPath: "/home/clawbox/clawbox/data/llamacpp/server.pid",
  logPath: "/home/clawbox/clawbox/data/llamacpp/server.log",
  modelDir: "/home/clawbox/clawbox/data/llamacpp/models",
  modelPath: "/home/clawbox/clawbox/data/llamacpp/models/gemma-4-E2B_q4_0-it.gguf",
  contextWindow: 131072,
  startupTimeoutMs: 1_200_000,
};

/** A child that looks alive enough for bootLlamaCppServer to accept it. */
function fakeChild(pid = 4242) {
  return { pid, on: vi.fn(), kill: vi.fn() };
}

type EmittingChild = EventEmitter & { pid: number | undefined; kill: () => void };

/** The supervisor's restart ceiling — the longest a pending retry can be armed for. */
const CHILD_RESTART_CEILING_MS = 60_000;

/**
 * A child that emits for real, so a missing listener fails the way Node fails:
 * an 'error' event nobody is listening for is an uncaught exception.
 */
function emittingChild(pid: number | undefined): EmittingChild {
  const child = new EventEmitter() as EmittingChild;
  child.pid = pid;
  child.kill = vi.fn();
  return child;
}

async function loadModule() {
  vi.resetModules();
  return await import("@/instrumentation-node");
}

describe("llama.cpp auto-start gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReturnValue(fakeChild());
    llamaCppMocks.getLlamaCppLaunchSpec.mockReturnValue(LAUNCH_SPEC);
    llamaCppMocks.queryLlamaCppModels.mockResolvedValue([]);
    llamaCppMocks.readLlamaCppPid.mockResolvedValue(null);
    llamaCppMocks.isLlamaCppPidRunning.mockReturnValue(false);
    llamaCppMocks.clearLlamaCppPid.mockResolvedValue(undefined);
    llamaCppMocks.ensureLlamaCppRuntimeDir.mockResolvedValue(undefined);
    llamaCppMocks.writeLlamaCppPid.mockResolvedValue(undefined);
    llamaCppMocks.getConfiguredLlamaCppModelAlias.mockReturnValue(null);
    // Mirrors the real helper: config-store record → bare alias, else null.
    llamaCppMocks.getLocalAiConfigStoreAlias.mockImplementation((state: Record<string, unknown>) => {
      if (state?.local_ai_configured !== true) return null;
      if (state?.local_ai_provider !== "llamacpp") return null;
      const stored = state?.local_ai_model;
      const bare = typeof stored === "string" ? stored.replace(/^llamacpp\//, "").trim() : "";
      return bare || "gemma4-e2b-it-q4_0";
    });
  });

  it("starts the server for an explicit alias on a Hermes device with an empty OpenClaw config", async () => {
    // Exactly the shipped state: openclaw.json holds only gateway.controlUi.
    readConfigMock.mockResolvedValue({ gateway: { controlUi: { allowedOrigins: [] } } });
    getAllMock.mockResolvedValue({
      local_ai_configured: true,
      local_ai_provider: "llamacpp",
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
    });

    const { startLlamaCppServer } = await loadModule();
    const status = await startLlamaCppServer("gemma4-e2b-it-q4_0");

    expect(status).toBe("started");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // The alias reaches the launcher script as argv[4].
    const [, argv] = spawnMock.mock.calls[0] as [string, string[]];
    expect(argv[4]).toBe("gemma4-e2b-it-q4_0");
  });

  it("auto-starts from the config store when OpenClaw has no primary (boot path, no alias)", async () => {
    readConfigMock.mockResolvedValue({});
    getAllMock.mockResolvedValue({
      local_ai_configured: true,
      local_ai_provider: "llamacpp",
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
    });

    const { startLlamaCppServer } = await loadModule();
    expect(await startLlamaCppServer()).toBe("started");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("still honours the OpenClaw primary as a trigger (openclaw/dual SKUs unchanged)", async () => {
    readConfigMock.mockResolvedValue({
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });
    getAllMock.mockResolvedValue({});
    llamaCppMocks.getConfiguredLlamaCppModelAlias.mockReturnValue("gemma4-e2b-it-q4_0");

    const { startLlamaCppServer } = await loadModule();
    expect(await startLlamaCppServer()).toBe("started");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("reports skipped-not-configured instead of silently doing nothing", async () => {
    readConfigMock.mockResolvedValue({});
    getAllMock.mockResolvedValue({});

    const { startLlamaCppServer } = await loadModule();
    expect(await startLlamaCppServer()).toBe("skipped-not-configured");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("still refuses to start when Local AI is explicitly disabled", async () => {
    readConfigMock.mockResolvedValue({});
    getAllMock.mockResolvedValue({
      local_ai_configured: false,
      local_ai_provider: "llamacpp",
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
    });

    const { startLlamaCppServer } = await loadModule();
    expect(await startLlamaCppServer("gemma4-e2b-it-q4_0")).toBe("skipped-disabled");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not spawn a second server when one is already running", async () => {
    readConfigMock.mockResolvedValue({});
    getAllMock.mockResolvedValue({ local_ai_configured: true, local_ai_provider: "llamacpp" });
    llamaCppMocks.queryLlamaCppModels.mockResolvedValue(["gemma4-e2b-it-q4_0"]);

    const { startLlamaCppServer } = await loadModule();
    expect(await startLlamaCppServer("gemma4-e2b-it-q4_0")).toBe("started");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

/**
 * What happens to the web server when the llama.cpp child goes wrong.
 *
 * A `spawn` that fails before a process exists emits 'error' — and an 'error'
 * event with no listener is an uncaught exception, so a child that merely could
 * not be created used to take the whole ClawBox web server down with it. The
 * failure is still the caller's to see, not the supervisor's to retry: the
 * second case pins that a child which really ran is respawned once per death,
 * not once per ending event Node delivers for it.
 */
describe("llama.cpp child supervision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    llamaCppMocks.getLlamaCppLaunchSpec.mockReturnValue(LAUNCH_SPEC);
    llamaCppMocks.queryLlamaCppModels.mockResolvedValue([]);
    llamaCppMocks.readLlamaCppPid.mockResolvedValue(null);
    llamaCppMocks.isLlamaCppPidRunning.mockReturnValue(false);
    llamaCppMocks.clearLlamaCppPid.mockResolvedValue(undefined);
    llamaCppMocks.ensureLlamaCppRuntimeDir.mockResolvedValue(undefined);
    llamaCppMocks.writeLlamaCppPid.mockResolvedValue(undefined);
    llamaCppMocks.getConfiguredLlamaCppModelAlias.mockReturnValue("gemma4-e2b-it-q4_0");
    readConfigMock.mockResolvedValue({});
    getAllMock.mockResolvedValue({ local_ai_configured: true, local_ai_provider: "llamacpp" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("survives a child that could not be spawned at all", async () => {
    const child = emittingChild(undefined);
    spawnMock.mockReturnValue(child);

    const { startLlamaCppServer } = await loadModule();
    await expect(startLlamaCppServer("gemma4-e2b-it-q4_0")).rejects.toThrow(/Failed to start llama.cpp/);

    // Node delivers this after the synchronous failure the caller already saw.
    expect(() => child.emit("error", new Error("spawn EAGAIN"))).not.toThrow();
  });

  it("retries a child that ran exactly once, not once per ending event", async () => {
    vi.useFakeTimers();
    const child = emittingChild(4242);
    spawnMock.mockReturnValue(child);

    const { startLlamaCppServer } = await loadModule();
    expect(await startLlamaCppServer("gemma4-e2b-it-q4_0")).toBe("started");
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // A real child emits both, in this order. A supervisor listening to each of
    // them would restart twice for one death.
    spawnMock.mockReturnValue(emittingChild(4243));
    child.emit("exit", 1);
    child.emit("close", 1);
    await vi.advanceTimersByTimeAsync(5000);

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  /**
   * Turning Local AI off has to stay off. `llamaCppStopping` alone cannot do
   * that: startLlamaCppServer clears it as its first act, so a restart timer
   * that fires after the stop un-stops the very thing that stopped it. Beta's
   * window for that was a fixed 5 s; with the backoff it reaches a minute.
   */
  it("a deliberate stop cancels a restart the supervisor had already armed", async () => {
    vi.useFakeTimers();
    const child = emittingChild(4242);
    spawnMock.mockReturnValue(child);

    const mod = await loadModule();
    expect(await mod.startLlamaCppServer("gemma4-e2b-it-q4_0")).toBe("started");
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // It dies, so a restart is armed...
    spawnMock.mockReturnValue(emittingChild(4243));
    child.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);

    // ...and the owner switches Local AI off while it is still pending.
    await mod.stopLlamaCppServer();
    await vi.advanceTimersByTimeAsync(CHILD_RESTART_CEILING_MS);

    expect(spawnMock, "a runtime the owner stopped restarted itself anyway").toHaveBeenCalledTimes(1);
  });

  /**
   * The other half of the same race. Cancelling the timer cannot cancel a start
   * that has already begun: the dynamic imports, the config read and the pid
   * probe all await, and startLlamaCppServer clears `llamaCppStopping` before
   * any of them — so an "off" landing mid-boot used to be simply overtaken.
   */
  it("does not spawn a runtime that was stopped while it was starting", async () => {
    spawnMock.mockReturnValue(emittingChild(4242));

    const mod = await loadModule();
    // The owner's stop lands while boot is still awaiting its config read.
    readConfigMock.mockImplementation(async () => {
      await mod.stopLlamaCppServer();
      return {};
    });

    await expect(mod.startLlamaCppServer("gemma4-e2b-it-q4_0")).rejects.toThrow(/stopped while it was starting/);
    expect(spawnMock, "a start the owner cancelled spawned anyway").not.toHaveBeenCalled();
  });

  /**
   * A stopped child must not rearm its own chain. Its exit handler awaits the
   * pid cleanup, and that await is long enough for a stop AND a fresh start to
   * land — the start clears `llamaCppStopping`, so a flag-only check let the
   * dead child schedule a retry of its old alias against the new runtime.
   */
  it("does not let a child that was stopped rearm its restart chain", async () => {
    vi.useFakeTimers();
    const childA = emittingChild(4242);
    spawnMock.mockReturnValue(childA);

    const mod = await loadModule();
    expect(await mod.startLlamaCppServer("gemma4-e2b-it-q4_0")).toBe("started");

    // Freeze childA's exit handler mid-cleanup, on its first await.
    let releaseCleanup!: () => void;
    const pendingCleanup = new Promise<number | null>((resolve) => { releaseCleanup = () => resolve(4242); });
    llamaCppMocks.readLlamaCppPid.mockImplementationOnce(() => pendingCleanup);
    childA.emit("exit", 143);
    await vi.advanceTimersByTimeAsync(0);

    // The owner stops it, then starts it again — which clears llamaCppStopping.
    await mod.stopLlamaCppServer();
    spawnMock.mockReturnValue(emittingChild(4243));
    expect(await mod.startLlamaCppServer("gemma4-e2b-it-q4_0")).toBe("started");
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Only now does childA's handler get to finish.
    releaseCleanup();
    await vi.advanceTimersByTimeAsync(CHILD_RESTART_CEILING_MS);

    expect(spawnMock, "the stopped child armed a chain of its own").toHaveBeenCalledTimes(2);
  });

  /**
   * The pid path is one shared file, not one per alias, so "clear it on exit"
   * is only safe while it still records the child that is exiting. A child that
   * takes its time dying would otherwise unlink the record of the replacement
   * that had already started.
   */
  it("does not clear a pid file that now records a different child", async () => {
    vi.useFakeTimers();
    const childA = emittingChild(4242);
    spawnMock.mockReturnValue(childA);

    const mod = await loadModule();
    expect(await mod.startLlamaCppServer("gemma4-e2b-it-q4_0")).toBe("started");

    // A replacement has since started and written its own pid to that file.
    llamaCppMocks.readLlamaCppPid.mockResolvedValue(4243);
    llamaCppMocks.clearLlamaCppPid.mockClear();

    childA.emit("exit", 143);
    await vi.advanceTimersByTimeAsync(10);

    expect(
      llamaCppMocks.clearLlamaCppPid,
      "the dying child unlinked the replacement's pid record",
    ).not.toHaveBeenCalled();
  });
});
