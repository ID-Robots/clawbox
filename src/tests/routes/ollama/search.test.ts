import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("GET /setup-api/ollama/search", () => {
  let ollamaSearchGet: (req: Request) => Promise<Response>;

  function createRequest(query?: string): Request {
    const url = query
      ? `http://localhost/test?q=${encodeURIComponent(query)}`
      : "http://localhost/test";
    return new Request(url);
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn());
    const mod = await import("@/app/setup-api/ollama/search/route");
    ollamaSearchGet = mod.GET;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns empty results for missing query", async () => {
    const res = await ollamaSearchGet(createRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results).toEqual([]);
  });

  it("returns empty results for empty query", async () => {
    const res = await ollamaSearchGet(createRequest("  "));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results).toEqual([]);
  });

  it("searches Ollama library and returns results", async () => {
    const mockHtml = `
      <html>
        <body>
          <li>
            <a href="/library/llama2">Llama 2</a>
            <p>A powerful language model</p>
            <span>1.5M Pulls</span>
            <span>7b</span>
            <span>3b</span>
          </li>
          <li>
            <a href="/library/mistral">Mistral</a>
            <p>Fast and efficient</p>
            <span>500K Pulls</span>
            <span>7b</span>
            <span>vision</span>
          </li>
        </body>
      </html>
    `;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaSearchGet(createRequest("llama"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results).toHaveLength(2);
    expect(body.results[0].name).toBe("llama2");
    expect(body.results[1].name).toBe("mistral");
  });

  it("filters out models too large for Jetson (>8B)", async () => {
    const mockHtml = `
      <html>
        <body>
          <li>
            <a href="/library/smallmodel">Small Model</a>
            <p>Fits in memory</p>
            <span>3b</span>
          </li>
          <li>
            <a href="/library/bigmodel">Big Model</a>
            <p>Too big</p>
            <span>70b</span>
          </li>
          <li>
            <a href="/library/mixedmodel">Mixed Model</a>
            <p>Has both sizes</p>
            <span>3b</span>
            <span>70b</span>
          </li>
        </body>
      </html>
    `;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaSearchGet(createRequest("model"));
    const body = await res.json();

    expect(res.status).toBe(200);
    // bigmodel should be filtered out (only has 70b)
    // smallmodel and mixedmodel should remain
    const names = body.results.map((r: { name: string }) => r.name);
    expect(names).toContain("smallmodel");
    expect(names).toContain("mixedmodel");
    expect(names).not.toContain("bigmodel");
  });

  it("keeps models with no size info", async () => {
    const mockHtml = `
      <html>
        <body>
          <li>
            <a href="/library/unknown">Unknown Size</a>
            <p>No size listed</p>
          </li>
        </body>
      </html>
    `;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaSearchGet(createRequest("unknown"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].name).toBe("unknown");
  });

  it("extracts capability tags", async () => {
    const mockHtml = `
      <html>
        <body>
          <li>
            <a href="/library/visionmodel">Vision Model</a>
            <p>Has vision and tools</p>
            <span>vision</span>
            <span>tools</span>
            <span>7b</span>
          </li>
        </body>
      </html>
    `;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaSearchGet(createRequest("vision"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results[0].tags).toContain("vision");
    expect(body.results[0].tags).toContain("tools");
  });

  it("returns 502 when Ollama website returns error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaSearchGet(createRequest("test"));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("Failed to search Ollama library");
  });

  it("returns 502 when fetch throws", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaSearchGet(createRequest("test"));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("Network error");
  });

  it("returns 502 with generic error for non-Error throws", async () => {
    const mockFetch = vi.fn().mockRejectedValue("unknown");
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaSearchGet(createRequest("test"));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("Search failed");
  });

  it("uses cache for repeated queries", async () => {
    const mockHtml = `<li><a href="/library/test">Test</a></li>`;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });
    vi.stubGlobal("fetch", mockFetch);

    // First request
    await ollamaSearchGet(createRequest("test"));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second request with same query (should use cache)
    await ollamaSearchGet(createRequest("test"));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Different query (should make new request)
    await ollamaSearchGet(createRequest("different"));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("limits results to 20", async () => {
    // Create HTML with 25 models
    const models = Array.from({ length: 25 }, (_, i) => `
      <li>
        <a href="/library/model${i}">Model ${i}</a>
        <span>3b</span>
      </li>
    `).join("");
    const mockHtml = `<html><body>${models}</body></html>`;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaSearchGet(createRequest("model"));
    const body = await res.json();

    expect(body.results.length).toBeLessThanOrEqual(20);
  });
});
