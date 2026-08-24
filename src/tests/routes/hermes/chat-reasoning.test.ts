import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-457, at the layer the customer actually hits: what `/setup-api/hermes/chat`
 * puts on the `hermes` command line.
 *
 * The bug was fully expressible here — the route clamped the on-device provider
 * to {minimal, max}, and on the ollama backend BOTH of those answer HTTP 400
 * "does not support thinking" (measured on the box against Ollama 0.32.15).
 * Every named reasoning level was a guaranteed failed turn, and no unit test of
 * the clamp alone would have shown it, because the clamp was doing exactly what
 * it was told.
 */
vi.mock("child_process", () => ({ spawn: vi.fn() }));
vi.mock("@/lib/harness", () => ({ HERMES_BIN: "/home/clawbox/.local/bin/hermes" }));
vi.mock("@/lib/hermes-model-options", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hermes-model-options")>();
  return { ...actual, getModelOptions: vi.fn() };
});
vi.mock("@/lib/config-store", () => ({ get: vi.fn() }));

import { spawn } from "child_process";
import { get } from "@/lib/config-store";
import { getModelOptions } from "@/lib/hermes-model-options";

const mockSpawn = vi.mocked(spawn);
const mockGetModelOptions = vi.mocked(getModelOptions);
const mockGet = vi.mocked(get);

/** A `hermes chat` that exits 0 with a one-line answer and a session banner. */
function fakeHermes() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setImmediate(() => {
    child.stderr.emit("data", Buffer.from("session_id: 20260822_120000_abc123\n"));
    child.stdout.emit("data", Buffer.from("hello"));
    child.emit("close", 0);
  });
  return child;
}

function payload(provider: string, model: string) {
  return {
    providers: [{ id: provider, name: provider, authenticated: true, models: [{ id: model }], total: 1, source: "live", isUserDefined: false }],
    current: { provider, model },
    reasoning: "medium",
    fetchedAt: Date.now(),
    source: "live",
    stale: false,
  };
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import("@/app/setup-api/hermes/chat/route");
  return POST(new Request("http://localhost/setup-api/hermes/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

/** The argv the route handed to `hermes`, as a flag → value lookup. */
function argvFlag(flag: string): string | null {
  const args = mockSpawn.mock.calls[0]?.[1] as string[] | undefined;
  if (!args) return null;
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

describe("/setup-api/hermes/chat — reasoning levels reaching the CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockImplementation(() => fakeHermes() as never);
  });

  it("sends ollama the only OFF value ollama accepts", async () => {
    // BEFORE: `minimal` → HTTP 400 "\"qwen2.5:3b\" does not support thinking".
    mockGetModelOptions.mockResolvedValue(payload("clawlocal", "qwen2.5:3b") as never);
    mockGet.mockResolvedValue("ollama");

    const res = await post({ message: "hi", provider: "clawlocal", model: "qwen2.5:3b", reasoning: "minimal" });

    expect(res.status).toBe(200);
    expect(argvFlag("--reasoning")).toBe("none");
  });

  it("keeps llama.cpp's OFF value on llama.cpp", async () => {
    mockGetModelOptions.mockResolvedValue(payload("clawlocal", "gemma4-e2b-it-q4_0") as never);
    mockGet.mockResolvedValue("llamacpp");

    const res = await post({ message: "hi", provider: "clawlocal", model: "gemma4-e2b-it-q4_0", reasoning: "none" });

    expect(res.status).toBe(200);
    expect(argvFlag("--reasoning")).toBe("minimal");
  });

  it("never emits a level its backend refuses, whatever the client asks for", async () => {
    mockGetModelOptions.mockResolvedValue(payload("clawlocal", "qwen2.5:3b") as never);
    mockGet.mockResolvedValue("ollama");

    for (const level of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
      mockSpawn.mockClear();
      const res = await post({ message: "hi", provider: "clawlocal", model: "qwen2.5:3b", reasoning: level });
      expect(res.status, level).toBe(200);
      expect(["none", "max"], level).toContain(argvFlag("--reasoning"));
    }
  });

  it("answers `ultra` instead of 400ing on the provider that rejects the word", async () => {
    // clawai answered `ultra` with HTTP 400 "reasoning_effort: unknown", and
    // Hermes' own clamp_effort turns it into `max` for every OpenAI-compatible
    // wire anyway — so the turn a client asked for IS the max turn.
    mockGetModelOptions.mockResolvedValue(payload("clawai", "deepseek-v4-pro") as never);

    const res = await post({ message: "hi", provider: "clawai", model: "deepseek-v4-pro", reasoning: "ultra" });

    expect(res.status).toBe(200);
    expect(argvFlag("--reasoning")).toBe("max");
  });

  it("leaves a cloud provider's own level alone", async () => {
    mockGetModelOptions.mockResolvedValue(payload("anthropic", "claude-sonnet-4-5") as never);

    const res = await post({ message: "hi", provider: "anthropic", model: "claude-sonnet-4-5", reasoning: "high" });

    expect(res.status).toBe(200);
    expect(argvFlag("--reasoning")).toBe("high");
    // No config-store read: only the two-state provider needs to know the
    // runtime, and every other turn must skip that lookup.
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe("/setup-api/hermes/chat — the slim profile for small local models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockImplementation(() => fakeHermes() as never);
    delete process.env.CLAWBOX_SMALL_MODEL_PROFILE;
    delete process.env.CLAWBOX_SMALL_MODEL_TOOLSETS;
  });

  it("narrows the built-in toolsets when the turn runs on a small on-device model", async () => {
    mockGetModelOptions.mockResolvedValue(payload("clawlocal", "gemma4-e2b-it-q4_0") as never);
    mockGet.mockResolvedValue("llamacpp");

    const res = await post({ message: "hi", provider: "clawlocal", model: "gemma4-e2b-it-q4_0" });

    expect(res.status).toBe(200);
    expect(argvFlag("-t")).toBe("web,memory,file,terminal");
  });

  it("does not narrow anything for a cloud provider", async () => {
    mockGetModelOptions.mockResolvedValue(payload("clawai", "deepseek-v4-pro") as never);

    const res = await post({ message: "hi", provider: "clawai", model: "deepseek-v4-pro" });

    expect(res.status).toBe(200);
    expect(argvFlag("-t")).toBeNull();
  });

  it("does not narrow anything for a big local model", async () => {
    mockGetModelOptions.mockResolvedValue(payload("clawlocal", "gpt-oss:20b") as never);
    mockGet.mockResolvedValue("ollama");

    const res = await post({ message: "hi", provider: "clawlocal", model: "gpt-oss:20b" });

    expect(res.status).toBe(200);
    expect(argvFlag("-t")).toBeNull();
  });

  it("can be turned off for the whole device", async () => {
    process.env.CLAWBOX_SMALL_MODEL_PROFILE = "off";
    mockGetModelOptions.mockResolvedValue(payload("clawlocal", "gemma4-e2b-it-q4_0") as never);
    mockGet.mockResolvedValue("llamacpp");

    const res = await post({ message: "hi", provider: "clawlocal", model: "gemma4-e2b-it-q4_0" });

    expect(res.status).toBe(200);
    expect(argvFlag("-t")).toBeNull();
  });
});
