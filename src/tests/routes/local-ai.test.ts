import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(),
  setMany: vi.fn(),
}));

vi.mock("@/lib/openclaw-config", () => ({
  inferConfiguredLocalModel: vi.fn(),
  readConfig: vi.fn(),
  restartGateway: vi.fn(),
  runOpenclawConfigSet: vi.fn(),
  // Default to "openclaw present" — the OpenClaw and dual SKUs. The Hermes SKU
  // flips this to true in its own describe block below, where it is what makes
  // the fallback clear and the gateway restart no-ops.
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
  // Listed because the ROUTE narrows on it: an export the factory omits is
  // `undefined`, and `err instanceof undefined` is a TypeError inside the very
  // catch that is meant to keep the failure readable.
  HermesLocalRemovalError: class HermesLocalRemovalError extends Error {
    constructor(message: string, readonly wasDefault: boolean) {
      super(message);
    }
  },
}));

import { get, setMany } from "@/lib/config-store";
import { stopLocalAiProvider } from "@/lib/local-ai-runtime";
import { inferConfiguredLocalModel, openclawIsAbsent, readConfig, restartGateway, runOpenclawConfigSet } from "@/lib/openclaw-config";
import { getActiveHarness } from "@/lib/harness";
import { HermesLocalRemovalError, removeLocalAiFromHermes } from "@/lib/hermes-local-ai";

const mockSetMany = vi.mocked(setMany);
const mockGet = vi.mocked(get);
const mockStopLocalAiProvider = vi.mocked(stopLocalAiProvider);
const mockInferConfiguredLocalModel = vi.mocked(inferConfiguredLocalModel);
const mockReadConfig = vi.mocked(readConfig);
const mockRestartGateway = vi.mocked(restartGateway);
const mockOpenclawIsAbsent = vi.mocked(openclawIsAbsent);
const mockRunOpenclawConfigSet = vi.mocked(runOpenclawConfigSet);
const mockGetActiveHarness = vi.mocked(getActiveHarness);
const mockRemoveLocalAiFromHermes = vi.mocked(removeLocalAiFromHermes);

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/setup-api/local-ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
    mockOpenclawIsAbsent.mockReturnValue(false);
    mockRunOpenclawConfigSet.mockResolvedValue();

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
    //
    // Rejecting from `runOpenclawConfigSet` and not from a raw spawn is the
    // point: that wrapper has already retried the mutation conflict and read a
    // deadline-killed write back off disk, so a rejection from it is a write
    // that genuinely did not land.
    mockRunOpenclawConfigSet.mockRejectedValue(new Error("openclaw config set failed"));

    const res = await localAiPost(jsonRequest({ action: "disable" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(typeof body.warning).toBe("string");
    expect(body.warning).toMatch(/fallback/i);
  });

  it("clears the OpenClaw fallback list through the verified wrapper", async () => {
    await localAiPost(jsonRequest({ action: "disable" }));

    expect(mockRunOpenclawConfigSet).toHaveBeenCalledWith(
      ["agents.defaults.model.fallbacks", "[]", "--json"],
      expect.anything(),
    );
  });

  describe("the Hermes edition", () => {
    beforeEach(() => {
      mockGetActiveHarness.mockResolvedValue("hermes");
      // The SKU, not just the active harness: `openclawIsAbsent()` is
      // `readEdition() === "hermes"`, and leaving it false ran these cases as a
      // dual box — spawning the OpenClaw CLI on a device that has no binary,
      // which is the very state the guard exists for.
      mockOpenclawIsAbsent.mockReturnValue(true);
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
      // Nothing was spawned at OpenClaw on a box that has no OpenClaw.
      expect(mockRunOpenclawConfigSet).not.toHaveBeenCalled();
    });

    it("still records that the local model WAS the selection when the removal failed", async () => {
      // A partial unset can clear `model.provider` and leave a providers key,
      // and this answer is the last time the fact exists: the retry reads a
      // `model.provider` that is already gone, so `wasDefault` is false for
      // ever and re-enabling Local AI puts the device on nothing rather than
      // back on the model it was on.
      mockRemoveLocalAiFromHermes.mockRejectedValue(
        new HermesLocalRemovalError("The local model is still registered with Hermes.", true),
      );

      const res = await localAiPost(jsonRequest({ action: "disable" }));

      expect(res.status).toBe(502);
      expect(mockSetMany).toHaveBeenCalledWith({ local_ai_was_default: true });
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

  it("answers both failures on a dual box running Hermes", async () => {
    // The Hermes branch is gated on the ACTIVE harness, which a licensed `dual`
    // box also satisfies — and there OpenClaw exists and its gateway does too.
    // Returning from inside that branch dropped the fallback warning and skipped
    // the restart that makes the clear take effect, so both are answered after
    // the restart instead.
    mockGetActiveHarness.mockResolvedValue("hermes");
    mockOpenclawIsAbsent.mockReturnValue(false);
    mockRunOpenclawConfigSet.mockRejectedValue(new Error("openclaw config set failed"));
    mockRemoveLocalAiFromHermes.mockRejectedValue(new Error("hermes config write failed"));

    const res = await localAiPost(jsonRequest({ action: "disable" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.code).toBe("hermes_unregister_failed");
    // The panel paints `error` red on a non-2xx and never reads `warning`
    // there, so the fallback sentence has to ride in `error` or be lost.
    expect(body.error).toMatch(/removing it from Hermes could not be confirmed/);
    expect(body.error).toMatch(/fallback model list/i);
    expect(mockRestartGateway).toHaveBeenCalled();
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
