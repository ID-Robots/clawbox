import { beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(),
  setMany: vi.fn(),
}));

vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: vi.fn().mockReturnValue("/usr/local/bin/openclaw"),
  inferConfiguredLocalModel: vi.fn(),
  readConfig: vi.fn(),
  restartGateway: vi.fn(),
  // Default to "openclaw present". The Hermes-edition disable path is asserted
  // in its own test below by flipping this to true.
  openclawIsAbsent: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/local-ai-runtime", () => ({
  stopLocalAiProvider: vi.fn(),
}));

// The Hermes edition. Both are mocked so the edition-dependent half of the
// route can be driven from a test: `getActiveHarness` decides whether the
// unregister runs at all, and `removeLocalAiFromHermes` is the step that
// matters on that SKU.
vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn(),
}));

vi.mock("@/lib/hermes-local-ai", () => ({
  removeLocalAiFromHermes: vi.fn(),
}));

import { get, setMany } from "@/lib/config-store";
import { stopLocalAiProvider } from "@/lib/local-ai-runtime";
import { inferConfiguredLocalModel, readConfig, restartGateway } from "@/lib/openclaw-config";
import { getActiveHarness } from "@/lib/harness";
import { removeLocalAiFromHermes } from "@/lib/hermes-local-ai";

const mockExecFile = vi.mocked(childProcess.execFile);
const mockSetMany = vi.mocked(setMany);
const mockGet = vi.mocked(get);
const mockStopLocalAiProvider = vi.mocked(stopLocalAiProvider);
const mockInferConfiguredLocalModel = vi.mocked(inferConfiguredLocalModel);
const mockReadConfig = vi.mocked(readConfig);
const mockRestartGateway = vi.mocked(restartGateway);
const mockGetActiveHarness = vi.mocked(getActiveHarness);
const mockRemoveLocalAiFromHermes = vi.mocked(removeLocalAiFromHermes);

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/setup-api/local-ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function setupExecFileMock() {
  mockExecFile.mockImplementation(((
    _cmd: string,
    _args: string[],
    optsOrCallback?: object | ((error: Error | null, result: { stdout: string; stderr: string }) => void),
    maybeCallback?: (error: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    const callback = typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback;
    callback?.(null, { stdout: "", stderr: "" });
    return {
      then: (resolve: (value: { stdout: string; stderr: string }) => void) => {
        resolve({ stdout: "", stderr: "" });
        return {
          catch: () => ({})
        };
      },
      catch: () => ({}),
    } as unknown as ReturnType<typeof childProcess.execFile>;
  }) as unknown as typeof childProcess.execFile);
}

describe("POST /setup-api/local-ai", () => {
  let localAiPost: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSetMany.mockResolvedValue();
    mockReadConfig.mockResolvedValue({});
    mockInferConfiguredLocalModel.mockReturnValue({ provider: "llamacpp", model: "llamacpp/gemma4-e2b-it-q4_0" });
    mockRestartGateway.mockResolvedValue();
    mockStopLocalAiProvider.mockResolvedValue();
    mockGet.mockResolvedValue(undefined);
    mockGetActiveHarness.mockResolvedValue("openclaw");
    mockRemoveLocalAiFromHermes.mockResolvedValue({ wasDefault: false, model: null });
    setupExecFileMock();

    const mod = await import("@/app/setup-api/local-ai/route");
    localAiPost = mod.POST;
  });

  it("disables llama.cpp local AI and clears stored setup flags", async () => {
    const res = await localAiPost(jsonRequest({ action: "disable" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockStopLocalAiProvider).toHaveBeenCalledWith("llamacpp");
    expect(mockRestartGateway).toHaveBeenCalled();
    expect(mockSetMany).toHaveBeenCalledWith({
      local_ai_configured: false,
      local_ai_provider: undefined,
      local_ai_model: undefined,
      local_ai_configured_at: undefined,
    });
  });

  it("stops the runtime our own store knows about when OpenClaw's config is silent", async () => {
    // The Hermes edition: `~/.openclaw/openclaw.json` names no models there, so
    // the OpenClaw-config lookup answers null and "turn Local AI off" used to
    // leave the model resident — up to 3.2 GB of an 8 GB box, and an
    // ollama.service that the enable path had also ENABLED, so it came back
    // after every reboot. Our config store recorded what we started.
    mockInferConfiguredLocalModel.mockReturnValue(null);
    mockGet.mockImplementation(async (key: string) =>
      key === "local_ai_provider" ? "ollama" : undefined,
    );

    const res = await localAiPost(jsonRequest({ action: "disable" }));

    expect(res.status).toBe(200);
    expect(mockStopLocalAiProvider).toHaveBeenCalledWith("ollama");
  });

  it("stops nothing when neither source names a local runtime", async () => {
    mockInferConfiguredLocalModel.mockReturnValue(null);
    mockGet.mockResolvedValue(undefined);

    const res = await localAiPost(jsonRequest({ action: "disable" }));

    expect(res.status).toBe(200);
    expect(mockStopLocalAiProvider).not.toHaveBeenCalled();
  });

  it("warns when the OpenClaw fallback list could not be cleared", async () => {
    // The OpenClaw twin of the same swallow. The stop and the flag clear landed,
    // so this is a qualification and not a refusal — but it must reach the
    // owner: a fallback entry pointing at a model we just stopped is a dead
    // endpoint the next fallback turn walks into.
    mockExecFile.mockImplementation(((
      _cmd: string,
      _args: string[],
      optsOrCallback?: object | ((error: Error | null, result: { stdout: string; stderr: string }) => void),
      maybeCallback?: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const callback = typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback;
      callback?.(new Error("openclaw config set failed"), { stdout: "", stderr: "" });
      return {} as unknown as ReturnType<typeof childProcess.execFile>;
    }) as unknown as typeof childProcess.execFile);

    const res = await localAiPost(jsonRequest({ action: "disable" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(typeof body.warning).toBe("string");
    expect(body.warning).toMatch(/fallback/i);
  });

  describe("the Hermes edition", () => {
    beforeEach(() => {
      mockGetActiveHarness.mockResolvedValue("hermes");
    });

    it("answers 502 when the Hermes unregister failed", async () => {
      // On this SKU the unregister is the ONLY step that takes effect: the
      // OpenClaw fallback clear is skipped (no binary) and the gateway restart
      // is a no-op. Swallowing the failure and answering {success:true} left
      // `providers.clawlocal` in config.yaml, so Hermes' own pickers kept
      // offering a model that is no longer running — and the customer found out
      // only when a chat turn 502'd with "Unknown provider 'clawlocal'".
      mockRemoveLocalAiFromHermes.mockRejectedValue(new Error("hermes config write failed"));

      const res = await localAiPost(jsonRequest({ action: "disable" }));
      const body = await res.json();

      expect(res.status).toBe(502);
      expect(body.success).toBeUndefined();
      expect(body.code).toBe("hermes_unregister_failed");
      expect(typeof body.error).toBe("string");
      // The steps that DID run are not undone, and the answer must not claim
      // they failed: the runtime is stopped and our own flags are cleared, so a
      // retry only has the unregister left to do.
      expect(mockStopLocalAiProvider).toHaveBeenCalledWith("llamacpp");
      expect(mockSetMany).toHaveBeenCalledWith({
        local_ai_configured: false,
        local_ai_provider: undefined,
        local_ai_model: undefined,
        local_ai_configured_at: undefined,
      });
    });

    it("answers 200 when the Hermes unregister landed", async () => {
      mockRemoveLocalAiFromHermes.mockResolvedValue({ wasDefault: true, model: "gemma4-e2b-it-q4_0" });

      const res = await localAiPost(jsonRequest({ action: "disable" }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockSetMany).toHaveBeenCalledWith({ local_ai_was_default: true });
    });
  });

  it("does not touch Hermes on an OpenClaw box", async () => {
    const res = await localAiPost(jsonRequest({ action: "disable" }));

    expect(res.status).toBe(200);
    expect(mockRemoveLocalAiFromHermes).not.toHaveBeenCalled();
  });

  it("ignores a stored provider value that names nothing we run", async () => {
    // The store is JSON on disk; a junk value must not reach stopLocalAiProvider.
    mockInferConfiguredLocalModel.mockReturnValue(null);
    mockGet.mockImplementation(async (key: string) =>
      key === "local_ai_provider" ? "definitely-not-a-runtime" : undefined,
    );

    const res = await localAiPost(jsonRequest({ action: "disable" }));

    expect(res.status).toBe(200);
    expect(mockStopLocalAiProvider).not.toHaveBeenCalled();
  });
});
