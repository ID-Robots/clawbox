import { beforeEach, describe, expect, it, vi } from "vitest";

const VALID_TOKEN = "a".repeat(64);

vi.mock("@/lib/llamacpp", () => ({
  getLlamaCppBaseUrl: vi.fn(() => "http://127.0.0.1:8080/v1"),
}));

vi.mock("@/lib/local-ai-runtime", () => ({
  beginLocalAiUse: vi.fn(),
  endLocalAiUse: vi.fn(),
  ensureLocalAiReady: vi.fn(),
  getOllamaBaseUrl: vi.fn(() => "http://127.0.0.1:11434"),
}));

vi.mock("@/lib/local-ai-token", () => ({
  getLocalAiToken: vi.fn(() => VALID_TOKEN),
  verifyLocalAiBearer: vi.fn((header: string | null) => {
    if (!header) return false;
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) return false;
    const t = m[1].trim();
    return t === VALID_TOKEN || t === "llamacpp-local" || t === "ollama-local";
  }),
}));

import {
  beginLocalAiUse,
  endLocalAiUse,
  ensureLocalAiReady,
} from "@/lib/local-ai-runtime";

const mockBeginLocalAiUse = vi.mocked(beginLocalAiUse);
const mockEndLocalAiUse = vi.mocked(endLocalAiUse);
const mockEnsureLocalAiReady = vi.mocked(ensureLocalAiReady);

const authHeaders = (extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${VALID_TOKEN}`,
  ...extra,
});

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
      new Request("http://localhost/setup-api/local-ai/llamacpp/v1/models?x=1", {
        headers: authHeaders(),
      }),
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
      headers: authHeaders({ "Content-Type": "application/json" }),
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

  it("rejects unauthenticated proxy calls with 401", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const mod = await import("@/app/setup-api/local-ai/llamacpp/v1/[...path]/route");
    const response = await mod.GET(
      new Request("http://localhost/setup-api/local-ai/llamacpp/v1/models"),
      { params: Promise.resolve({ path: ["models"] }) },
    );

    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
    expect(mockEnsureLocalAiReady).not.toHaveBeenCalled();
    expect(mockBeginLocalAiUse).not.toHaveBeenCalled();
  });

  it("accepts the legacy llamacpp-local sentinel for backward compat", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", mockFetch);

    const mod = await import("@/app/setup-api/local-ai/llamacpp/v1/[...path]/route");
    const response = await mod.GET(
      new Request("http://localhost/setup-api/local-ai/llamacpp/v1/models", {
        headers: { Authorization: "Bearer llamacpp-local" },
      }),
      { params: Promise.resolve({ path: ["models"] }) },
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalled();
  });

  it("accepts the legacy ollama-local sentinel for backward compat", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", mockFetch);

    const mod = await import("@/app/setup-api/local-ai/ollama/[...path]/route");
    const response = await mod.GET(
      new Request("http://localhost/setup-api/local-ai/ollama/api/tags", {
        headers: { Authorization: "Bearer ollama-local" },
      }),
      { params: Promise.resolve({ path: ["api", "tags"] }) },
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalled();
  });
});
