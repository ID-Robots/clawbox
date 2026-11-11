import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Local AI proxy while an external AI engine is selected (TASK-2376): a
 * chat turn that still reaches `/setup-api/local-ai/llamacpp` or `/ollama` — a
 * stale session override, an old fallback — is refused before the on-device
 * runtime is woken. With no engine selected the proxy wakes it exactly as
 * before, and the memory embedder is never affected.
 */

const selected = vi.fn(async () => false);
vi.mock("@/lib/external-engine", () => ({ externalEngineSelected: () => selected() }));
vi.mock("@/lib/local-ai-token", () => ({ verifyLocalAiBearer: vi.fn(() => true) }));
vi.mock("@/lib/local-ai-runtime", () => ({
  beginLocalAiUse: vi.fn(),
  endLocalAiUse: vi.fn(),
  ensureLocalAiReady: vi.fn(async () => {}),
  getOllamaBaseUrl: vi.fn(() => "http://127.0.0.1:11434"),
}));
vi.mock("@/lib/llamacpp", () => ({ getLlamaCppBaseUrl: vi.fn(() => "http://127.0.0.1:8080/v1") }));
vi.mock("@/lib/ollama-capabilities", () => ({ ollamaModelCanThink: vi.fn(async () => false) }));
vi.mock("@/lib/embed-server", () => ({
  getEmbedBaseUrl: vi.fn(() => "http://127.0.0.1:8081/v1"),
  getEmbedBatch: vi.fn(() => 512),
  getEmbedRootUrl: vi.fn(() => "http://127.0.0.1:8081"),
}));

import { proxyLocalAiRequest } from "@/lib/local-ai-proxy";
import { ensureLocalAiReady } from "@/lib/local-ai-runtime";

function chat(provider: string): Request {
  return new Request(`http://127.0.0.1/setup-api/local-ai/${provider}/v1/models`, {
    method: "GET",
    headers: { Authorization: "Bearer local-token" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  selected.mockResolvedValue(false);
});

describe("proxyLocalAiRequest with an external engine selected", () => {
  it.each(["llamacpp", "ollama"] as const)("refuses %s with 503 and never wakes it", async (provider) => {
    selected.mockResolvedValue(true);
    const res = await proxyLocalAiRequest(chat(provider), provider, ["models"]);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("external_engine_selected");
    expect(ensureLocalAiReady).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves the memory embedder alone", async () => {
    selected.mockResolvedValue(true);
    const res = await proxyLocalAiRequest(chat("embed"), "embed", ["models"]);
    expect(res.status).toBe(200);
    expect(ensureLocalAiReady).toHaveBeenCalledWith("embed");
  });
});

describe("proxyLocalAiRequest with no external engine (the appliance default)", () => {
  it("wakes llama.cpp exactly as before", async () => {
    const res = await proxyLocalAiRequest(chat("llamacpp"), "llamacpp", ["models"]);
    expect(res.status).toBe(200);
    expect(ensureLocalAiReady).toHaveBeenCalledWith("llamacpp");
  });
});
