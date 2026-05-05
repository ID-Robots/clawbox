import { describe, expect, it } from "vitest";
import {
  PROVIDER_CATALOGS,
  getProviderCatalog,
  isValidModelId,
  parseModelSlug,
} from "@/lib/provider-models";

describe("provider-models", () => {
  describe("PROVIDER_CATALOGS", () => {
    it("is frozen at runtime", () => {
      expect(Object.isFrozen(PROVIDER_CATALOGS)).toBe(true);
    });
  });

  describe("getProviderCatalog", () => {
    it("returns configured provider catalogs", () => {
      expect(getProviderCatalog("openai")?.defaultModelId).toBe("gpt-5.4");
      expect(getProviderCatalog("openai-codex")?.defaultModelId).toBe("gpt-5.4");
    });

    it("does not return inherited Object prototype members", () => {
      expect(getProviderCatalog("toString")).toBeNull();
      expect(getProviderCatalog("constructor")).toBeNull();
    });

    it("returns null for empty inputs and unknown providers", () => {
      expect(getProviderCatalog(null)).toBeNull();
      expect(getProviderCatalog(undefined)).toBeNull();
      expect(getProviderCatalog("")).toBeNull();
      expect(getProviderCatalog("not-a-provider")).toBeNull();
    });
  });

  describe("parseModelSlug", () => {
    it("splits the provider from the remaining model id", () => {
      expect(parseModelSlug("openrouter/anthropic/claude-haiku-4.5")).toEqual({
        provider: "openrouter",
        modelId: "anthropic/claude-haiku-4.5",
      });
    });

    it("rejects malformed model slugs", () => {
      expect(parseModelSlug("")).toBeNull();
      expect(parseModelSlug("openai")).toBeNull();
      expect(parseModelSlug("/gpt-5")).toBeNull();
      expect(parseModelSlug("openai/")).toBeNull();
    });
  });

  describe("isValidModelId", () => {
    it("uses provider-specific validation", () => {
      expect(isValidModelId("openai", "gpt-5")).toBe(true);
      expect(isValidModelId("openai", "openai/gpt-5")).toBe(false);
      expect(isValidModelId("openrouter", "anthropic/claude-haiku-4.5")).toBe(true);
      expect(isValidModelId("openrouter", "anthropic/claude/")).toBe(false);
    });
  });
});
