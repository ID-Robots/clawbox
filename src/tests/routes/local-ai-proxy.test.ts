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
    // Only the per-install token. The legacy sentinels are exercised against
    // the real verifier in src/tests/unit/local-ai-token.test.ts.
    return m[1].trim() === VALID_TOKEN;
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

  it("refuses a public legacy sentinel the verifier does not vouch for", async () => {
    // The proxy is session-exempt in middleware and reachable on 0.0.0.0:80,
    // so the bearer check is the ONLY gate: a string anyone can read in the
    // source must never pass it on its own.
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const mod = await import("@/app/setup-api/local-ai/ollama/[...path]/route");
    const response = await mod.GET(
      new Request("http://localhost/setup-api/local-ai/ollama/api/tags", {
        headers: { Authorization: "Bearer ollama-local" },
      }),
      { params: Promise.resolve({ path: ["api", "tags"] }) },
    );

    expect(response.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockEnsureLocalAiReady).not.toHaveBeenCalled();
  });
});

/**
 * TASK-457 (a), the backend half. The picker change stops a level Ollama
 * refuses from being OFFERED; this stops one that arrives anyway — a stale
 * client, a direct API caller, or "Thinking on" (`max`) against a model that
 * simply cannot think — from failing the turn.
 *
 * Measured on the box (Ollama 0.32.15, qwen2.5:0.5b, capabilities
 * ["completion","tools"]): every reasoning_effort but `none` → HTTP 400
 * "does not support thinking"; no field at all → HTTP 200.
 */
describe("ollama chat-completions reasoning rewrite", () => {
  const CHAT_PATH = ["v1", "chat", "completions"];

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEnsureLocalAiReady.mockResolvedValue();
    const { _resetOllamaCapabilityCacheForTests } = await import("@/lib/ollama-capabilities");
    _resetOllamaCapabilityCacheForTests();
  });

  /** fetch stub answering /api/show with `capabilities` and everything else 200. */
  function stubOllama(capabilities: string[] | null) {
    const calls: { url: string; body: string }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ url, body });
      if (url.endsWith("/api/show")) {
        if (capabilities === null) return new Response("nope", { status: 500 });
        return new Response(JSON.stringify({ capabilities }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return calls;
  }

  async function chat(body: unknown) {
    const mod = await import("@/app/setup-api/local-ai/ollama/[...path]/route");
    return mod.POST(
      new Request("http://localhost/setup-api/local-ai/ollama/v1/chat/completions", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ path: CHAT_PATH }) },
    );
  }

  const upstreamBody = (calls: { url: string; body: string }[]) =>
    JSON.parse(calls.find((c) => c.url.endsWith("/chat/completions"))!.body);

  it("drops reasoning_effort for a model that cannot think", async () => {
    const calls = stubOllama(["completion", "tools"]);

    const res = await chat({ model: "qwen2.5:3b", messages: [], reasoning_effort: "max" });

    expect(res.status).toBe(200);
    const sent = upstreamBody(calls);
    expect(sent).not.toHaveProperty("reasoning_effort");
    expect(sent.model).toBe("qwen2.5:3b");
  });

  it("folds the OFF end onto ollama's own word for a model that can think", async () => {
    const calls = stubOllama(["completion", "tools", "thinking"]);

    const res = await chat({ model: "gpt-oss:20b", messages: [], reasoning_effort: "minimal" });

    expect(res.status).toBe(200);
    expect(upstreamBody(calls).reasoning_effort).toBe("none");
  });

  it("keeps a thinking level for a model that can think", async () => {
    const calls = stubOllama(["completion", "thinking"]);

    await chat({ model: "gpt-oss:20b", messages: [], reasoning_effort: "max" });

    expect(upstreamBody(calls).reasoning_effort).toBe("max");
  });

  it("forwards the body untouched when the capability probe fails", async () => {
    const calls = stubOllama(null);

    await chat({ model: "qwen2.5:3b", messages: [], reasoning_effort: "max" });

    expect(upstreamBody(calls).reasoning_effort).toBe("max");
  });

  it("does not probe at all when the body asks for no reasoning", async () => {
    const calls = stubOllama(["completion", "tools"]);

    await chat({ model: "qwen2.5:3b", messages: [] });

    expect(calls.some((c) => c.url.endsWith("/api/show"))).toBe(false);
  });

  it("caches the probe across turns", async () => {
    const calls = stubOllama(["completion", "tools"]);

    await chat({ model: "qwen2.5:3b", messages: [], reasoning_effort: "max" });
    await chat({ model: "qwen2.5:3b", messages: [], reasoning_effort: "high" });

    expect(calls.filter((c) => c.url.endsWith("/api/show"))).toHaveLength(1);
  });

  it("leaves a non-chat ollama path streaming, untouched", async () => {
    const calls = stubOllama(["completion", "tools"]);

    const mod = await import("@/app/setup-api/local-ai/ollama/[...path]/route");
    await mod.POST(
      new Request("http://localhost/setup-api/local-ai/ollama/api/chat", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ model: "qwen2.5:3b", reasoning_effort: "max" }),
      }),
      { params: Promise.resolve({ path: ["api", "chat"] }) },
    );

    expect(calls.some((c) => c.url.endsWith("/api/show"))).toBe(false);
  });
});
