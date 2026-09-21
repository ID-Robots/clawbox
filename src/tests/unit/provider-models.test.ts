import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDER_CATALOGS,
  fetchProviderCatalog,
  getProviderCatalog,
  isNonChatModelId,
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
      // Codex (ChatGPT auth) starts on the newest model every tier can run.
      expect(getProviderCatalog("codex")?.defaultModelId).toBe("gpt-5.5");
    });

    // The cold-start default only decides what a box lands on before it has
    // enumerated anything — `openclaw models list` tags one row `default` per
    // provider and that tag wins (catalog/route.ts) — but it is what
    // "Make default -> Anthropic" writes on a box whose Anthropic row has no
    // model of its own, and it was still the placeholder Sonnet id.
    it("lands the Anthropic cold-start default on Claude Opus 5", () => {
      const catalog = getProviderCatalog("anthropic");
      expect(catalog?.defaultModelId).toBe("claude-opus-5");
      // A default the curated list does not carry is a default the picker
      // cannot render, so the two are asserted together.
      expect(catalog?.models.map((m) => m.id)).toContain("claude-opus-5");
      // Exactly one row may claim the "Default." hint, and it is that one: two
      // rows hinted Default is what a hand-edited list drifts into.
      expect(
        (catalog?.models ?? []).filter((m) => m.hint?.startsWith("Default")).map((m) => m.id),
      ).toEqual(["claude-opus-5"]);
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

  describe("isNonChatModelId", () => {
    // Moved here from the catalog route so the second catalogue surface can
    // share it. The OpenRouter case is the one that was broken: the pattern is
    // anchored, and OpenRouter ids keep their `<org>/<model>` slug, so matching
    // it against the whole id made the exclusion silently inert for the largest
    // catalogue we serve.
    it("matches an image SKU behind an OpenRouter org slug", () => {
      expect(isNonChatModelId("openai/gpt-image-1-mini")).toBe(true);
      expect(isNonChatModelId("gpt-image-1-mini")).toBe(true);
    });

    it("matches the suffix families, wherever the suffix ends", () => {
      expect(isNonChatModelId("gpt-4o-audio-preview")).toBe(true);
      expect(isNonChatModelId("gpt-4o-transcribe")).toBe(true);
      expect(isNonChatModelId("gpt-4o-mini-tts")).toBe(true);
    });

    it("keeps every chat model, including generations we have never seen", () => {
      expect(isNonChatModelId("openai/gpt-5.6-sol")).toBe(false);
      expect(isNonChatModelId("anthropic/claude-opus-5")).toBe(false);
      // A modality exclusion must never become a generation allowlist: an id
      // this list does not recognise is a chat model until proven otherwise.
      expect(isNonChatModelId("openai/gpt-7-hypothetical")).toBe(false);
    });
  });

  describe("fetchProviderCatalog", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Answer every catalog GET with `body`. */
    function mockRoute(body: unknown): void {
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: true,
        json: async () => body,
      })));
    }

    it("carries `warming` through an empty catalogue, so the picker keeps asking", async () => {
      // Reachable on an upgraded box: the route serves a cached payload whose
      // rows its current sanitiser filters away entirely, with `warming: true`
      // because the re-enumeration it just started is genuinely in flight.
      mockRoute({ provider: "anthropic", models: [], warming: true });

      const resolved = await fetchProviderCatalog("anthropic");

      // The curated rows are rendered — a blank picker helps nobody — and they
      // say what they are.
      expect(resolved.fallback).toBe(true);
      expect(resolved.models.length).toBeGreaterThan(0);
      // And `warming` survives, because it is the only field
      // `useProviderCatalog` polls on. Dropping it stopped the retry loop on
      // exactly the box that was seconds away from a real answer.
      expect(resolved.warming).toBe(true);
    });

    it("does not invent `warming` for an empty catalogue nobody is enumerating", async () => {
      // A provider under the route's failed-refresh backoff: no fork is out
      // there, so polling it would be a request loop with no destination.
      mockRoute({ provider: "anthropic", models: [] });

      const resolved = await fetchProviderCatalog("anthropic");

      expect(resolved.fallback).toBe(true);
      expect(resolved.warming).toBeUndefined();
    });

    it("marks a payload the route did not stamp `source: \"live\"` as a fallback", async () => {
      mockRoute({
        provider: "anthropic",
        models: [{ id: "claude-opus-5", label: "Claude Opus 5", contextWindow: 1_000_000 }],
        defaultModelId: "claude-opus-5",
      });

      expect((await fetchProviderCatalog("anthropic")).fallback).toBe(true);

      mockRoute({
        provider: "anthropic",
        models: [{ id: "claude-opus-5", label: "Claude Opus 5", contextWindow: 1_000_000 }],
        defaultModelId: "claude-opus-5",
        source: "live",
      });

      expect((await fetchProviderCatalog("anthropic")).fallback).toBeUndefined();
    });
  });
});
