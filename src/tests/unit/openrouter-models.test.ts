import { describe, expect, it } from "vitest";
import {
  OPENROUTER_CURATED_MODELS,
  OPENROUTER_DEFAULT_MODEL_ID,
  extractOpenRouterSlug,
  isValidOpenRouterModelId,
} from "@/lib/openrouter-models";

describe("openrouter-models", () => {
  describe("OPENROUTER_CURATED_MODELS", () => {
    it("includes the default model id", () => {
      const ids = OPENROUTER_CURATED_MODELS.map((option) => option.id);
      expect(ids).toContain(OPENROUTER_DEFAULT_MODEL_ID);
    });

    it("has no duplicate ids", () => {
      const ids = OPENROUTER_CURATED_MODELS.map((option) => option.id);
      expect(ids.length).toBe(new Set(ids).size);
    });

    it("every entry passes the slug validator", () => {
      for (const option of OPENROUTER_CURATED_MODELS) {
        expect(isValidOpenRouterModelId(option.id)).toBe(true);
      }
    });
  });

  describe("isValidOpenRouterModelId", () => {
    it.each([
      "anthropic/claude-haiku-4-5",
      "openai/gpt-5-mini",
      "moonshotai/kimi-k2-0905",
      "meta-llama/llama-3.3-70b-instruct",
      "x-ai/grok-4-1-fast",
      "deepseek/deepseek-chat-v3",
    ])("accepts valid slug %s", (slug) => {
      expect(isValidOpenRouterModelId(slug)).toBe(true);
    });

    it.each([
      "",
      "   ",
      "anthropic",
      "/claude",
      "anthropic/",
      "anthropic//claude",
    ])("rejects invalid slug %s", (slug) => {
      expect(isValidOpenRouterModelId(slug)).toBe(false);
    });

    it("tolerates surrounding whitespace", () => {
      expect(isValidOpenRouterModelId("  anthropic/claude-haiku-4-5  ")).toBe(true);
    });
  });

  describe("extractOpenRouterSlug", () => {
    it("extracts the slug from a fully-qualified openrouter model", () => {
      expect(extractOpenRouterSlug("openrouter/anthropic/claude-haiku-4-5")).toBe(
        "anthropic/claude-haiku-4-5",
      );
    });

    it("returns null for non-openrouter models", () => {
      expect(extractOpenRouterSlug("anthropic/claude-sonnet-4-6")).toBeNull();
      expect(extractOpenRouterSlug("ollama/llama3.2:3b")).toBeNull();
    });

    it("returns null for malformed inputs", () => {
      expect(extractOpenRouterSlug(null)).toBeNull();
      expect(extractOpenRouterSlug(undefined)).toBeNull();
      expect(extractOpenRouterSlug("")).toBeNull();
      expect(extractOpenRouterSlug("openrouter/")).toBeNull();
    });
  });
});
