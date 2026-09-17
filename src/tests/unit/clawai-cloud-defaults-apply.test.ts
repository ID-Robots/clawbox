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
const forgetProbe = vi.fn(() => {});
vi.mock("@/lib/clawai-cloud-embeddings", () => ({
  cloudEmbeddingsUrl: () => "https://clawbox.test/api/ai/embeddings",
  forgetCloudEmbeddingsProbe: () => forgetProbe(),
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

  /**
   * The Memory Shard switch is ClawBox's consent to run index PASSES over the
   * owner's folders. It has never governed WHICH embedder the agent searches
   * with: `ensure-local-embeddings.sh` writes the on-device one into
   * `memory.search` at every gateway start with no regard for it. Gating the
   * cloud half on it meant a freshly onboarded box — the switch is off on a new
   * box — kept the local embedder for good while the Settings card said the
   * target was the cloud, with no reason beside it and nothing that would ever
   * move it. That was every box on the rig after onboarding and linking.
   */
  it("moves the index onto the cloud on a box that has not switched memory search on yet", async () => {
    shardEnabled.mockResolvedValue(false);
    const applied = await applyClawaiCloudDefaults();
    expect(applied.moved).toContain("embeddings");
    expect(switchToCloud).toHaveBeenCalledWith("https://clawbox.test/api/ai/embeddings", "claw_test");
  });

  it("keeps the switch when only the rebuild could not start", async () => {
    startIndex.mockResolvedValue({ accepted: false, declined: "running" } as never);
    const applied = await applyClawaiCloudDefaults();
    expect(applied.moved).toContain("embeddings");
    expect(applied.failed).toEqual([]);
  });

  /**
   * And the rebuild declining BECAUSE the switch is off is the ordinary case on
   * such a box: there is no index to rebuild. The switch itself has landed, so
   * the first pass the owner ever runs builds under the cloud identity instead
   * of building under the local one and being invalidated at the next boot.
   */
  it("treats a rebuild declined for the switch being off as a completed move", async () => {
    shardEnabled.mockResolvedValue(false);
    startIndex.mockResolvedValue({ accepted: false, declined: "disabled" } as never);
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

  /**
   * `probeBox` is not a cheap read — the Kokoro stamp, the user service state,
   * possibly process memory, and up to two executable checks. The status read
   * and the voice promotion each used to do their own, so every eligible boot
   * and every credential link paid for the walk twice.
   */
  it("reads the box's voice once per run, not once per decision", async () => {
    const applied = await applyClawaiCloudDefaults();
    expect(applied.moved).toContain("tts");
    expect(voiceProbe).toHaveBeenCalledTimes(1);
    // `readVoiceState` is still read a second time, by `readOwnerChoices` — a
    // JSON file, asked for concurrently, and for a different question (the
    // legacy stored `local` pick). It is the PROBE that was worth not repeating.
    //
    // The snapshot the move was written from is the one the decision was made
    // from, so the two cannot disagree about what is installed.
    expect(writeProvider).toHaveBeenCalledWith(expect.anything(), expect.anything(), "openai");
  });

  /**
   * The probe cache is cleared INSIDE the lock.
   *
   * Cleared before taking it, a run already holding the lock could still have an
   * `askCloudEmbedder` call in flight — and that call writes its answer into the
   * cache when it lands, AFTER the clear. The credential-change run then read a
   * verdict about the credential it had just replaced and skipped its own probe;
   * when that stale answer was `false`, embeddings stayed on the box for the
   * whole failure TTL after the owner linked a subscription.
   */
  it("clears the probe cache inside the lock, where an in-flight run cannot repopulate it", async () => {
    let release = () => {};
    const inFlight = new Promise<void>((resolve) => { release = resolve; });
    routeReady.mockImplementationOnce(async () => { await inFlight; return true; });

    const first = applyClawaiCloudDefaults();
    // Wait until that run is genuinely inside its probe, holding the lock.
    await vi.waitFor(() => expect(routeReady).toHaveBeenCalledTimes(1));

    const second = applyClawaiCloudDefaults({ credentialChanged: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(forgetProbe).not.toHaveBeenCalled();

    release();
    await Promise.all([first, second]);
    // And it does still happen, once the lock is actually held.
    expect(forgetProbe).toHaveBeenCalledTimes(1);
  });

  it("does not touch the probe cache when the credential is the same one", async () => {
    await applyClawaiCloudDefaults({ trigger: "boot" });
    expect(forgetProbe).not.toHaveBeenCalled();
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
