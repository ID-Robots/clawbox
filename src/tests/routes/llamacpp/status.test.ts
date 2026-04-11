import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLlamaCppProvisioningStatus } from "@/lib/llamacpp-server";

vi.mock("@/lib/llamacpp-server", () => ({
  getLlamaCppProvisioningStatus: vi.fn(),
}));

vi.mock("@/lib/local-ai-runtime", () => ({
  getLocalAiRuntimeSnapshot: vi.fn(() => ({
    idleTimeoutMs: 600000,
    lastUsedAt: null,
    proxyBaseUrl: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
    upstreamBaseUrl: "http://127.0.0.1:8080/v1",
    activeRequests: 0,
  })),
}));

const mockGetLlamaCppProvisioningStatus = vi.mocked(getLlamaCppProvisioningStatus);

describe("GET /setup-api/llamacpp/status", () => {
  let llamaCppStatusGet: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    mockGetLlamaCppProvisioningStatus.mockResolvedValue({
      alias: "gemma4-e2b-it-q4_0",
      binPath: "/usr/local/bin/llama-server",
      modelPath: "/home/clawbox/clawbox/data/llamacpp/models/gemma-4-e2b-it-edited-q4_0.gguf",
      binaryAvailable: true,
      modelAvailable: true,
      installed: true,
    });
    const mod = await import("@/app/setup-api/llamacpp/status/route");
    llamaCppStatusGet = mod.GET;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns running:true with models when llama.cpp is available", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: [
          { id: "gemma-q4", owned_by: "llama.cpp" },
          { id: "qwen-q4", owned_by: "llama.cpp" },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await llamaCppStatusGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.running).toBe(true);
    expect(body.installed).toBe(true);
    expect(body.models).toHaveLength(2);
    expect(body.models[0].id).toBe("gemma-q4");
  });

  it("returns running:false when llama.cpp returns non-ok status", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await llamaCppStatusGet();
    const body = await res.json();

    expect(body.running).toBe(false);
    expect(body.models).toEqual([]);
  });

  it("returns running:false when llama.cpp is not reachable", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
    vi.stubGlobal("fetch", mockFetch);

    const res = await llamaCppStatusGet();
    const body = await res.json();

    expect(body.running).toBe(false);
    expect(body.models).toEqual([]);
  });
});
