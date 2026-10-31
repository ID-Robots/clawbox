import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hermes refuses a session on a window under 64,000 tokens, read off the
 * running llama-server. A server started while OpenClaw was the runtime keeps
 * its 32k window after the box moves to Hermes (neither the runtime switch nor
 * the edition swap restarts the web server it belongs to), so the wake path
 * puts such a server back to standby before it starts the model again — and
 * leaves every other server alone.
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
vi.mock("@/lib/harness", () => ({
  getActiveHarness: () => getActiveHarnessMock(),
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
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("restarts a server that serves less than Hermes' floor, before it starts the model", async () => {
    getActiveHarnessMock.mockResolvedValue("hermes");
    servedContextMock.mockResolvedValue(32768);

    await wake();

    expect(servedContextMock).toHaveBeenCalledWith("http://127.0.0.1:8080/v1");
    expect(calls).toEqual(["stop", "start"]);
    expect(startLlamaCppServerMock).toHaveBeenCalledWith("gemma4-e2b-it-q4_0");
  });

  it("keeps a server that already serves the window Hermes needs, or more", async () => {
    getActiveHarnessMock.mockResolvedValue("hermes");

    servedContextMock.mockResolvedValue(65536);
    await wake();
    servedContextMock.mockResolvedValue(131072);
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

  it("asks nothing on OpenClaw, where a running server is never too small", async () => {
    getActiveHarnessMock.mockResolvedValue("openclaw");

    await wake();

    expect(servedContextMock).not.toHaveBeenCalled();
    expect(stopLlamaCppServerMock).not.toHaveBeenCalled();
    expect(calls).toEqual(["start"]);
  });
});
