import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";

vi.mock("@/lib/local-ai-runtime", () => ({
  ensureLocalAiReady: vi.fn(),
  getOllamaBaseUrl: vi.fn(() => "http://127.0.0.1:11434"),
  getOllamaModelsDir: vi.fn(() => "/usr/share/ollama/.ollama/models"),
}));

// Pulling a model is the OWNER's verb: `requireSession` here also admitted the
// MCP bearer, which middleware hands to every /setup-api route.
const owner = { value: true };
vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: async () => owner.value }));

// The disk check the route makes on each layer's `total`.
const free = { bytes: 100 * 1024 * 1024 * 1024 };
const measured: string[] = [];
vi.mock("@/lib/project-import", () => ({
  freeBytes: async (dir: string) => {
    measured.push(dir);
    return free.bytes;
  },
}));

describe("POST /setup-api/ollama/pull", () => {
  let ollamaPullPost: (req: Request) => Promise<Response>;
  let session: SessionFixture;

  function jsonRequest(body: unknown): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: session.cookie },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    owner.value = true;
    free.bytes = 100 * 1024 * 1024 * 1024;
    measured.length = 0;
    session = installSessionFixture();
    vi.stubGlobal("fetch", vi.fn());
    const mod = await import("@/app/setup-api/ollama/pull/route");
    ollamaPullPost = mod.POST;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    session.cleanup();
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: session.cookie },
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

  it("unwraps Ollama's JSON refusal on a non-ok start", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      statusText: "Not Found",
      text: () => Promise.resolve(JSON.stringify({ error: "pull model manifest: file does not exist" })),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await ollamaPullPost(jsonRequest({ model: "nonexistent" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("Ollama pull failed: pull model manifest: file does not exist");
  });

  it("ties the upstream pull to the client's request and releases it on cancel", async () => {
    // Without this an aborted request kept downloading in the background with
    // nothing in the UI showing it (verified with smollm2:135m on the box).
    const upstreamCancel = vi.fn().mockResolvedValue(undefined);
    const mockReader = {
      read: vi.fn().mockImplementation(() => new Promise(() => { /* a pull in flight */ })),
      cancel: upstreamCancel,
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => mockReader },
    });
    vi.stubGlobal("fetch", mockFetch);

    const req = jsonRequest({ model: "smollm2:135m" });
    const res = await ollamaPullPost(req);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/pull",
      expect.objectContaining({ signal: req.signal }),
    );

    await res.body!.cancel("client went away");
    expect(upstreamCancel).toHaveBeenCalled();
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

  it("refuses a caller that is not the owner", async () => {
    owner.value = false;
    const res = await ollamaPullPost(jsonRequest({ model: "llama2" }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("owner_only");
  });

  it("refuses a request from another site's page", async () => {
    const req = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: session.cookie, Origin: "http://evil.example" },
      body: JSON.stringify({ model: "llama2" }),
    });
    const res = await ollamaPullPost(req);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("cross_origin");
  });

  it("measures the filesystem Ollama's own blobs land on, not data/", async () => {
    // ollama.service runs as its own account with its own home, which on this
    // box need not be the mount `data/` sits on.
    const mockReader = {
      cancel: vi.fn(() => Promise.resolve()),
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(JSON.stringify({ status: "pulling", completed: 1, total: 1024 }) + "\n") })
        .mockResolvedValue({ done: true }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => mockReader } }));

    await readAll(await ollamaPullPost(jsonRequest({ model: "small" })));
    expect(measured).not.toHaveLength(0);
    for (const dir of measured) expect(dir).not.toContain("/data");
  });

  it("checks every layer, not only the first", async () => {
    // A model is several blobs and the stream reports a `total` per digest; a
    // check that fired once let every later layer through.
    const chunks = [
      JSON.stringify({ status: "pulling", digest: "sha256:aaa", completed: 0, total: 1024 }) + "\n",
      JSON.stringify({ status: "pulling", digest: "sha256:aaa", completed: 512, total: 1024 }) + "\n",
      JSON.stringify({ status: "pulling", digest: "sha256:bbb", completed: 0, total: 40 * 1024 * 1024 * 1024 }) + "\n",
    ];
    let index = 0;
    const cancel = vi.fn(() => Promise.resolve());
    const mockReader = {
      cancel,
      read: vi.fn().mockImplementation(() => {
        if (index < chunks.length) {
          return Promise.resolve({ done: false, value: new TextEncoder().encode(chunks[index++]) });
        }
        return Promise.resolve({ done: true });
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => mockReader } }));
    free.bytes = 4 * 1024 * 1024 * 1024;

    const lines = (await readAll(await ollamaPullPost(jsonRequest({ model: "layered" }))))
      .trim().split("\n").map((l) => JSON.parse(l));

    // The first layer fits and goes through; the second does not and stops it.
    expect(lines[0]).toMatchObject({ digest: "sha256:aaa" });
    expect(lines.at(-1)).toMatchObject({ code: "disk_full" });
    // One check per digest, not one per progress line.
    expect(measured).toHaveLength(2);
    expect(cancel).toHaveBeenCalled();
  });

  it("stops a pull that would not fit, on the first total it sees", async () => {
    // 4 GB left, a 40 GB model: the refusal arrives instead of the progress
    // line, and the download is dropped rather than left to fill the disk.
    free.bytes = 4 * 1024 * 1024 * 1024;
    const chunks = [
      JSON.stringify({ status: "pulling manifest" }) + "\n",
      JSON.stringify({ status: "pulling", completed: 0, total: 40 * 1024 * 1024 * 1024 }) + "\n",
    ];
    let index = 0;
    const cancel = vi.fn(() => Promise.resolve());
    const mockReader = {
      cancel,
      read: vi.fn().mockImplementation(() => {
        if (index < chunks.length) {
          return Promise.resolve({ done: false, value: new TextEncoder().encode(chunks[index++]) });
        }
        return Promise.resolve({ done: true });
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => mockReader } }));

    const res = await ollamaPullPost(jsonRequest({ model: "huge" }));
    expect(res.status).toBe(200);

    const content = await readAll(res);
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ status: "pulling manifest" });
    expect(lines[1]).toMatchObject({ code: "disk_full" });
    expect(lines[1].requiredBytes).toBe(40 * 1024 * 1024 * 1024);
    expect(cancel).toHaveBeenCalled();
  });

  it("lets a pull that fits through untouched", async () => {
    const chunks = [
      JSON.stringify({ status: "pulling", completed: 1, total: 1024 }) + "\n",
      JSON.stringify({ status: "success" }) + "\n",
    ];
    let index = 0;
    const mockReader = {
      cancel: vi.fn(() => Promise.resolve()),
      read: vi.fn().mockImplementation(() => {
        if (index < chunks.length) {
          return Promise.resolve({ done: false, value: new TextEncoder().encode(chunks[index++]) });
        }
        return Promise.resolve({ done: true });
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => mockReader } }));

    const content = await readAll(await ollamaPullPost(jsonRequest({ model: "small" })));
    expect(content).toContain("success");
    expect(content).not.toContain("disk_full");
  });

  it("forwards a terminal line that arrives without its newline", async () => {
    const mockReader = {
      cancel: vi.fn(() => Promise.resolve()),
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(JSON.stringify({ status: "success" })) })
        .mockResolvedValue({ done: true }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => mockReader } }));

    const content = await readAll(await ollamaPullPost(jsonRequest({ model: "small" })));
    expect(content).toContain("success");
  });
});

async function readAll(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let content = "";
  if (!reader) return content;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    content += decoder.decode(value, { stream: true });
  }
  return content + decoder.decode();
}
