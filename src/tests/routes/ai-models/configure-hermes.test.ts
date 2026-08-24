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
  inferConfiguredLocalModel: vi.fn(),
  runOpenclawConfigSet: vi.fn(),
  runOpenclawConfigSetBatch: vi.fn(),
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
