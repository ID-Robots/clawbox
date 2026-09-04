import { describe, expect, it } from "vitest";
import {
  CLAWBOX_AI_MODEL_BY_TIER,
  clawboxAiMaxPickUnconfirmed,
  normalizeAllowedModelIds,
  portalDeniesClawboxAiModel,
} from "@/lib/clawbox-ai-models";

const PORTAL_MAX = ["deepseek-v4-flash", "deepseek-v4-pro", "gpt-5.6-luna"];
const PORTAL_PRO = ["deepseek-v4-flash", "gpt-5.6-luna"];

describe("portalDeniesClawboxAiModel", () => {
  it("refuses a ClawBox AI model the portal left off the list", () => {
    expect(portalDeniesClawboxAiModel(CLAWBOX_AI_MODEL_BY_TIER.pro, PORTAL_PRO)).toBe(true);
  });

  it("allows a model the portal lists, under either provider spelling", () => {
    expect(portalDeniesClawboxAiModel("deepseek/deepseek-v4-pro", PORTAL_MAX)).toBe(false);
    expect(portalDeniesClawboxAiModel("clawai/deepseek-v4-pro", PORTAL_MAX)).toBe(false);
  });

  it("treats an unanswered entitlement as no refusal", () => {
    // The whole point: a portal that did not answer must never move a box off
    // the model its owner chose.
    for (const unknown of [null, undefined, [], "deepseek-v4-flash" as unknown as string[]]) {
      expect(portalDeniesClawboxAiModel(CLAWBOX_AI_MODEL_BY_TIER.pro, unknown)).toBe(false);
    }
  });

  it("never judges a provider the list does not describe", () => {
    // The list is ClawBox AI's. Matching another provider's model against it
    // would refuse every model the owner brought their own key for.
    expect(portalDeniesClawboxAiModel("anthropic/claude-opus-5", PORTAL_PRO)).toBe(false);
    expect(portalDeniesClawboxAiModel("openai/gpt-5.4", PORTAL_PRO)).toBe(false);
  });

  it("ignores a bare id, which names no provider", () => {
    expect(portalDeniesClawboxAiModel("deepseek-v4-pro", PORTAL_PRO)).toBe(false);
  });

  it("compares the bare id, whatever prefix or case either side carries", () => {
    expect(portalDeniesClawboxAiModel("clawai/DeepSeek-V4-Pro", PORTAL_MAX)).toBe(false);
    expect(portalDeniesClawboxAiModel("deepseek/deepseek-v4-pro", ["deepseek/deepseek-v4-pro"]))
      .toBe(false);
  });
});

describe("clawboxAiMaxPickUnconfirmed", () => {
  it("declines the Max pick when nobody answered and the badge is not Max", () => {
    // Portal unreachable, or a token it answers 401/403 to. Letting this
    // through writes the Max model into the box's primary — Telegram and the
    // coding agent run it too — and every turn afterwards fails opaquely.
    for (const unanswered of [null, undefined, []]) {
      expect(clawboxAiMaxPickUnconfirmed(CLAWBOX_AI_MODEL_BY_TIER.pro, unanswered, "flash"))
        .toBe(true);
      expect(clawboxAiMaxPickUnconfirmed(CLAWBOX_AI_MODEL_BY_TIER.pro, unanswered, null))
        .toBe(true);
    }
  });

  it("lets it through the moment either half of the question is answered", () => {
    // A list that names the model is the real answer; the last portal-confirmed
    // Max badge is a weaker one, and both beat declining a paying owner's pick.
    expect(clawboxAiMaxPickUnconfirmed(CLAWBOX_AI_MODEL_BY_TIER.pro, PORTAL_MAX, "flash"))
      .toBe(false);
    expect(clawboxAiMaxPickUnconfirmed(CLAWBOX_AI_MODEL_BY_TIER.pro, null, "pro")).toBe(false);
  });

  it("says nothing about any other model", () => {
    // It is the Max pick alone: the Flash tier and every bring-your-own-key
    // provider are unaffected by a portal that did not answer.
    expect(clawboxAiMaxPickUnconfirmed(CLAWBOX_AI_MODEL_BY_TIER.flash, null, "flash")).toBe(false);
    expect(clawboxAiMaxPickUnconfirmed("anthropic/claude-opus-5", null, "flash")).toBe(false);
    expect(clawboxAiMaxPickUnconfirmed("deepseek-v4-pro", null, "flash")).toBe(false);
  });

  it("is not the refusal the write guard reads", () => {
    // The two predicates deliberately disagree on the unanswered case: the
    // click declines, the boot guard (which WRITES) does not.
    expect(portalDeniesClawboxAiModel(CLAWBOX_AI_MODEL_BY_TIER.pro, null)).toBe(false);
    expect(clawboxAiMaxPickUnconfirmed(CLAWBOX_AI_MODEL_BY_TIER.pro, null, "flash")).toBe(true);
  });
});

describe("normalizeAllowedModelIds", () => {
  it("keeps a real list, trimmed", () => {
    expect(normalizeAllowedModelIds([" deepseek-v4-pro ", "deepseek-v4-flash"]))
      .toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
  });

  it("answers null for everything that is not one", () => {
    // null and [] are the same answer downstream — "not answered" — and this
    // is the one place that rule is written, for the server and the client.
    for (const value of [undefined, null, [], ["", "  "], "deepseek-v4-pro", 7, {}]) {
      expect(normalizeAllowedModelIds(value)).toBeNull();
    }
  });

  it("drops non-string entries rather than the whole list", () => {
    expect(normalizeAllowedModelIds(["deepseek-v4-pro", 1, null])).toEqual(["deepseek-v4-pro"]);
  });
});
