/**
 * TASK-2127: while the primary is on the box, OpenClaw's compaction runs on the
 * cloud model the owner left (`agents.defaults.compaction.model`), so a long
 * conversation is summarized in seconds instead of by the 2B model for
 * minutes — and an owner's own compaction model is never touched
 * (src/lib/local-compaction-model.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const coreAtLeast = vi.fn();
vi.mock("@/lib/openclaw-core-generation", () => ({
  installedOpenclawCoreAtLeast: (...args: unknown[]) => coreAtLeast(...args),
}));
const unset = vi.fn();
vi.mock("@/lib/openclaw-config", () => ({
  runOpenclawConfigUnset: (...args: unknown[]) => unset(...args),
}));
const store = new Map<string, unknown>();
vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => store.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    if (value === undefined) store.delete(key);
    else store.set(key, value);
  }),
}));

import {
  COMPACTION_MODEL_PATH,
  LOCAL_COMPACTION_MODEL_KEY,
  cloudCompactionModel,
  disarmLocalCompactionModel,
  isClawboxCompactionModel,
  isOnDeviceModel,
  localCompactionModelArmOps,
  localCompactionModelDisarmNeeded,
  noteLocalCompactionModel,
} from "@/lib/local-compaction-model";
import type { OpenClawConfig } from "@/lib/openclaw-config";

const LOCAL = "llamacpp/gemma4-e2b-it-q4_0";
const CLOUD = "deepseek/deepseek-v4-flash";

const cfg = (defaults: Record<string, unknown> = {}): OpenClawConfig =>
  ({ agents: { defaults } }) as unknown as OpenClawConfig;

beforeEach(() => {
  store.clear();
  coreAtLeast.mockReset().mockResolvedValue(true);
  unset.mockReset().mockResolvedValue(undefined);
});

describe("which model is on the box", () => {
  it("is llama.cpp or Ollama", () => {
    expect(isOnDeviceModel(LOCAL)).toBe(true);
    expect(isOnDeviceModel(" ollama/llama3.2:3b ")).toBe(true);
    expect(isOnDeviceModel(CLOUD)).toBe(false);
    expect(isOnDeviceModel(null)).toBe(false);
  });
});

describe("the cloud model a summary runs on", () => {
  it("is the primary being left, else the first cloud fallback", () => {
    expect(cloudCompactionModel(cfg(), "anthropic/claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4-6");
    expect(cloudCompactionModel(cfg({ model: { fallbacks: [LOCAL, CLOUD] } }), LOCAL)).toBe(CLOUD);
    expect(cloudCompactionModel(cfg({ model: { fallbacks: [CLOUD] } }), null)).toBe(CLOUD);
  });

  it("is nothing when there is no cloud model to name", () => {
    expect(cloudCompactionModel(cfg({ model: { fallbacks: [] } }), LOCAL)).toBeNull();
    expect(cloudCompactionModel(cfg({ model: { fallbacks: ["ollama/qwen3:8b"] } }), "nonsense")).toBeNull();
    expect(cloudCompactionModel(null, undefined)).toBeNull();
  });
});

describe("arming, in the batch that puts the primary on the box", () => {
  it("names the cloud model the owner is leaving", async () => {
    await expect(localCompactionModelArmOps(cfg({ model: { primary: CLOUD } }), LOCAL, CLOUD))
      .resolves.toEqual([[COMPACTION_MODEL_PATH, CLOUD]]);
  });

  it("falls back to the cloud model in the fallback chain", async () => {
    await expect(localCompactionModelArmOps(cfg({ model: { fallbacks: [CLOUD] } }), LOCAL, null))
      .resolves.toEqual([[COMPACTION_MODEL_PATH, CLOUD]]);
  });

  it("writes nothing for a cloud primary, an unreadable config, a value already there or no cloud model", async () => {
    await expect(localCompactionModelArmOps(cfg(), CLOUD, CLOUD)).resolves.toEqual([]);
    await expect(localCompactionModelArmOps(null, LOCAL, CLOUD)).resolves.toEqual([]);
    // An owner's own compaction model — local or cloud — is theirs.
    await expect(localCompactionModelArmOps(cfg({ compaction: { model: "ollama/qwen3:8b" } }), LOCAL, CLOUD)).resolves.toEqual([]);
    await expect(localCompactionModelArmOps(cfg({ model: { fallbacks: [] } }), LOCAL, null)).resolves.toEqual([]);
  });

  it("writes nothing on a core older than 2026.10, whose schema could refuse the switch with it", async () => {
    coreAtLeast.mockResolvedValue(false);
    await expect(localCompactionModelArmOps(cfg(), LOCAL, CLOUD)).resolves.toEqual([]);
    expect(coreAtLeast).toHaveBeenCalledWith(2026, 10);
  });

  it("records what a landed batch wrote, and nothing for a batch without it", async () => {
    await noteLocalCompactionModel([["agents.defaults.model.primary", LOCAL]]);
    expect(store.has(LOCAL_COMPACTION_MODEL_KEY)).toBe(false);
    await noteLocalCompactionModel([["agents.defaults.model.primary", LOCAL], [COMPACTION_MODEL_PATH, CLOUD]]);
    expect(store.get(LOCAL_COMPACTION_MODEL_KEY)).toBe(CLOUD);
  });
});

describe("disarming, after a write that moves the primary off the box", () => {
  it("takes ClawBox's value back out and forgets the record", async () => {
    store.set(LOCAL_COMPACTION_MODEL_KEY, CLOUD);
    const config = cfg({ compaction: { model: CLOUD } });
    await expect(localCompactionModelDisarmNeeded(config, "anthropic/claude-sonnet-4-6")).resolves.toBe(true);
    await disarmLocalCompactionModel("test");
    expect(unset).toHaveBeenCalledWith(COMPACTION_MODEL_PATH);
    expect(store.has(LOCAL_COMPACTION_MODEL_KEY)).toBe(false);
  });

  it("keeps it while the primary is still on the box", async () => {
    store.set(LOCAL_COMPACTION_MODEL_KEY, CLOUD);
    await expect(localCompactionModelDisarmNeeded(cfg({ compaction: { model: CLOUD } }), "ollama/llama3.2:3b")).resolves.toBe(false);
  });

  it("never touches a value ClawBox did not write, or one the owner changed since", async () => {
    await expect(localCompactionModelDisarmNeeded(cfg({ compaction: { model: CLOUD } }), CLOUD)).resolves.toBe(false);
    store.set(LOCAL_COMPACTION_MODEL_KEY, CLOUD);
    await expect(isClawboxCompactionModel(cfg({ compaction: { model: "anthropic/claude-haiku-4-5" } }))).resolves.toBe(false);
    await expect(isClawboxCompactionModel(cfg())).resolves.toBe(false);
  });

  it("logs a failed restore rather than throwing: a cloud model summarizing a cloud chat changes nothing visible", async () => {
    store.set(LOCAL_COMPACTION_MODEL_KEY, CLOUD);
    unset.mockRejectedValue(new Error("config busy"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(disarmLocalCompactionModel("test")).resolves.toBeUndefined();
      expect(err).toHaveBeenCalled();
      // The record stays, so the next move off the box tries again.
      expect(store.get(LOCAL_COMPACTION_MODEL_KEY)).toBe(CLOUD);
    } finally {
      err.mockRestore();
    }
  });
});

describe("under the local-only AI lock (TASK-2501)", () => {
  it("arms nothing: the conversation is not summarized by a cloud model either", async () => {
    store.set("ai_cloud_lock", true);
    expect(await localCompactionModelArmOps(cfg({ model: { fallbacks: [CLOUD] } }), LOCAL, CLOUD)).toEqual([]);
    store.delete("ai_cloud_lock");
    expect(await localCompactionModelArmOps(cfg({ model: { fallbacks: [CLOUD] } }), LOCAL, CLOUD)).toEqual([[COMPACTION_MODEL_PATH, CLOUD]]);
  });

  it("takes ClawBox's cloud value out even while the primary stays on the box", async () => {
    store.set(LOCAL_COMPACTION_MODEL_KEY, CLOUD);
    const armed = cfg({ compaction: { model: CLOUD } });
    expect(await localCompactionModelDisarmNeeded(armed, LOCAL)).toBe(false);
    store.set("ai_cloud_lock", "pinned");
    expect(await localCompactionModelDisarmNeeded(armed, LOCAL)).toBe(true);
  });

  it("still never touches the owner's own compaction model", async () => {
    store.set("ai_cloud_lock", true);
    expect(await localCompactionModelDisarmNeeded(cfg({ compaction: { model: CLOUD } }), LOCAL)).toBe(false);
  });
});
