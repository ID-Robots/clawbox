import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("GET /setup-api/ollama/status", () => {
  let ollamaStatusGet: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn());
    const mod = await import("@/app/setup-api/ollama/status/route");
    ollamaStatusGet = mod.GET;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns running:true with models when Ollama is available", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        models: [
          { name: "llama2:7b", size: 3826793472, modified_at: "2024-01-15T10:00:00Z" },
          { name: "codellama:7b", size: 3826793472, modified_at: "2024-01-14T10:00:00Z" },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaStatusGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.running).toBe(true);
    expect(body.models).toHaveLength(2);
    expect(body.models[0].name).toBe("llama2:7b");
  });

  it("returns running:false when Ollama returns non-ok status", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaStatusGet();
    const body = await res.json();

    expect(body.running).toBe(false);
    expect(body.models).toEqual([]);
  });

  it("returns running:false when Ollama is not reachable", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaStatusGet();
    const body = await res.json();

    expect(body.running).toBe(false);
    expect(body.models).toEqual([]);
  });

  it("handles empty models array", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaStatusGet();
    const body = await res.json();

    expect(body.running).toBe(true);
    expect(body.models).toEqual([]);
  });

  it("handles missing models field", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaStatusGet();
    const body = await res.json();

    expect(body.running).toBe(true);
    expect(body.models).toEqual([]);
  });
});
