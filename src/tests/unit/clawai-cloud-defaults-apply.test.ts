/**
 * The applier behind the owner's decision of 2026-09-14.
 *
 * Two properties are the whole of its safety and both are pinned here, because
 * both are about not taking something away from the person who owns the box:
 * it only ever PROMOTES to the cloud, and it never overrides a choice the owner
 * made — including one made on a box that predates the key that records it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
vi.mock("@/lib/config-store", () => ({
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown) => { store.set(key, value); },
}));

const entitlement = vi.fn(async () => "pro" as string | null);
vi.mock("@/lib/clawai-plan-tier", () => ({ readClawaiEntitlementTier: () => entitlement() }));

const token = vi.fn(async () => "claw_test" as string | null);
vi.mock("@/lib/harness/credentials", () => ({
  CLAWBOX_AI_PROXY_URL: "https://clawbox.test/api/ai",
  resolveClawaiToken: () => token(),
}));

const routeReady = vi.fn(async () => true);
vi.mock("@/lib/clawai-cloud-embeddings", () => ({
  cloudEmbeddingsUrl: async () => "https://clawbox.test/api/ai/embeddings",
  forgetCloudEmbeddingsProbe: () => {},
  probeCloudEmbeddings: () => routeReady(),
}));

const startIndex = vi.fn(async () => ({ accepted: true }));
vi.mock("@/lib/clawkeep-memory", () => ({
  invalidateMemoryStatusCache: () => {},
  startMemoryIndex: (...a: unknown[]) => startIndex(...(a as [])),
}));

vi.mock("@/lib/harness", () => ({ getActiveHarness: async () => "openclaw" }));

const openclawAbsent = vi.fn(() => false);
vi.mock("@/lib/openclaw-config", () => ({ openclawIsAbsent: () => openclawAbsent() }));

const switchToCloud = vi.fn(async () => {});
const embeddingChoice = vi.fn(async () => ({ provider: "openai-compatible", model: "q", baseUrl: "http://127.0.0.1:3000/setup-api/local-ai/embed/v1" }));
const shardEnabled = vi.fn(async () => true);
vi.mock("@/lib/memory-shard", () => ({
  getMemoryShardEnabled: () => shardEnabled(),
  readEmbeddingChoice: () => embeddingChoice(),
  switchToCloudEmbeddings: (...a: unknown[]) => switchToCloud(...(a as [])),
}));

const syncChannel = vi.fn(async () => true);
vi.mock("@/lib/stt-channel", () => ({ syncChannelAudio: (...a: unknown[]) => syncChannel(...(a as [])) }));
vi.mock("@/lib/stt-local", () => ({ localSttInstalled: async () => ({ installed: true, detail: "" }) }));

const writeProvider = vi.fn(async () => {});
const voiceProbe = vi.fn(async () => ({
  config: {
    tts: {
      provider: "tts-local-cli",
      providers: {
        "tts-local-cli": { command: "/opt/clawbox-tts.sh" },
        openai: { apiKey: "claw_test", baseUrl: "https://clawbox.test/api/ai", model: "gpt-4o-mini-tts" },
      },
    },
  },
  probe: { providerConfigured: true, commandPresent: true, engineInstalled: true, engineNames: ["Kokoro"] },
}));
vi.mock("@/lib/voice-box", () => ({
  probeBox: () => voiceProbe(),
  writeActiveVoiceProvider: (...a: unknown[]) => writeProvider(...(a as [])),
}));

const voiceState = vi.fn(async () => ({ choice: "auto" as string }));
vi.mock("@/lib/voice-output-store", () => ({ readVoiceState: () => voiceState() }));

import { applyClawaiCloudDefaults, readCloudDefaultsStatus } from "@/lib/clawai-cloud-defaults";
import { CHOICE_SOURCE_KEYS } from "@/lib/clawai-cloud-defaults-state";

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  entitlement.mockResolvedValue("pro");
  token.mockResolvedValue("claw_test");
  routeReady.mockResolvedValue(true);
  openclawAbsent.mockReturnValue(false);
  shardEnabled.mockResolvedValue(true);
  syncChannel.mockResolvedValue(true);
  startIndex.mockResolvedValue({ accepted: true });
  voiceState.mockResolvedValue({ choice: "auto" });
  embeddingChoice.mockResolvedValue({ provider: "openai-compatible", model: "q", baseUrl: "http://127.0.0.1:3000/setup-api/local-ai/embed/v1" });
});

describe("applyClawaiCloudDefaults", () => {
  it("puts an entitled box on all three cloud engines", async () => {
    const applied = await applyClawaiCloudDefaults();
    expect(applied.moved.sort()).toEqual(["embeddings", "stt", "tts"]);
    expect(applied.failed).toEqual([]);
    expect(writeProvider).toHaveBeenCalledWith(expect.anything(), expect.anything(), "openai");
    expect(switchToCloud).toHaveBeenCalledWith("https://clawbox.test/api/ai/embeddings", "claw_test");
    // Moving the index invalidates its fingerprint, so the rebuild goes with it.
    expect(startIndex).toHaveBeenCalledWith("full", "manual");
  });

  it("touches nothing on a box with no subscription", async () => {
    token.mockResolvedValue(null);
    entitlement.mockResolvedValue(null);
    const applied = await applyClawaiCloudDefaults();
    expect(applied.moved).toEqual([]);
    expect(writeProvider).not.toHaveBeenCalled();
    expect(switchToCloud).not.toHaveBeenCalled();
    expect(syncChannel).not.toHaveBeenCalled();
  });

  it("leaves the voice alone on a plan that does not include it", async () => {
    entitlement.mockResolvedValue("flash");
    const applied = await applyClawaiCloudDefaults();
    expect(applied.moved).not.toContain("tts");
    expect(writeProvider).not.toHaveBeenCalled();
    // The other two still move: the three gates are separate.
    expect(applied.moved.sort()).toEqual(["embeddings", "stt"]);
  });

  it("never overrides an owner who pinned the engine on the box", async () => {
    for (const capability of ["tts", "stt", "embeddings"] as const) {
      store.set(CHOICE_SOURCE_KEYS[capability], "owner");
    }
    const applied = await applyClawaiCloudDefaults();
    expect(applied.moved).toEqual([]);
    expect(writeProvider).not.toHaveBeenCalled();
    expect(switchToCloud).not.toHaveBeenCalled();
    expect(syncChannel).not.toHaveBeenCalled();
  });

  it("reads a box that predates the key by what only a person could have written", async () => {
    // No source key anywhere, and the two settings only a click ever produced.
    store.set("stt_primary", "local");
    voiceState.mockResolvedValue({ choice: "local" });
    const applied = await applyClawaiCloudDefaults();
    expect(applied.moved).toEqual(["embeddings"]);
    expect(writeProvider).not.toHaveBeenCalled();
    expect(syncChannel).not.toHaveBeenCalled();
  });

  it("never demotes: a capability already in the cloud is left exactly as it is", async () => {
    entitlement.mockResolvedValue("free");
    store.set("stt_primary", "cloud");
    // Both halves of transcription already say cloud, so the channel sync has
    // nothing to write — see the loop's note on why it is still asked.
    syncChannel.mockResolvedValue(false);
    embeddingChoice.mockResolvedValue({ provider: "openai-compatible", model: "text-embedding-3-large", baseUrl: "https://clawbox.test/api/ai" });
    voiceProbe.mockResolvedValueOnce({
      config: { tts: { provider: "openai", providers: { openai: { apiKey: "claw_test", baseUrl: "https://clawbox.test/api/ai" } } } },
      probe: { providerConfigured: false, commandPresent: false, engineInstalled: false, engineNames: [] },
    } as never);
    const applied = await applyClawaiCloudDefaults();
    expect(applied.moved).toEqual([]);
    expect(writeProvider).not.toHaveBeenCalled();
    expect(switchToCloud).not.toHaveBeenCalled();
  });

  it("does not point the voice at a cloud engine this box has no endpoint for", async () => {
    // gateway-pre-start.sh writes the provider entry on an entitled box; until
    // it has, a pick here would answer every utterance with a 401.
    voiceProbe.mockResolvedValue({
      config: { tts: { provider: "tts-local-cli", providers: { "tts-local-cli": { command: "/opt/clawbox-tts.sh" } } } },
      probe: { providerConfigured: true, commandPresent: true, engineInstalled: true, engineNames: ["Kokoro"] },
    } as never);
    const applied = await applyClawaiCloudDefaults();
    expect(applied.moved).not.toContain("tts");
    expect(writeProvider).not.toHaveBeenCalled();
  });

  it("does not move the index on a box whose owner has memory search switched off", async () => {
    shardEnabled.mockResolvedValue(false);
    const applied = await applyClawaiCloudDefaults();
    expect(applied.moved).not.toContain("embeddings");
    expect(switchToCloud).not.toHaveBeenCalled();
  });

  it("keeps the switch when only the rebuild could not start", async () => {
    startIndex.mockResolvedValue({ accepted: false, declined: "running" } as never);
    const applied = await applyClawaiCloudDefaults();
    expect(applied.moved).toContain("embeddings");
    expect(applied.failed).toEqual([]);
  });

  it("reports one capability's refusal without costing the other two", async () => {
    switchToCloud.mockRejectedValue(new Error("the CLI said no") as never);
    const applied = await applyClawaiCloudDefaults();
    expect(applied.moved.sort()).toEqual(["stt", "tts"]);
    expect(applied.failed).toEqual([{ capability: "embeddings", error: "the CLI said no" }]);
  });
});

describe("readCloudDefaultsStatus", () => {
  it("says where each capability runs, where it should, and why not", async () => {
    entitlement.mockResolvedValue("flash");
    const status = await readCloudDefaultsStatus();
    expect(status).toMatchObject({
      linked: true,
      plan: "flash",
      capabilities: {
        tts: { source: "local", target: "local", ownerChoice: false, reason: "plan" },
        stt: { source: "cloud", target: "cloud", ownerChoice: false, reason: null },
        embeddings: { source: "local", target: "cloud", ownerChoice: false, reason: null },
      },
    });
  });

  it("makes an owner's pin its own target, so nothing reads as drifted", async () => {
    store.set(CHOICE_SOURCE_KEYS.stt, "owner");
    store.set("stt_primary", "local");
    const status = await readCloudDefaultsStatus();
    expect(status.capabilities.stt).toEqual({ source: "local", target: "local", ownerChoice: true, reason: "owner" });
  });

  it("calls the index local on the edition that indexes on the box", async () => {
    openclawAbsent.mockReturnValue(true);
    const status = await readCloudDefaultsStatus();
    expect(status.capabilities.embeddings).toEqual({ source: "local", target: "local", ownerChoice: false, reason: "edition" });
    // And the probe is never even asked for: the answer could not change it.
    expect(routeReady).not.toHaveBeenCalled();
  });
});
