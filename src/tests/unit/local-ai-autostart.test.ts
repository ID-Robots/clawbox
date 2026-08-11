import { beforeEach, describe, expect, it, vi } from "vitest";

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
