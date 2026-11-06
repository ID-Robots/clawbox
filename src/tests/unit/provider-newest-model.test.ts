import { describe, expect, it } from "vitest";
import {
  NEWEST_MODEL_PROVIDERS,
  fallbackModelId,
  flagshipVersion,
  followsNewestModel,
  newestModelId,
  rankNewestFirst,
} from "@/lib/provider-newest-model";
import { XAI_DEFAULT_MODEL_ID, XAI_MODELS } from "@/lib/provider-models";

// The default for a newest-following provider is read off the provider's own
// list, never spelled by hand (the xAI picker shipped `grok-4.6` while the
// account's quota was on Grok 4.7). These pin the ranking every caller shares.

const rows = (...ids: string[]) => ids.map((id) => ({ id }));

describe("provider-newest-model", () => {
  it("wires xAI, and only providers with a policy", () => {
    expect(NEWEST_MODEL_PROVIDERS).toEqual(["xai"]);
    expect(followsNewestModel("xai")).toBe(true);
    expect(followsNewestModel(" XAI ")).toBe(true);
    expect(followsNewestModel("anthropic")).toBe(false);
    expect(followsNewestModel("constructor")).toBe(false);
    expect(followsNewestModel(undefined)).toBe(false);
  });

  it("reads a version only off a plain generational Grok id", () => {
    expect(flagshipVersion("xai", "grok-4.7")).toEqual([4, 7]);
    expect(flagshipVersion("xai", "grok-5")).toEqual([5]);
    for (const variant of ["grok-4.20-0309-reasoning", "grok-4-fast", "grok-4.7-latest", "grok-build-0.1", "grok-4.20-multi-agent-0309", "grok-imagine-image"]) {
      expect(flagshipVersion("xai", variant), variant).toBeNull();
    }
    expect(flagshipVersion("anthropic", "grok-4.7")).toBeNull();
  });

  it("puts the newest flagship first and keeps every other row, in order, after", () => {
    const ranked = rankNewestFirst("xai", rows("grok-4.20-0309-reasoning", "grok-4.3", "grok-4.6", "grok-build-0.1", "grok-4.7", "grok-4.5"));
    expect(ranked.map((m) => m.id)).toEqual(["grok-4.7", "grok-4.6", "grok-4.5", "grok-4.3", "grok-4.20-0309-reasoning", "grok-build-0.1"]);
  });

  it("makes a model the provider ships later the default, with no release in between", () => {
    const today = rows("grok-4.7", "grok-4.6", "grok-4.5");
    expect(newestModelId("xai", today)).toBe("grok-4.7");
    expect(newestModelId("xai", [...today, { id: "grok-4.8" }])).toBe("grok-4.8");
    expect(newestModelId("xai", [...today, { id: "grok-5" }])).toBe("grok-5");
  });

  it("never lets a dated 4.20 variant outrank 4.7", () => {
    expect(newestModelId("xai", rows("grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning", "grok-4.7"))).toBe("grok-4.7");
  });

  it("ranks by the provider's creation date when both rows carry one", () => {
    const ranked = rankNewestFirst("xai", [
      { id: "grok-4.6", createdAt: 3_000 },
      { id: "grok-4.7", createdAt: 2_000 },
    ]);
    expect(ranked.map((m) => m.id)).toEqual(["grok-4.6", "grok-4.7"]);
    // One date missing: the version decides.
    expect(rankNewestFirst("xai", [{ id: "grok-4.6", createdAt: 3_000 }, { id: "grok-4.7" }]).map((m) => m.id))
      .toEqual(["grok-4.7", "grok-4.6"]);
  });

  it("skips a model this account was refused on", () => {
    expect(newestModelId("xai", rows("grok-4.7", "grok-4.6"), new Set(["grok-4.7"]))).toBe("grok-4.6");
  });

  it("falls back to the newest model that is neither the failed one nor refused", () => {
    const list = rows("grok-4.7", "grok-4.6", "grok-4.5");
    // The real case: 4.6 has a zero limit, 4.7 answers.
    expect(fallbackModelId("xai", list, "grok-4.6")).toBe("grok-4.7");
    expect(fallbackModelId("xai", list, "grok-4.7")).toBe("grok-4.6");
    expect(fallbackModelId("xai", list, "grok-4.7", new Set(["grok-4.6"]))).toBe("grok-4.5");
    expect(fallbackModelId("xai", rows("grok-4.7"), "grok-4.7")).toBeNull();
  });

  it("answers null — keep your own rule — for a provider without a policy or a list without a flagship", () => {
    expect(newestModelId("anthropic", rows("claude-opus-5-5"))).toBeNull();
    expect(newestModelId("xai", rows("grok-build-0.1", "grok-4-fast"))).toBeNull();
    expect(rankNewestFirst("openai", rows("b", "a")).map((m) => m.id)).toEqual(["b", "a"]);
  });

  it("derives the cold-start xAI default from the cold-start list by the same rule", () => {
    expect(XAI_DEFAULT_MODEL_ID).toBe(newestModelId("xai", XAI_MODELS));
    expect(XAI_DEFAULT_MODEL_ID).toBe("grok-4.7");
  });
});
