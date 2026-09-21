import { describe, expect, it } from "vitest";
import {
  CLAWBOX_AI_IMAGE_MODEL,
  CLAWBOX_AI_LEGACY_IMAGE_MODEL,
  clawboxAiNonChatModelReason,
  isClawboxAiImageModelRef,
  isClawboxAiImageProviderRef,
  isClawboxAiNonChatModelRef,
} from "@/lib/clawbox-ai-models";

/**
 * H1 of the 2026-09-17 review: the `openai` → `litellm` image move did not close
 * the chat-picker exposure it claimed to, it moved it onto a provider id
 * ClawBox's refusals did not cover.
 *
 * Verified in the core at v2026.9.3. `extensions/litellm/index.ts` does both
 * registrations from one `register()` — `api.registerProvider({ id: "litellm",
 * catalog: …, staticCatalog: … })` and `api.registerImageGenerationProvider(…)`
 * — and `extensions/litellm/onboard.ts` declares the chat row the static
 * catalog ships: `{ id: "claude-opus-4-6", name: "Claude Opus 4.6", reasoning:
 * true, contextWindow: 1_000_000 }`. Its bearer is
 * `ctx.resolveProviderApiKey("litellm")`, which is the `claw_` portal token this
 * build writes at `models.providers.litellm.apiKey`. So the core's own pickers
 * offer `litellm/*` as a chat model whatever ClawBox writes.
 *
 * The residual on OpenClaw's own surfaces stays open (recorded as a harness
 * finding in clawbox-ai-models.ts, not yet confirmed on a box). What this pins
 * is ClawBox's half: the refusal is by PROVIDER ID for the image lane's id, and
 * still by exact ref for the legacy one, which is a real chat provider.
 */
describe("what ClawBox refuses to write into a chat slot", () => {
  const CHAT_ROW_THE_PLUGIN_SHIPS = "litellm/claude-opus-4-6";

  it("refuses every model on the image lane's provider id", () => {
    for (const ref of [
      CHAT_ROW_THE_PLUGIN_SHIPS,
      "litellm/gpt-image-1-mini",
      // Whatever live discovery registers from `<baseUrl>/v1/models`.
      "litellm/anything-discovery-returned",
      "LiteLLM/Claude-Opus-4-6",
      "  litellm/claude-opus-4-6  ",
    ]) {
      expect(isClawboxAiNonChatModelRef(ref)).toBe(true);
      expect(isClawboxAiImageProviderRef(ref)).toBe(true);
    }
  });

  it("still refuses the LEGACY image ref, which a box carries until its migration runs", () => {
    expect(isClawboxAiNonChatModelRef(CLAWBOX_AI_LEGACY_IMAGE_MODEL)).toBe(true);
    expect(isClawboxAiNonChatModelRef(CLAWBOX_AI_IMAGE_MODEL)).toBe(true);
  });

  it("does not take the legacy provider's chat models with it", () => {
    // `openai` hosts the image entry on every box provisioned before the move
    // AND every OpenAI chat model. Refusing it by provider would take the
    // owner's own GPT models away.
    for (const ref of ["openai/gpt-5.5", "openai/gpt-5.4-mini", "anthropic/claude-opus-5"]) {
      expect(isClawboxAiNonChatModelRef(ref)).toBe(false);
      expect(isClawboxAiImageProviderRef(ref)).toBe(false);
    }
  });

  it("keeps the CLAIM predicate narrow — a migration may only move its own write", () => {
    // `isClawboxAiImageModelRef` answers "is this slot ours to move". Widening
    // it would let the boot migration claim a `litellm/*` entry the owner
    // configured themselves.
    expect(isClawboxAiImageModelRef(CHAT_ROW_THE_PLUGIN_SHIPS)).toBe(false);
    expect(isClawboxAiImageModelRef(CLAWBOX_AI_IMAGE_MODEL)).toBe(true);
    expect(isClawboxAiImageModelRef(CLAWBOX_AI_LEGACY_IMAGE_MODEL)).toBe(true);
  });

  it("is not a prefix test — the bare provider id is not a model ref", () => {
    expect(isClawboxAiImageProviderRef("litellm")).toBe(false);
    expect(isClawboxAiImageProviderRef("litellm/")).toBe(false);
    expect(isClawboxAiImageProviderRef("litellmx/model")).toBe(false);
    expect(isClawboxAiImageProviderRef(undefined)).toBe(false);
    expect(isClawboxAiNonChatModelRef(null)).toBe(false);
  });

  it("words the two refusals apart", () => {
    expect(clawboxAiNonChatModelReason(CLAWBOX_AI_IMAGE_MODEL)).toContain("image model");
    expect(clawboxAiNonChatModelReason(CLAWBOX_AI_LEGACY_IMAGE_MODEL)).toContain("image model");
    const other = clawboxAiNonChatModelReason(CHAT_ROW_THE_PLUGIN_SHIPS);
    expect(other).toContain("image provider");
    expect(other).not.toContain("image model");
  });
});
