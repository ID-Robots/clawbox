import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The llama-server window follows the runtime: Hermes refuses a session on a
 * window under 64,000 tokens, read off the running server, and OpenClaw runs
 * the configured 32k. Neither the runtime switch nor the edition swap restarts
 * the web server llama-server belongs to, so a server started under one keeps
 * its window under the other. The wake path puts such a server back to standby
 * before it starts the model again — and leaves every other server alone.
 */

const calls: string[] = [];
const startLlamaCppServerMock = vi.fn(async () => {
  calls.push("start");
  return "started";
});
const stopLlamaCppServerMock = vi.fn(async () => {
  calls.push("stop");
});
vi.mock("@/instrumentation-node", () => ({
  startLlamaCppServer: (...a: unknown[]) => startLlamaCppServerMock(...(a as [])),
  stopLlamaCppServer: (...a: unknown[]) => stopLlamaCppServerMock(...(a as [])),
}));

vi.mock("@/lib/llamacpp", () => ({
  getDefaultLlamaCppModel: () => "gemma4-e2b-it-q4_0",
  getLlamaCppBaseUrl: () => "http://127.0.0.1:8080/v1",
  getLlamaCppProxyBaseUrl: () => "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
}));

const getActiveHarnessMock = vi.fn();
let harnessDefaulted = false;
vi.mock("@/lib/harness", () => ({
  getActiveHarnessSource: async () => ({ active: await getActiveHarnessMock(), defaulted: harnessDefaulted }),
}));

const servedContextMock = vi.fn();
vi.mock("@/lib/llamacpp-server", () => ({
  getLlamaCppLaunchSpec: (_alias: string, harness?: string) => ({
    baseUrl: "http://127.0.0.1:8080/v1",
    startupTimeoutMs: 1_200_000,
    contextWindow: harness === "hermes" ? 65536 : 32768,
  }),
  getLlamaCppProvisioningStatus: async () => ({ modelAvailable: true }),
  queryLlamaCppModels: async () => ["gemma4-e2b-it-q4_0"],
  queryLlamaCppServedContext: (...a: unknown[]) => servedContextMock(...a),
  resolveConfiguredLlamaCppAlias: async () => "gemma4-e2b-it-q4_0",
}));

async function wake() {
  vi.resetModules();
  const { ensureLocalAiReady } = await import("@/lib/local-ai-runtime");
  await ensureLocalAiReady("llamacpp");
}

describe("the llama.cpp wake on a Hermes box", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    harnessDefaulted = false;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("restarts a server that serves less than Hermes' floor, before it starts the model", async () => {
    getActiveHarnessMock.mockResolvedValue("hermes");
    // Serves 32k until it is stopped, then nothing.
    servedContextMock.mockResolvedValueOnce(32768).mockResolvedValue(null);

    await wake();

    expect(servedContextMock).toHaveBeenCalledWith("http://127.0.0.1:8080/v1");
    expect(calls).toEqual(["stop", "start"]);
    expect(startLlamaCppServerMock).toHaveBeenCalledWith("gemma4-e2b-it-q4_0");
  });

  it("keeps a server that already serves the window the runtime runs", async () => {
    getActiveHarnessMock.mockResolvedValue("hermes");
    servedContextMock.mockResolvedValue(65536);
    await wake();
    getActiveHarnessMock.mockResolvedValue("openclaw");
    servedContextMock.mockResolvedValue(32768);
    await wake();

    expect(stopLlamaCppServerMock).not.toHaveBeenCalled();
    expect(calls).toEqual(["start", "start"]);
  });

  it("keeps a server whose window it cannot read: unknown is not too small", async () => {
    getActiveHarnessMock.mockResolvedValue("hermes");
    servedContextMock.mockResolvedValue(null);

    await wake();

    expect(stopLlamaCppServerMock).not.toHaveBeenCalled();
    expect(calls).toEqual(["start"]);
  });

  it("gives OpenClaw back its own window after a Hermes period", async () => {
    // Started under Hermes at its floor; the box is on OpenClaw again.
    getActiveHarnessMock.mockResolvedValue("openclaw");
    servedContextMock.mockResolvedValueOnce(65536).mockResolvedValue(null);

    await wake();

    expect(calls).toEqual(["stop", "start"]);
  });

  it("waits for the retired server to stop answering before it starts the model", async () => {
    getActiveHarnessMock.mockResolvedValue("hermes");
    // The check, then two polls the old server still answers, then silence.
    servedContextMock
      .mockResolvedValueOnce(32768)
      .mockResolvedValueOnce(32768)
      .mockResolvedValueOnce(32768)
      .mockResolvedValue(null);

    await wake();

    expect(calls).toEqual(["stop", "start"]);
    expect(servedContextMock).toHaveBeenCalledTimes(4);
  });

  it("decides nothing on a runtime answered only by default", async () => {
    // The edition lock mid-rewrite or an unreadable store answers "openclaw"
    // by default: not proof enough to stop a Hermes-sized server.
    harnessDefaulted = true;
    getActiveHarnessMock.mockResolvedValue("openclaw");
    servedContextMock.mockResolvedValue(65536);

    await wake();

    expect(servedContextMock).not.toHaveBeenCalled();
    expect(calls).toEqual(["start"]);
  });

  it("does not cut a stream another request is still reading", async () => {
    getActiveHarnessMock.mockResolvedValue("openclaw");
    servedContextMock.mockResolvedValue(65536);
    vi.resetModules();
    const runtime = await import("@/lib/local-ai-runtime");
    runtime.beginLocalAiUse("llamacpp");
    await runtime.ensureLocalAiReady("llamacpp");

    expect(stopLlamaCppServerMock).not.toHaveBeenCalled();
    expect(calls).toEqual(["start"]);
    runtime.endLocalAiUse("llamacpp");
  });
});
