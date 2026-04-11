import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/llamacpp", () => ({
  getLlamaCppBaseUrl: vi.fn(() => "http://127.0.0.1:8080/v1"),
}));

vi.mock("@/lib/local-ai-runtime", () => ({
  beginLocalAiUse: vi.fn(),
  endLocalAiUse: vi.fn(),
  ensureLocalAiReady: vi.fn(),
  getOllamaBaseUrl: vi.fn(() => "http://127.0.0.1:11434"),
}));

import {
  beginLocalAiUse,
  endLocalAiUse,
  ensureLocalAiReady,
} from "@/lib/local-ai-runtime";

const mockBeginLocalAiUse = vi.mocked(beginLocalAiUse);
const mockEndLocalAiUse = vi.mocked(endLocalAiUse);
const mockEnsureLocalAiReady = vi.mocked(ensureLocalAiReady);

describe("local AI proxy routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    mockEnsureLocalAiReady.mockResolvedValue();
  });

  it("starts llama.cpp on demand before proxying requests", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "gemma4-e2b-it-q4_0" }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", mockFetch);

    const mod = await import("@/app/setup-api/local-ai/llamacpp/v1/[...path]/route");
    const response = await mod.GET(
      new Request("http://localhost/setup-api/local-ai/llamacpp/v1/models?x=1"),
      { params: Promise.resolve({ path: ["models"] }) },
    );

    expect(mockEnsureLocalAiReady).toHaveBeenCalledWith("llamacpp");
    expect(mockBeginLocalAiUse).toHaveBeenCalledWith("llamacpp");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/v1/models?x=1",
      expect.objectContaining({ method: "GET" }),
    );

    await response.json();
    expect(mockEndLocalAiUse).toHaveBeenCalledWith("llamacpp");
  });

  it("proxies Ollama POST bodies through the on-demand endpoint", async () => {
    const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      done: true,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", upstream);

    const mod = await import("@/app/setup-api/local-ai/ollama/[...path]/route");
    const request = new Request("http://localhost/setup-api/local-ai/ollama/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemma3:4b", messages: [] }),
    });

    const response = await mod.POST(
      request,
      { params: Promise.resolve({ path: ["api", "chat"] }) },
    );

    expect(mockEnsureLocalAiReady).toHaveBeenCalledWith("ollama");
    expect(mockBeginLocalAiUse).toHaveBeenCalledWith("ollama");
    expect(upstream).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/chat",
      expect.objectContaining({ method: "POST" }),
    );

    await response.json();
    expect(mockEndLocalAiUse).toHaveBeenCalledWith("ollama");
  });
});
