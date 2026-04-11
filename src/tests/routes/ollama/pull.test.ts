import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/local-ai-runtime", () => ({
  ensureLocalAiReady: vi.fn(),
  getOllamaBaseUrl: vi.fn(() => "http://127.0.0.1:11434"),
}));

describe("POST /setup-api/ollama/pull", () => {
  let ollamaPullPost: (req: Request) => Promise<Response>;

  function jsonRequest(body: unknown): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn());
    const mod = await import("@/app/setup-api/ollama/pull/route");
    ollamaPullPost = mod.POST;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await ollamaPullPost(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid JSON");
  });

  it("returns 400 for invalid model name format", async () => {
    const invalidModels = ["model with spaces", "model!special", "../path/traversal"];

    for (const model of invalidModels) {
      const res = await ollamaPullPost(jsonRequest({ model }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("Invalid model name format");
    }
  });

  it("accepts valid model name formats", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: true }),
        }),
      },
    });
    vi.stubGlobal("fetch", mockFetch);

    const validModels = ["llama3.2:3b", "mistral", "qwen2.5-coder:1.5b", "phi-2"];

    for (const model of validModels) {
      const res = await ollamaPullPost(jsonRequest({ model }));
      expect(res.status).toBe(200);
    }
  });

  it("uses default model when none specified", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: true }),
        }),
      },
    });
    vi.stubGlobal("fetch", mockFetch);

    await ollamaPullPost(jsonRequest({}));

    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/pull",
      expect.objectContaining({
        body: JSON.stringify({ name: "llama3.2:3b", stream: true }),
      })
    );
  });

  it("returns 502 when Ollama returns error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      statusText: "Bad Gateway",
      text: () => Promise.resolve("Model not found"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaPullPost(jsonRequest({ model: "nonexistent" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain("Ollama pull failed");
    expect(body.error).toContain("Model not found");
  });

  it("returns 502 with statusText when error body is empty", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      statusText: "Service Unavailable",
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaPullPost(jsonRequest({ model: "test" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain("Service Unavailable");
  });

  it("returns 502 when fetch throws", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaPullPost(jsonRequest({ model: "test" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("Connection refused");
  });

  it("returns 502 with generic error for non-Error throws", async () => {
    const mockFetch = vi.fn().mockRejectedValue("unknown error");
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaPullPost(jsonRequest({ model: "test" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("Failed to connect to Ollama");
  });

  it("streams progress back to client", async () => {
    const chunks = [
      JSON.stringify({ status: "downloading", completed: 50, total: 100 }) + "\n",
      JSON.stringify({ status: "success" }) + "\n",
    ];
    let chunkIndex = 0;

    const mockReader = {
      read: vi.fn().mockImplementation(() => {
        if (chunkIndex < chunks.length) {
          const value = new TextEncoder().encode(chunks[chunkIndex++]);
          return Promise.resolve({ done: false, value });
        }
        return Promise.resolve({ done: true });
      }),
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => mockReader },
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaPullPost(jsonRequest({ model: "llama2" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");

    // Read the stream
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let content = "";
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        content += decoder.decode(value);
      }
    }

    expect(content).toContain("downloading");
    expect(content).toContain("success");
  });

  it("handles error in stream", async () => {
    const chunks = [JSON.stringify({ error: "Insufficient disk space" }) + "\n"];

    const mockReader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(chunks[0]) })
        .mockResolvedValue({ done: true }),
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => mockReader },
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaPullPost(jsonRequest({ model: "llama2" }));
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let content = "";
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        content += decoder.decode(value);
      }
    }

    expect(content).toContain("Insufficient disk space");
  });

  it("handles null body from Ollama", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: null,
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaPullPost(jsonRequest({ model: "test" }));

    // Should return a stream that immediately closes
    const reader = res.body?.getReader();
    if (reader) {
      const { done } = await reader.read();
      expect(done).toBe(true);
    }
  });
});
