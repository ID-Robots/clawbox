import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-435 — /setup-api/local-models.
 *
 * The route's job beyond reporting is to REFUSE: it must never offer to switch
 * something that has no service, and never act on an engine that is not on the
 * box. "A not-installed model is shown as not-installed rather than as an
 * option" has to hold at the API too, or the UI is the only thing enforcing it.
 */

const inventory = vi.fn();
const setEnabled = vi.fn();

vi.mock("@/lib/local-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/local-models")>();
  return {
    ...actual,
    buildLocalModelInventory: (...args: unknown[]) => inventory(...args),
    setEngineEnabled: (...args: unknown[]) => setEnabled(...args),
  };
});

vi.mock("@/lib/llamacpp", () => ({
  getLlamaCppBaseUrl: () => "http://127.0.0.1:8081/v1",
  getDefaultLlamaCppModel: () => "gemma",
}));
vi.mock("@/lib/llamacpp-server", () => ({
  getLlamaCppProvisioningStatus: async () => ({ installed: false }),
  resolveConfiguredLlamaCppAlias: async () => null,
}));
vi.mock("@/lib/local-ai-runtime", () => ({
  getOllamaBaseUrl: () => "http://127.0.0.1:11434",
}));
vi.mock("@/lib/clawkeep-memory", () => ({
  peekMemoryStatus: () => ({ available: true, provider: "ollama", model: "qwen3-embedding:0.6b", location: "local" }),
}));

function snapshot(over: Partial<{ id: string; installed: boolean }> = {}) {
  return {
    models: [{
      id: "ollama", name: "Ollama", kind: "llm", runtime: "System service",
      installed: true, enabled: false, running: "idle", diskBytes: null,
      memoryBytes: null, control: "system-unit", detail: "Installed and stopped.",
      ...over,
    }],
    unavailable: [],
  };
}

async function route() {
  return await import("@/app/setup-api/local-models/route");
}

beforeEach(() => {
  vi.resetModules();
  inventory.mockReset();
  setEnabled.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});

describe("GET /setup-api/local-models", () => {
  it("returns the inventory and never caches it", async () => {
    inventory.mockResolvedValue(snapshot());
    const { GET } = await route();
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.models[0].id).toBe("ollama");
  });
});

describe("POST /setup-api/local-models", () => {
  it("rejects a body that is not an id plus a flag", async () => {
    const { POST } = await route();
    const res = await POST(new Request("http://box/setup-api/local-models", {
      method: "POST", body: JSON.stringify({ id: "ollama" }),
    }));
    expect(res.status).toBe(400);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it("refuses an engine that has no service to toggle", async () => {
    // llama.cpp is a real row, owned by Settings → Local AI: known, but no switch here.
    const { POST } = await route();
    const res = await POST(new Request("http://box/setup-api/local-models", {
      method: "POST", body: JSON.stringify({ id: "llamacpp", enabled: false }),
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot be turned on or off/);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it("tells an unknown id apart from a known engine without a switch", async () => {
    // Piper is gone from the box. "Cannot be turned on or off here" implied it
    // existed; nothing is built for the answer, the id is refused up front.
    const { POST } = await route();
    const res = await POST(new Request("http://box/setup-api/local-models", {
      method: "POST", body: JSON.stringify({ id: "piper", enabled: false }),
    }));
    expect(res.status).toBe(404);
    expect(inventory).not.toHaveBeenCalled();
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it("refuses to enable a model that is not installed", async () => {
    inventory.mockResolvedValue(snapshot({ installed: false }));
    const { POST } = await route();
    const res = await POST(new Request("http://box/setup-api/local-models", {
      method: "POST", body: JSON.stringify({ id: "ollama", enabled: true }),
    }));
    expect(res.status).toBe(409);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it("toggles an installed engine and answers with the state that followed", async () => {
    inventory
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce({ models: [{ ...snapshot().models[0], enabled: true, running: "running" }], unavailable: [] });
    setEnabled.mockResolvedValue({ ok: true });
    const { POST } = await route();
    const res = await POST(new Request("http://box/setup-api/local-models", {
      method: "POST", body: JSON.stringify({ id: "ollama", enabled: true }),
    }));
    expect(res.status).toBe(200);
    expect(setEnabled).toHaveBeenCalledWith("ollama.service", "system", true);
    const body = await res.json();
    // Answering with the post-toggle reading is what stops the UI showing the
    // old state until its next poll.
    expect(body.models[0].running).toBe("running");
  });

  it("passes a refusal through without the command line", async () => {
    inventory.mockResolvedValue(snapshot());
    setEnabled.mockResolvedValue({ ok: false, error: "This box does not allow the web interface to change that service." });
    const { POST } = await route();
    const res = await POST(new Request("http://box/setup-api/local-models", {
      method: "POST", body: JSON.stringify({ id: "ollama", enabled: false }),
    }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toMatch(/usr\/bin|sudo/);
  });
});
