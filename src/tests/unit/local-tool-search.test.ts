/**
 * OpenClaw's Tool Search follows the primary model: off while the primary is
 * the on-device llama.cpp model (a ~2B model cannot drive tool_search /
 * tool_call), OpenClaw's default the moment the primary is a cloud model — and
 * an owner's own setting is never touched (src/lib/local-tool-search.ts).
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

import {
  LOCAL_TOOL_SEARCH_OFF,
  TOOL_SEARCH_PATH,
  disarmLocalToolSearch,
  isClawboxToolSearchOff,
  isOnDevicePrimary,
  localToolSearchArmOps,
  localToolSearchDisarmNeeded,
} from "@/lib/local-tool-search";

const LOCAL = "llamacpp/gemma4-e2b-it-q4_0";
const CLOUD = "deepseek/deepseek-v4-flash";

beforeEach(() => {
  coreAtLeast.mockReset().mockResolvedValue(true);
  unset.mockReset().mockResolvedValue(undefined);
});

describe("which primary is on the device", () => {
  it("is the llama.cpp provider and nothing else", () => {
    expect(isOnDevicePrimary(LOCAL)).toBe(true);
    expect(isOnDevicePrimary(` ${LOCAL} `)).toBe(true);
    expect(isOnDevicePrimary(CLOUD)).toBe(false);
    expect(isOnDevicePrimary("ollama/llama3.2:3b")).toBe(false);
    expect(isOnDevicePrimary("llamacpp")).toBe(false);
    expect(isOnDevicePrimary(null)).toBe(false);
  });
});

describe("ClawBox's own value", () => {
  it("is exactly {enabled: false}", () => {
    expect(isClawboxToolSearchOff(LOCAL_TOOL_SEARCH_OFF)).toBe(true);
    expect(isClawboxToolSearchOff({ enabled: false })).toBe(true);
    expect(isClawboxToolSearchOff(false)).toBe(false); // the owner's spelling
    expect(isClawboxToolSearchOff({ enabled: false, mode: "tools" })).toBe(false);
    expect(isClawboxToolSearchOff({ enabled: true })).toBe(false);
    expect(isClawboxToolSearchOff({})).toBe(false);
    expect(isClawboxToolSearchOff(null)).toBe(false);
  });
});

describe("arming, in the batch that writes the primary", () => {
  it("turns Tool Search off for a primary on the device", async () => {
    await expect(localToolSearchArmOps({}, LOCAL)).resolves.toEqual([
      [TOOL_SEARCH_PATH, JSON.stringify({ enabled: false }), "--json"],
    ]);
    await expect(localToolSearchArmOps({ tools: { profile: "full" } }, LOCAL)).resolves.toHaveLength(1);
    expect(coreAtLeast).toHaveBeenCalledWith(2026, 10);
  });

  it("does nothing for a cloud primary", async () => {
    await expect(localToolSearchArmOps({}, CLOUD)).resolves.toEqual([]);
  });

  it("never overrides a value already there — the owner's, or ours", async () => {
    for (const toolSearch of [false, true, { mode: "directory" }, { enabled: false }]) {
      await expect(localToolSearchArmOps({ tools: { toolSearch } } as never, LOCAL)).resolves.toEqual([]);
    }
  });

  it("does not guess on a config it could not read, or a core it cannot tell is 2026.10+", async () => {
    await expect(localToolSearchArmOps(null, LOCAL)).resolves.toEqual([]);
    coreAtLeast.mockResolvedValue(false);
    await expect(localToolSearchArmOps({}, LOCAL)).resolves.toEqual([]);
  });
});

describe("disarming, after a write that moves the primary off the device", () => {
  it("is needed only for ClawBox's own value on a cloud primary", () => {
    expect(localToolSearchDisarmNeeded({ tools: { toolSearch: { enabled: false } } } as never, CLOUD)).toBe(true);
    expect(localToolSearchDisarmNeeded({ tools: { toolSearch: { enabled: false } } } as never, LOCAL)).toBe(false);
    expect(localToolSearchDisarmNeeded({ tools: { toolSearch: false } } as never, CLOUD)).toBe(false);
    expect(localToolSearchDisarmNeeded({}, CLOUD)).toBe(false);
    expect(localToolSearchDisarmNeeded(null, CLOUD)).toBe(false);
  });

  it("unsets the key, which is what OpenClaw's default means", async () => {
    await expect(disarmLocalToolSearch("test")).resolves.toBeUndefined();
    expect(unset).toHaveBeenCalledWith("tools.toolSearch");
  });

  it("says so when it could not, instead of claiming the default is back", async () => {
    unset.mockRejectedValue(new Error("busy"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const warning = await disarmLocalToolSearch("test");
      expect(warning).toMatch(/Tool Search is still off/);
      expect(warning).toContain("openclaw config unset tools.toolSearch");
    } finally {
      err.mockRestore();
    }
  });
});
