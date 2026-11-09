import { describe, expect, it } from "vitest";
import {
  CLAWBOX_AI_CHAT_MODEL,
  normalizeAllowedModelIds,
  portalDeniesClawboxAiModel,
} from "@/lib/clawbox-ai-models";

// A list carrying a model this account is entitled to beyond the one ClawBox
// AI offers, and one without it: the helper is generic over whatever the
// portal publishes.
const PORTAL_WIDE = ["deepseek-v4-flash", "deepseek-v5"];
const PORTAL_NARROW = ["deepseek-v4-flash"];
const UNLISTED = "deepseek/deepseek-v5";

describe("portalDeniesClawboxAiModel", () => {
  it("refuses a ClawBox AI model the portal left off the list", () => {
    expect(portalDeniesClawboxAiModel(UNLISTED, PORTAL_NARROW)).toBe(true);
  });

  it("allows a model the portal lists, under either provider spelling", () => {
    expect(portalDeniesClawboxAiModel(CLAWBOX_AI_CHAT_MODEL, PORTAL_NARROW)).toBe(false);
    expect(portalDeniesClawboxAiModel("clawai/deepseek-v4-flash", PORTAL_NARROW)).toBe(false);
    expect(portalDeniesClawboxAiModel(UNLISTED, PORTAL_WIDE)).toBe(false);
  });

  it("treats an unanswered entitlement as no refusal", () => {
    // The whole point: a portal that did not answer must never move a box off
    // the model its owner chose.
    for (const unknown of [null, undefined, [], "deepseek-v4-flash" as unknown as string[]]) {
      expect(portalDeniesClawboxAiModel(UNLISTED, unknown)).toBe(false);
    }
  });

  it("never judges a provider the list does not describe", () => {
    // The list is ClawBox AI's. Matching another provider's model against it
    // would refuse every model the owner brought their own key for.
    expect(portalDeniesClawboxAiModel("anthropic/claude-opus-5", PORTAL_NARROW)).toBe(false);
    expect(portalDeniesClawboxAiModel("openai/gpt-5.4", PORTAL_NARROW)).toBe(false);
  });

  it("ignores a bare id, which names no provider", () => {
    expect(portalDeniesClawboxAiModel("deepseek-v5", PORTAL_NARROW)).toBe(false);
  });

  it("compares the bare id, whatever prefix or case either side carries", () => {
    expect(portalDeniesClawboxAiModel("clawai/DeepSeek-V4-Flash", PORTAL_NARROW)).toBe(false);
    expect(portalDeniesClawboxAiModel(CLAWBOX_AI_CHAT_MODEL, [CLAWBOX_AI_CHAT_MODEL]))
      .toBe(false);
  });
});

describe("normalizeAllowedModelIds", () => {
  it("keeps a real list, trimmed", () => {
    expect(normalizeAllowedModelIds([" deepseek-v5 ", "deepseek-v4-flash"]))
      .toEqual(["deepseek-v5", "deepseek-v4-flash"]);
  });

  it("answers null for everything that is not one", () => {
    // null and [] are the same answer downstream — "not answered" — and this
    // is the one place that rule is written, for the server and the client.
    for (const value of [undefined, null, [], ["", "  "], "deepseek-v4-flash", 7, {}]) {
      expect(normalizeAllowedModelIds(value)).toBeNull();
    }
  });

  it("drops non-string entries rather than the whole list", () => {
    expect(normalizeAllowedModelIds(["deepseek-v4-flash", 1, null])).toEqual(["deepseek-v4-flash"]);
  });
});
