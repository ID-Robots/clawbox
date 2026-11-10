import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The on-device chat runtimes stand down while an external AI engine is the
 * Local AI (TASK-2376) — an Ollama systemd started at boot or an update's post
 * step brought back included — and nothing happens on a box with no engine.
 * Every way out to the host (systemctl, the process sweep, llama.cpp's stop) is
 * mocked: this suite must never stop a real server on the machine it runs on.
 */

const selected = vi.fn(async () => true);
vi.mock("@/lib/external-engine", () => ({ externalEngineSelected: () => selected() }));

const execFileMock = vi.fn((_file: string, _args: string[], _opts: unknown, cb?: (err: Error | null, out?: { stdout: string; stderr: string }) => void) => {
  const done = typeof _opts === "function" ? (_opts as typeof cb) : cb;
  done?.(null, { stdout: "", stderr: "" });
});
vi.mock("child_process", () => ({ execFile: (...args: unknown[]) => (execFileMock as (...a: unknown[]) => void)(...args) }));
vi.mock("@/lib/process-match", () => ({ terminateByArgv: vi.fn(async () => 0) }));

const stopLlamaCppServerMock = vi.fn(async () => {});
vi.mock("@/instrumentation-node", () => ({
  startLlamaCppServer: vi.fn(async () => "skipped-disabled"),
  stopLlamaCppServer: () => stopLlamaCppServerMock(),
}));
const queryLlamaCppModelsMock = vi.fn(async () => [] as string[]);
vi.mock("@/lib/llamacpp-server", () => ({
  queryLlamaCppServedContext: async () => null,
  getLlamaCppLaunchSpec: () => ({ baseUrl: "http://127.0.0.1:8080/v1", startupTimeoutMs: 1_000 }),
  getLlamaCppProvisioningStatus: async () => ({ modelAvailable: true }),
  queryLlamaCppModels: () => queryLlamaCppModelsMock(),
  resolveConfiguredLlamaCppAlias: async () => "gemma4-e2b-it-q4_0",
}));
vi.mock("@/lib/llamacpp", () => ({
  getDefaultLlamaCppModel: () => "gemma4-e2b-it-q4_0",
  getLlamaCppBaseUrl: () => "http://127.0.0.1:8080/v1",
  getLlamaCppProxyBaseUrl: () => "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
}));

let ollamaUp = true;
beforeEach(() => {
  vi.resetModules();
  execFileMock.mockClear();
  stopLlamaCppServerMock.mockClear();
  queryLlamaCppModelsMock.mockReset().mockResolvedValue([]);
  selected.mockReset().mockResolvedValue(true);
  ollamaUp = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/api/tags")) {
      if (!ollamaUp) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ollamaStops = () => execFileMock.mock.calls.filter(([, args]) => (args as string[]).join(" ").includes("stop ollama.service"));

describe("standDownChatRuntimesForExternalEngine", () => {
  it("stops a running Ollama and a running llama.cpp while an engine is selected", async () => {
    queryLlamaCppModelsMock.mockResolvedValue(["gemma4-e2b-it-q4_0"]);
    const { standDownChatRuntimesForExternalEngine } = await import("@/lib/local-ai-runtime");
    expect(await standDownChatRuntimesForExternalEngine()).toEqual({ ollama: true, llamacpp: true });
    expect(ollamaStops()).toHaveLength(1);
    expect(stopLlamaCppServerMock).toHaveBeenCalledTimes(1);
  });

  it("stops nothing that is not running", async () => {
    ollamaUp = false;
    const { standDownChatRuntimesForExternalEngine } = await import("@/lib/local-ai-runtime");
    expect(await standDownChatRuntimesForExternalEngine()).toEqual({ ollama: false, llamacpp: false });
    expect(ollamaStops()).toHaveLength(0);
    expect(stopLlamaCppServerMock).not.toHaveBeenCalled();
  });

  it("does nothing at all on a box with no engine (the appliance default)", async () => {
    selected.mockResolvedValue(false);
    queryLlamaCppModelsMock.mockResolvedValue(["gemma4-e2b-it-q4_0"]);
    const { standDownChatRuntimesForExternalEngine } = await import("@/lib/local-ai-runtime");
    expect(await standDownChatRuntimesForExternalEngine()).toEqual({ ollama: false, llamacpp: false });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(stopLlamaCppServerMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
