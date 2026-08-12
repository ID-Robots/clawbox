import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fix B. A start that never happened used to be indistinguishable from one
 * that did, so `ensureLocalAiReady` went straight into a 20-minute poll for a
 * server nobody launched — a 10-minute chat spinner rather than an error. And
 * because the doomed attempt stayed memoized in `startPromise`, every later
 * request joined the same dead wait: the failure outlived its cause.
 */

const startLlamaCppServerMock = vi.fn();
const stopLlamaCppServerMock = vi.fn();
vi.mock("@/instrumentation-node", () => ({
  startLlamaCppServer: (...a: unknown[]) => startLlamaCppServerMock(...a),
  stopLlamaCppServer: (...a: unknown[]) => stopLlamaCppServerMock(...a),
}));

vi.mock("@/lib/llamacpp", () => ({
  getDefaultLlamaCppModel: () => "gemma4-e2b-it-q4_0",
  getLlamaCppBaseUrl: () => "http://127.0.0.1:8080/v1",
  getLlamaCppProxyBaseUrl: () => "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
}));

const queryLlamaCppModelsMock = vi.fn();
const getLlamaCppProvisioningStatusMock = vi.fn();
vi.mock("@/lib/llamacpp-server", () => ({
  getLlamaCppLaunchSpec: () => ({
    baseUrl: "http://127.0.0.1:8080/v1",
    startupTimeoutMs: 1_200_000,
  }),
  getLlamaCppProvisioningStatus: (...a: unknown[]) => getLlamaCppProvisioningStatusMock(...a),
  queryLlamaCppModels: (...a: unknown[]) => queryLlamaCppModelsMock(...a),
  resolveConfiguredLlamaCppAlias: async () => "gemma4-e2b-it-q4_0",
}));

async function loadRuntime() {
  vi.resetModules();
  return await import("@/lib/local-ai-runtime");
}

describe("ensureLocalAiReady fails fast when llama.cpp was not started", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLlamaCppProvisioningStatusMock.mockResolvedValue({ modelAvailable: true });
    queryLlamaCppModelsMock.mockResolvedValue([]);
  });

  it("throws immediately instead of polling when the launcher skipped (not configured)", async () => {
    startLlamaCppServerMock.mockResolvedValue("skipped-not-configured");
    const { ensureLocalAiReady } = await loadRuntime();

    await expect(ensureLocalAiReady("llamacpp")).rejects.toThrow(/did not start/i);
    // The decisive assertion: we never entered the readiness poll.
    expect(queryLlamaCppModelsMock).not.toHaveBeenCalled();
  });

  it("throws an explainable error when Local AI is turned off", async () => {
    startLlamaCppServerMock.mockResolvedValue("skipped-disabled");
    const { ensureLocalAiReady } = await loadRuntime();

    await expect(ensureLocalAiReady("llamacpp")).rejects.toThrow(/turned off/i);
    expect(queryLlamaCppModelsMock).not.toHaveBeenCalled();
  });

  it("passes the resolved alias to the launcher rather than letting it re-derive one", async () => {
    startLlamaCppServerMock.mockResolvedValue("started");
    queryLlamaCppModelsMock.mockResolvedValue(["gemma4-e2b-it-q4_0"]);
    const { ensureLocalAiReady } = await loadRuntime();

    await ensureLocalAiReady("llamacpp");
    expect(startLlamaCppServerMock).toHaveBeenCalledWith("gemma4-e2b-it-q4_0");
  });

  it("does not leave a failed attempt memoized for later callers", async () => {
    startLlamaCppServerMock.mockResolvedValue("skipped-not-configured");
    const { ensureLocalAiReady } = await loadRuntime();

    await expect(ensureLocalAiReady("llamacpp")).rejects.toThrow();

    // A later request must run a fresh attempt, not join the dead one.
    startLlamaCppServerMock.mockResolvedValue("started");
    queryLlamaCppModelsMock.mockResolvedValue(["gemma4-e2b-it-q4_0"]);
    await expect(ensureLocalAiReady("llamacpp")).resolves.toBeUndefined();
    expect(startLlamaCppServerMock).toHaveBeenCalledTimes(2);
  });
});

describe("wake vs download readiness budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startLlamaCppServerMock.mockResolvedValue("started");
    queryLlamaCppModelsMock.mockResolvedValue([]);
  });

  it("uses the short wake budget when the model file is already on disk", async () => {
    getLlamaCppProvisioningStatusMock.mockResolvedValue({ modelAvailable: true });
    process.env.LLAMACPP_WAKE_TIMEOUT_MS = "20";
    const { ensureLocalAiReady } = await loadRuntime();

    const startedAt = Date.now();
    await expect(ensureLocalAiReady("llamacpp")).rejects.toThrow(/Timed out after/i);
    // Nowhere near the 20-minute provisioning budget.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    delete process.env.LLAMACPP_WAKE_TIMEOUT_MS;
  });

  it("exposes a sane default wake budget, far below the download budget", async () => {
    delete process.env.LLAMACPP_WAKE_TIMEOUT_MS;
    const { getLlamaCppWakeTimeoutMs } = await loadRuntime();
    const wake = getLlamaCppWakeTimeoutMs();
    expect(wake).toBe(180_000);
    expect(wake).toBeLessThan(1_200_000);
  });
});
