import { describe, expect, it, vi, beforeEach } from "vitest";
import * as childProcess from "child_process";

// The Hermes edition ships no `openclaw` binary. This suite pins that the
// configure route configures the device through Hermes' own config instead of
// shelling out to a binary that cannot exist — the fix for both the local-model
// (Gemma) switch and the API-key path that used to fail with `spawn openclaw
// ENOENT` and then blame the user's credentials.

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    chown: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
    unlink: vi.fn(),
  },
}));

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/home/clawbox/clawbox/data",
  getAll: vi.fn(),
  setMany: vi.fn(),
}));

vi.mock("@/lib/openclaw-config", () => ({
  DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR: 24000,
  compactionReserveFloorForContext: (n: number) =>
    Number.isFinite(n) && n > 0 ? Math.min(24000, Math.max(4096, Math.round(n / 4))) : 24000,
  restartGateway: vi.fn(),
  findOpenclawBin: vi.fn().mockReturnValue("/usr/local/bin/openclaw"),
  readConfig: vi.fn(),
  // The configure route reads the config STRICTLY before it removes an
  // openai-compat override, so the mock has to carry both readers.
  readConfigStrict: vi.fn().mockResolvedValue({}),
  inferConfiguredLocalModel: vi.fn(),
  runOpenclawConfigSet: vi.fn(),
  spawnOpenclawCli: vi.fn().mockResolvedValue(""),
  runOpenclawDoctorFix: vi.fn().mockResolvedValue(undefined),
  runOpenclawConfigSetBatch: vi.fn(),
  runOpenclawConfigUnset: vi.fn(),
  applyModelOverrideToAllAgentSessions: vi.fn().mockResolvedValue(undefined),
  parseFullyQualifiedModel: vi.fn((fq: string) => {
    const i = fq.indexOf("/");
    return i <= 0 || i === fq.length - 1 ? null : { provider: fq.slice(0, i), modelId: fq.slice(i + 1) };
  }),
  setProviderPlugins: vi.fn().mockResolvedValue(undefined),
  openclawIsAbsent: vi.fn(),
  OpenclawUnavailableError: class OpenclawUnavailableError extends Error {},
}));

vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn().mockResolvedValue("hermes"),
}));

// Error classes live inside the (hoisted) factories and are re-imported per test
// from the same post-reset registry as the route, so `instanceof` matches.
vi.mock("@/lib/hermes-local-ai", () => ({
  applyLocalAiToHermes: vi.fn(),
  HermesLocalApplyError: class HermesLocalApplyError extends Error {},
}));

vi.mock("@/lib/hermes-clawai", () => ({
  applyClawaiToHermes: vi.fn(),
  ClawaiApplyError: class ClawaiApplyError extends Error {},
}));

vi.mock("@/lib/hermes-cloud-provider", () => ({
  applyCloudProviderKeyToHermes: vi.fn(),
  HermesCloudApplyError: class HermesCloudApplyError extends Error {},
}));

vi.mock("@/lib/llamacpp", () => ({
  getDefaultLlamaCppModel: vi.fn().mockReturnValue("gemma4-e2b-it-q4_0"),
  getLlamaCppContextWindow: vi.fn().mockReturnValue(131072),
  getLlamaCppMaxTokens: vi.fn().mockReturnValue(131072),
  getLlamaCppProxyBaseUrl: vi.fn().mockReturnValue("http://127.0.0.1/setup-api/local-ai/llamacpp/v1"),
}));

vi.mock("@/lib/local-ai-runtime", () => ({
  getLocalAiProxyBaseUrl: vi.fn((p: string) => `http://127.0.0.1/setup-api/local-ai/${p}`),
  // The enable path brings the runtime up before anything is registered; here
  // it must simply succeed, or every Ollama save would 503 on the mock.
  activateLocalAiProvider: vi.fn(async () => {}),
}));

// The save-time probe (TASK-448). Mocked so no test opens a socket; each test
// states what Ollama would have answered about the requested model. The floor
// constant stays the REAL one — a hand-copied 64_000 would silently keep
// testing the old number if the agent's floor ever moved.
const probeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ollama-model-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ollama-model-context")>()),
  probeOllamaModel: probeMock,
}));

vi.mock("@/lib/local-ai-token", () => ({
  getLocalAiToken: vi.fn().mockReturnValue("a".repeat(64)),
  markLocalAiTokenMigrated: vi.fn(),
}));

vi.mock("@/lib/clawkeep", () => ({ unpairLocal: vi.fn() }));
vi.mock("@/lib/gateway-proxy", () => ({ getOrGenerateGatewayToken: vi.fn().mockResolvedValue("tok") }));
vi.mock("@/lib/codex-model-probe", () => ({ resolveEntitledCodexModel: vi.fn().mockResolvedValue(null) }));
vi.mock("@/app/setup-api/ai-models/catalog/route", () => ({ refreshInBackground: vi.fn() }));

const mockSpawn = vi.mocked(childProcess.spawn);

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/setup-api/ai-models/configure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /setup-api/ai-models/configure — hermes edition", () => {
  let POST: (req: Request) => Promise<Response>;
  let mockSetMany: ReturnType<typeof vi.fn>;
  let mockRunOpenclawConfigSet: ReturnType<typeof vi.fn>;
  let mockRunOpenclawConfigSetBatch: ReturnType<typeof vi.fn>;
  let mockRestartGateway: ReturnType<typeof vi.fn>;
  let mockApplyLocalAiToHermes: ReturnType<typeof vi.fn>;
  let mockApplyClawaiToHermes: ReturnType<typeof vi.fn>;
  let mockApplyCloudProviderKeyToHermes: ReturnType<typeof vi.fn>;
  let HermesLocalApplyError: new (msg?: string) => Error;
  let HermesCloudApplyError: new (msg?: string) => Error;

  beforeEach(async () => {
    vi.resetModules();

    // Resolve every handle (and the error classes) from the SAME post-reset
    // module registry the route will import, so mock returns survive the config's
    // mockReset and `instanceof` in the route's catch blocks matches.
    const oc = await import("@/lib/openclaw-config");
    vi.mocked(oc.openclawIsAbsent).mockReturnValue(true);
    mockRunOpenclawConfigSet = vi.mocked(oc.runOpenclawConfigSet) as unknown as ReturnType<typeof vi.fn>;
    mockRunOpenclawConfigSetBatch = vi.mocked(oc.runOpenclawConfigSetBatch) as unknown as ReturnType<typeof vi.fn>;
    mockRestartGateway = vi.mocked(oc.restartGateway) as unknown as ReturnType<typeof vi.fn>;

    const cs = await import("@/lib/config-store");
    vi.mocked(cs.getAll).mockResolvedValue({});
    mockSetMany = vi.mocked(cs.setMany) as unknown as ReturnType<typeof vi.fn>;
    mockSetMany.mockResolvedValue(undefined);

    const localMod = await import("@/lib/hermes-local-ai");
    HermesLocalApplyError = localMod.HermesLocalApplyError as new (msg?: string) => Error;
    mockApplyLocalAiToHermes = vi.mocked(localMod.applyLocalAiToHermes) as unknown as ReturnType<typeof vi.fn>;
    mockApplyLocalAiToHermes.mockResolvedValue({ provider: "clawlocal", model: "gemma4-e2b-it-q4_0" });

    const clawaiMod = await import("@/lib/hermes-clawai");
    mockApplyClawaiToHermes = vi.mocked(clawaiMod.applyClawaiToHermes) as unknown as ReturnType<typeof vi.fn>;
    mockApplyClawaiToHermes.mockResolvedValue({ provider: "clawai", model: "deepseek-v4-flash", tier: "flash" });

    const cloudMod = await import("@/lib/hermes-cloud-provider");
    HermesCloudApplyError = cloudMod.HermesCloudApplyError as new (msg?: string) => Error;
    mockApplyCloudProviderKeyToHermes = vi.mocked(cloudMod.applyCloudProviderKeyToHermes) as unknown as ReturnType<typeof vi.fn>;
    mockApplyCloudProviderKeyToHermes.mockResolvedValue({ provider: "anthropic", model: "claude-sonnet-4-6", activated: true });

    // A healthy default: the requested model exists and its window clears the
    // 64K floor, so only the tests ABOUT the gate have to say otherwise.
    probeMock.mockResolvedValue({ status: "ok", contextLength: 128_000 });

    // mockReset strips every factory-time mockResolvedValue, so the harness —
    // like openclawIsAbsent above — is re-established per test.
    const harness = await import("@/lib/harness");
    vi.mocked(harness.getActiveHarness).mockResolvedValue("hermes");

    ({ POST } = await import("@/app/setup-api/ai-models/configure/route"));
  });

  /** Assert that nothing in this call reached the OpenClaw CLI. */
  function expectNoOpenclawSpawn() {
    expect(mockRunOpenclawConfigSet).not.toHaveBeenCalled();
    expect(mockRunOpenclawConfigSetBatch).not.toHaveBeenCalled();
    expect(mockRestartGateway).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  }

  it("switches the local model (Gemma) through Hermes without spawning openclaw", async () => {
    const res = await POST(jsonRequest({ provider: "llamacpp", scope: "local" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockApplyLocalAiToHermes).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "llamacpp", model: "gemma4-e2b-it-q4_0", makeDefault: true }),
    );
    expect(mockSetMany).toHaveBeenCalledWith(expect.objectContaining({
      local_ai_configured: true,
      local_ai_provider: "llamacpp",
    }));
    expectNoOpenclawSpawn();
  });

  // A device that already has a cloud provider must NOT be hijacked by merely
  // enabling a local fallback — but it must still be switchable on request.
  // Conflating the two is what left the box "configured for Gemma" while every
  // message went to ClawBox AI, with no working way to change it.
  it("leaves the chosen provider in place when a configured device just enables Gemma", async () => {
    const cs = await import("@/lib/config-store");
    vi.mocked(cs.getAll).mockResolvedValue({ ai_model_configured: true });

    const res = await POST(jsonRequest({ provider: "llamacpp", scope: "local" }));

    expect(res.status).toBe(200);
    expect(mockApplyLocalAiToHermes).toHaveBeenCalledWith(
      expect.objectContaining({ makeDefault: false }),
    );
  });

  it("promotes Gemma to the active model when the user explicitly asked to switch", async () => {
    const cs = await import("@/lib/config-store");
    vi.mocked(cs.getAll).mockResolvedValue({ ai_model_configured: true });

    const res = await POST(jsonRequest({ provider: "llamacpp", scope: "local", activate: true }));

    expect(res.status).toBe(200);
    expect(mockApplyLocalAiToHermes).toHaveBeenCalledWith(
      expect.objectContaining({ makeDefault: true }),
    );
  });

  it("configures an API-key cloud provider (Anthropic) through Hermes, not openclaw", async () => {
    const res = await POST(jsonRequest({ provider: "anthropic", apiKey: "sk-ant-test", authMode: "token" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockApplyCloudProviderKeyToHermes).toHaveBeenCalledWith({
      openclawProvider: "anthropic",
      apiKey: "sk-ant-test",
    });
    expectNoOpenclawSpawn();
  });

  it("configures ClawBox AI through Hermes, not openclaw", async () => {
    const cs = await import("@/lib/config-store");
    vi.mocked(cs.getAll).mockResolvedValue({ clawai_token: "claw_abc123def456" });

    const res = await POST(jsonRequest({ provider: "clawai", clawaiTier: "flash" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockApplyClawaiToHermes).toHaveBeenCalled();
    expectNoOpenclawSpawn();
  });

  it("refuses an Ollama model under the 64K floor before anything is written", async () => {
    // qwen2.5:3b reports a 32K window; Hermes refuses to start a session below
    // 64K, so saving it used to produce a device that said "configured" and
    // 502'd every chat turn. The refusal must come BEFORE the config-store
    // write and the Hermes registration — a half-saved dead model is the bug.
    probeMock.mockResolvedValue({ status: "ok", contextLength: 32_768 });

    const res = await POST(jsonRequest({ provider: "ollama", apiKey: "qwen2.5:3b", scope: "local" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(String(body.error)).toContain("32,768");
    expect(String(body.error)).toContain("64,000");
    expect(mockSetMany).not.toHaveBeenCalled();
    expect(mockApplyLocalAiToHermes).not.toHaveBeenCalled();
  });

  it("refuses an Ollama id the device does not have", async () => {
    // configure({model:"qwen2.5:3b"}) with the model absent used to answer
    // {success:true}; the first chat turn then 404'd upstream.
    probeMock.mockResolvedValue({ status: "not-installed" });

    const res = await POST(jsonRequest({ provider: "ollama", apiKey: "ghost:7b", scope: "local" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(String(body.error)).toContain('"ghost:7b"');
    expect(mockSetMany).not.toHaveBeenCalled();
    expect(mockApplyLocalAiToHermes).not.toHaveBeenCalled();
  });

  it("honours the model FIELD for Ollama, not only the apiKey slot", async () => {
    // The wizard sends the id through `apiKey`; every cloud provider sends its
    // pick through `model`. An API caller who used `model` had the field
    // silently ignored and llama3.2:3b saved in its place.
    const res = await POST(jsonRequest({ provider: "ollama", model: "qwen3:8b", scope: "local" }));

    expect(res.status).toBe(200);
    expect(probeMock).toHaveBeenCalledWith("qwen3:8b");
    expect(mockApplyLocalAiToHermes).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "ollama", model: "qwen3:8b" }),
    );
  });

  it("honours the model FIELD for llama.cpp too", async () => {
    // Same two slots as Ollama, same reason: a caller naming a model must
    // never have a different one saved in its place.
    const res = await POST(jsonRequest({ provider: "llamacpp", model: "gemma4-e4b-it-q4_0", scope: "local" }));

    expect(res.status).toBe(200);
    expect(mockApplyLocalAiToHermes).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "llamacpp", model: "gemma4-e4b-it-q4_0" }),
    );
  });

  it("saves a 64K-capable Ollama model and registers it with Hermes", async () => {
    const res = await POST(jsonRequest({ provider: "ollama", apiKey: "qwen3:8b", scope: "local" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockSetMany).toHaveBeenCalledWith(expect.objectContaining({
      local_ai_configured: true,
      local_ai_provider: "ollama",
      local_ai_model: "ollama/qwen3:8b",
    }));
    expect(mockApplyLocalAiToHermes).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "ollama", model: "qwen3:8b", makeDefault: true }),
    );
    expectNoOpenclawSpawn();
  });

  it("never reads a handoff-filled apiKey slot as a local model id", async () => {
    // The `apiKey` slot carries the MODEL id for a local provider, and on the
    // OAuth-handoff path it is filled from a token file on disk. A handoff
    // that records no provider leaves `body.provider` as the caller sent it,
    // so a body saying `ollama` would have made the access token the model id
    // — and put it in an outbound request body. `model` still names the model.
    const fsp = (await import("fs/promises")).default;
    vi.mocked(fsp.readFile).mockResolvedValue(
      JSON.stringify({ access_token: "handoff-access-token-placeholder", createdAt: Date.now() }) as never,
    );

    const res = await POST(jsonRequest({
      provider: "ollama",
      scope: "local",
      oauthHandoff: true,
      model: "qwen3:8b",
    }));

    expect(res.status).toBe(200);
    expect(probeMock).toHaveBeenCalledWith("qwen3:8b");
    expect(probeMock).not.toHaveBeenCalledWith(expect.stringContaining("handoff-access-token"));
    expect(mockApplyLocalAiToHermes).toHaveBeenCalledWith(
      expect.objectContaining({ model: "qwen3:8b" }),
    );
  });

  it("still saves when Ollama cannot be asked about the model", async () => {
    // Fail-open by design: on the primary-scope path the runtime starts Ollama
    // on demand, so "the probe could not connect" is not a verdict about the
    // model — refusing here would brick a legitimate flow.
    probeMock.mockResolvedValue({ status: "unreachable" });

    const res = await POST(jsonRequest({ provider: "ollama", apiKey: "qwen3:8b", scope: "local" }));

    expect(res.status).toBe(200);
    expect(mockApplyLocalAiToHermes).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "ollama", model: "qwen3:8b" }),
    );
  });

  it("does not blame credentials when the local-model setup fails on Hermes", async () => {
    mockApplyLocalAiToHermes.mockRejectedValue(new HermesLocalApplyError("local model id is malformed"));

    const res = await POST(jsonRequest({ provider: "llamacpp", scope: "local" }));
    const body = await res.json();

    expect(res.ok).toBe(false);
    expect(body.error).toBe("local model id is malformed");
    expect(String(body.error).toLowerCase()).not.toContain("credential");
    expectNoOpenclawSpawn();
  });

  it("returns an honest, non-credential message for a provider with no Hermes API-key home", async () => {
    mockApplyCloudProviderKeyToHermes.mockRejectedValue(
      new HermesCloudApplyError("This provider is set up through the Hermes provider panel on this edition."),
    );

    const res = await POST(jsonRequest({ provider: "google", apiKey: "AIzaTest", authMode: "token" }));
    const body = await res.json();

    expect(res.ok).toBe(false);
    expect(String(body.error).toLowerCase()).not.toContain("credential");
    expectNoOpenclawSpawn();
  });
});
