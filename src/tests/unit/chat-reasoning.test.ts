import { describe, expect, it } from "vitest";
import {
  getProviderReasoningConfig,
  readPersistedThinkingLevel,
  resolveWireThinkingLevel,
  parseUnsupportedThinkingLevelError,
  isThinkingLevel,
  REASONING_BY_PROVIDER,
  FALLBACK_REASONING_CONFIG,
  THINKING_LEVEL_LABELS,
  SAFE_THINKING_LEVEL,
  type ThinkingLevel,
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

    it("exposes a uniform off/low/medium/high ladder for every cloud provider", () => {
      const uniform = ["off", "low", "medium", "high"];
      for (const provider of ["openai", "codex", "anthropic", "google", "deepseek", "clawai", "openrouter"]) {
        expect(getProviderReasoningConfig(provider).levels).toEqual(uniform);
      }
    });

    it("keeps ClawBox AI / DeepSeek fast-by-default (off) while cloud providers default to medium", () => {
      expect(getProviderReasoningConfig("deepseek").default).toBe("off");
      expect(getProviderReasoningConfig("clawai").default).toBe("off");
      expect(getProviderReasoningConfig("codex").default).toBe("medium");
      expect(getProviderReasoningConfig("openai").default).toBe("medium");
      expect(getProviderReasoningConfig("anthropic").default).toBe("medium");
      expect(getProviderReasoningConfig("google").default).toBe("medium");
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

  describe("SAFE_THINKING_LEVEL", () => {
    it("is `off` and is a member of every provider config's levels", () => {
      expect(SAFE_THINKING_LEVEL).toBe("off");
      for (const cfg of Object.values(REASONING_BY_PROVIDER)) {
        expect(cfg.levels).toContain(SAFE_THINKING_LEVEL);
      }
      expect(FALLBACK_REASONING_CONFIG.levels).toContain(SAFE_THINKING_LEVEL);
    });
  });

  describe("resolveWireThinkingLevel", () => {
    it("passes a supported level through unchanged", () => {
      expect(resolveWireThinkingLevel("anthropic", "high")).toBe("high");
      expect(resolveWireThinkingLevel("clawai", "off")).toBe("off");
    });

    it("clamps an unsupported level to the provider default", () => {
      // Local Gemma (llamacpp) supports `off` only.
      expect(resolveWireThinkingLevel("llamacpp", "high")).toBe("off");
      expect(resolveWireThinkingLevel("llamacpp", "medium")).toBe("off");
    });

    it("holds (returns null) while the active provider is still unknown", () => {
      // Catalog still loading: the caller must not push a speculative value.
      expect(resolveWireThinkingLevel(null, "high")).toBeNull();
      expect(resolveWireThinkingLevel(undefined, "high")).toBeNull();
      expect(resolveWireThinkingLevel("", "high")).toBeNull();
    });

    // The exact production bug: a `high` chosen while a reasoning-capable
    // remote model (DeepSeek → normalized `clawai`) was active, then the user
    // switches the picker to the local llama.cpp Gemma model. The stale `high`
    // must never reach the gateway for the local model.
    it("folds a stale `high` to `off` across a remote→local model switch", () => {
      // Before the switch: clawai honours `high`.
      expect(resolveWireThinkingLevel("clawai", "high")).toBe("high");

      // After the switch to local Gemma, both the state-snap path and the
      // wire-clamp path independently yield `off` — so even if the header
      // state lags a render behind, the wire value is already safe.
      const localCfg = getProviderReasoningConfig("llamacpp");
      const snapped = readPersistedThinkingLevel("llamacpp", localCfg); // no persisted choice
      expect(snapped).toBe("off");
      expect(resolveWireThinkingLevel("llamacpp", "high")).toBe("off");
    });

    it("never returns a level the resolved provider rejects", () => {
      const providers = [
        "openai", "codex", "anthropic", "google",
        "deepseek", "clawai", "openrouter", "llamacpp",
      ];
      const desired: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "adaptive"];
      for (const provider of providers) {
        const cfg = getProviderReasoningConfig(provider);
        for (const level of desired) {
          const resolved = resolveWireThinkingLevel(provider, level);
          expect(resolved).not.toBeNull();
          expect(cfg.levels).toContain(resolved as ThinkingLevel);
        }
      }
    });
  });

  describe("parseUnsupportedThinkingLevelError", () => {
    it("parses the gateway's `(use off)` hint from the real rejection message", () => {
      const msg = 'thinkingLevel "high" is not supported for llamacpp/gemma4-e2b-it-q4_0 (use off)';
      expect(parseUnsupportedThinkingLevelError(msg)).toBe("off");
    });

    it("honours whatever level the gateway suggests, not just off", () => {
      const msg = 'thinkingLevel "xhigh" is not supported for some/model (use low)';
      expect(parseUnsupportedThinkingLevelError(msg)).toBe("low");
    });

    it("is tolerant of casing and spacing around the hint", () => {
      expect(
        parseUnsupportedThinkingLevelError('ThinkingLevel "high" is NOT SUPPORTED for x/y ( use  off )'),
      ).toBe("off");
    });

    it("returns null for unrelated errors so they keep normal handling", () => {
      expect(parseUnsupportedThinkingLevelError("Request timeout")).toBeNull();
      expect(parseUnsupportedThinkingLevelError("session not found")).toBeNull();
      // Right shape but an unknown suggested level → don't invent one.
      expect(
        parseUnsupportedThinkingLevelError('thinkingLevel "high" is not supported for x/y (use bogus)'),
      ).toBeNull();
      expect(parseUnsupportedThinkingLevelError(null)).toBeNull();
      expect(parseUnsupportedThinkingLevelError(undefined)).toBeNull();
    });
  });

  describe("isThinkingLevel", () => {
    it("accepts every labelled level and rejects anything else", () => {
      for (const level of Object.keys(THINKING_LEVEL_LABELS)) {
        expect(isThinkingLevel(level)).toBe(true);
      }
      expect(isThinkingLevel("ultra")).toBe(false);
      expect(isThinkingLevel("")).toBe(false);
      expect(isThinkingLevel(null)).toBe(false);
      expect(isThinkingLevel(3)).toBe(false);
    });
  });
});
