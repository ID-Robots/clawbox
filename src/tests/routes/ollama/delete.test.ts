import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/local-ai-runtime", () => ({
  ensureLocalAiReady: vi.fn(),
  getOllamaBaseUrl: vi.fn(() => "http://127.0.0.1:11434"),
}));

describe("POST /setup-api/ollama/delete", () => {
  let ollamaDeletePost: (req: Request) => Promise<Response>;

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
    const mod = await import("@/app/setup-api/ollama/delete/route");
    ollamaDeletePost = mod.POST;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deletes a model successfully", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaDeletePost(jsonRequest({ model: "llama2:7b" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/delete",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ name: "llama2:7b" }),
      })
    );
  });

  it("returns 400 for missing model", async () => {
    const res = await ollamaDeletePost(jsonRequest({}));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid model name");
  });

  it("returns 400 for invalid model name", async () => {
    const res = await ollamaDeletePost(jsonRequest({ model: "invalid model!" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid model name");
  });

  it("returns 400 for non-string model", async () => {
    const res = await ollamaDeletePost(jsonRequest({ model: 123 }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid model name");
  });

  it("returns error when Ollama returns non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("model not found"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaDeletePost(jsonRequest({ model: "nonexistent:7b" }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("model not found");
  });

  it("returns default error when Ollama response has no body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaDeletePost(jsonRequest({ model: "test:7b" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Ollama returned 500");
  });

  it("returns 500 when fetch throws", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaDeletePost(jsonRequest({ model: "test:7b" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Connection refused");
  });

  it("returns generic error for non-Error throws", async () => {
    const mockFetch = vi.fn().mockRejectedValue("unknown error");
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaDeletePost(jsonRequest({ model: "test:7b" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to delete model");
  });

  it("accepts valid model name formats", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    // Test various valid formats
    const validModels = [
      "llama2",
      "llama2:7b",
      "mistral:7b-instruct",
      "codellama:7b-python",
      "phi-2",
      "registry.example.com/model:tag",
    ];

    for (const model of validModels) {
      const res = await ollamaDeletePost(jsonRequest({ model }));
      expect(res.status).toBe(200);
    }
  });
});
