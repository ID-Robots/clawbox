import { describe, expect, it } from "vitest";
import {
  getProviderReasoningConfig,
  readPersistedThinkingLevel,
  REASONING_BY_PROVIDER,
  FALLBACK_REASONING_CONFIG,
  THINKING_LEVEL_LABELS,
} from "@/lib/chat-reasoning";

describe("chat-reasoning", () => {
  describe("getProviderReasoningConfig", () => {
    it("returns off-only for local Gemma (llamacpp) so the header hides the picker", () => {
      const cfg = getProviderReasoningConfig("llamacpp");
      // Gemma exposes no reasoning-effort control; the gateway rejects any
      // thinkingLevel other than `off`. Off-only (length 1) is what makes the
      // chat header drop the effort dropdown instead of erroring on select.
      expect(cfg.levels).toEqual(["off"]);
      expect(cfg.default).toBe("off");
      expect(cfg.levels.length).toBe(1);
    });

    it("returns the upstream-accurate set for cloud providers", () => {
      expect(getProviderReasoningConfig("openai").levels).toContain("xhigh");
      expect(getProviderReasoningConfig("deepseek")).toEqual({
        levels: ["off", "high", "xhigh"],
        default: "off",
      });
      expect(getProviderReasoningConfig("clawai")).toEqual({
        levels: ["off", "high", "xhigh"],
        default: "off",
      });
      expect(getProviderReasoningConfig("anthropic").levels).toEqual([
        "low",
        "medium",
        "high",
        "max",
      ]);
      expect(getProviderReasoningConfig("google").default).toBe("adaptive");
    });

    it("falls back for unknown or empty providers", () => {
      expect(getProviderReasoningConfig("ollama")).toBe(FALLBACK_REASONING_CONFIG);
      expect(getProviderReasoningConfig(null)).toBe(FALLBACK_REASONING_CONFIG);
      expect(getProviderReasoningConfig(undefined)).toBe(FALLBACK_REASONING_CONFIG);
      expect(getProviderReasoningConfig("")).toBe(FALLBACK_REASONING_CONFIG);
    });

    it("keeps every config self-consistent (labelled levels, default in range)", () => {
      for (const cfg of Object.values(REASONING_BY_PROVIDER)) {
        expect(cfg.levels.length).toBeGreaterThan(0);
        expect(cfg.levels).toContain(cfg.default);
        for (const level of cfg.levels) {
          expect(THINKING_LEVEL_LABELS[level]).toBeTruthy();
        }
      }
    });
  });

  describe("readPersistedThinkingLevel", () => {
    it("returns the provider default when no choice is persisted", () => {
      const cfg = getProviderReasoningConfig("llamacpp");
      expect(readPersistedThinkingLevel("llamacpp", cfg)).toBe("off");
    });

    it("returns the default when the provider is missing", () => {
      const cfg = getProviderReasoningConfig("openai");
      expect(readPersistedThinkingLevel(null, cfg)).toBe(cfg.default);
    });
  });
});
