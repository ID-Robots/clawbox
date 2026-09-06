import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translations } from "@/lib/translations";
import type { Locale } from "@/lib/i18n";
import {
  CLAWBOX_AI_MAX_TIER_REASONING_CONFIG,
  isClawboxAiMaxTierModel,
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
      for (const cfg of [...Object.values(REASONING_BY_PROVIDER), CLAWBOX_AI_MAX_TIER_REASONING_CONFIG]) {
        expect(cfg.levels.length).toBeGreaterThan(0);
        expect(cfg.levels).toContain(cfg.default);
        for (const level of cfg.levels) {
          expect(THINKING_LEVEL_LABELS[level]).toBeTruthy();
        }
      }
    });
  });

  describe("ClawBox AI Max tier (DeepSeek V4 Pro)", () => {
    const PRO = "deepseek/deepseek-v4-pro";
    const FLASH = "deepseek/deepseek-v4-flash";

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("recognises the Max-tier model under either ClawBox AI provider id, qualified or bare", () => {
      expect(isClawboxAiMaxTierModel("clawai", PRO)).toBe(true);
      expect(isClawboxAiMaxTierModel("deepseek", PRO)).toBe(true);
      expect(isClawboxAiMaxTierModel("clawai", "clawai/deepseek-v4-pro")).toBe(true);
      expect(isClawboxAiMaxTierModel("clawai", "deepseek-v4-pro")).toBe(true);
      expect(isClawboxAiMaxTierModel("clawai", FLASH)).toBe(false);
      expect(isClawboxAiMaxTierModel("clawai", null)).toBe(false);
      expect(isClawboxAiMaxTierModel(null, PRO)).toBe(false);
      // The model id alone is not enough — it has to be ClawBox AI serving it.
      expect(isClawboxAiMaxTierModel("openrouter", PRO)).toBe(false);
      expect(isClawboxAiMaxTierModel("llamacpp", PRO)).toBe(false);
    });

    it("reasons by default (medium) on the Max-tier model", () => {
      expect(getProviderReasoningConfig("clawai", PRO)).toBe(CLAWBOX_AI_MAX_TIER_REASONING_CONFIG);
      expect(getProviderReasoningConfig("deepseek", PRO).default).toBe("medium");
      expect(getProviderReasoningConfig("clawai", "deepseek-v4-pro").default).toBe("medium");
    });

    it("keeps Flash (Free / Pro plans) fast-by-default, and provider-only callers unchanged", () => {
      expect(getProviderReasoningConfig("clawai", FLASH).default).toBe("off");
      expect(getProviderReasoningConfig("deepseek", FLASH).default).toBe("off");
      expect(getProviderReasoningConfig("clawai", null).default).toBe("off");
      expect(getProviderReasoningConfig("clawai", undefined)).toBe(REASONING_BY_PROVIDER.clawai);
      expect(getProviderReasoningConfig("clawai")).toBe(REASONING_BY_PROVIDER.clawai);
    });

    it("offers the same uniform ladder on the Max tier — only the starting point moves", () => {
      expect(getProviderReasoningConfig("clawai", PRO).levels).toEqual(["off", "low", "medium", "high"]);
      expect(getProviderReasoningConfig("clawai", PRO).levels).toEqual(getProviderReasoningConfig("clawai", FLASH).levels);
    });

    it("leaves other providers alone even when handed the Max-tier model id", () => {
      expect(getProviderReasoningConfig("llamacpp", PRO)).toBe(REASONING_BY_PROVIDER.llamacpp);
      expect(getProviderReasoningConfig("openrouter", PRO)).toBe(REASONING_BY_PROVIDER.openrouter);
      expect(getProviderReasoningConfig("bogus", PRO)).toBe(FALLBACK_REASONING_CONFIG);
    });

    it("starts at medium when the user has never touched the picker", () => {
      vi.stubGlobal("window", { localStorage: { getItem: () => null } });
      expect(readPersistedThinkingLevel("clawai", getProviderReasoningConfig("clawai", PRO))).toBe("medium");
      expect(readPersistedThinkingLevel("clawai", getProviderReasoningConfig("clawai", FLASH))).toBe("off");
    });

    it("honours a level the user picked themselves over the tier default", () => {
      const store: Record<string, string> = { "clawbox:chat:thinkingLevel:clawai": "off" };
      vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store[k] ?? null } });
      expect(readPersistedThinkingLevel("clawai", getProviderReasoningConfig("clawai", PRO))).toBe("off");
      store["clawbox:chat:thinkingLevel:clawai"] = "high";
      expect(readPersistedThinkingLevel("clawai", getProviderReasoningConfig("clawai", FLASH))).toBe("high");
    });

    it("clamps an unsupported wire level to the tier's own default", () => {
      expect(resolveWireThinkingLevel("clawai", "xhigh", PRO)).toBe("medium");
      expect(resolveWireThinkingLevel("clawai", "xhigh", FLASH)).toBe("off");
      expect(resolveWireThinkingLevel("clawai", "xhigh")).toBe("off");
      // Supported levels pass through on both tiers.
      expect(resolveWireThinkingLevel("clawai", "off", PRO)).toBe("off");
      expect(resolveWireThinkingLevel("clawai", "high", PRO)).toBe("high");
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
  /**
   * THINKING_LEVEL_LABELS is the GATEWAY's vocabulary — the English words the
   * wire uses — and the chat pill is a control on a desktop that may be in any
   * of ten languages. The pill therefore words each level through the
   * catalogue and keeps this table only as the floor for a level the catalogue
   * does not know. Both halves are pinned here: a level added to this module
   * with no catalogue entry would silently put an English word in a German
   * menu, which is exactly how the picker read before.
   */
  describe("the levels the picker offers are worded in the owner's language", () => {
    const LOCALES = Object.keys(translations) as Locale[];
    const NON_EN = LOCALES.filter((l) => l !== "en");
    const chat = fs.readFileSync(
      path.join(process.cwd(), "src/components/ChatPopup.tsx"),
      "utf-8",
    );

    it("covers all ten languages", () => {
      expect(LOCALES.length).toBe(10);
    });

    it("has a catalogue key for every level on the wire", () => {
      for (const level of Object.keys(THINKING_LEVEL_LABELS)) {
        for (const locale of LOCALES) {
          const value = translations[locale][`chat.effort.${level}`];
          expect(value, `${locale} has no word for "${level}"`).toBeTruthy();
        }
      }
    });

    it("says them in each language, not in English", () => {
      // The uniform ladder — what every cloud provider's picker actually shows.
      for (const level of FALLBACK_REASONING_CONFIG.levels) {
        for (const locale of NON_EN) {
          const key = `chat.effort.${level}`;
          expect(
            translations[locale][key],
            `${locale} still shows the English "${translations.en[key]}"`,
          ).not.toBe(translations.en[key]);
        }
      }
    });

    it("is read through the catalogue by the pill, with the wire word as the floor", () => {
      expect(chat).toMatch(/tr\(`chat\.effort\.\$\{level\}`, THINKING_LEVEL_LABELS\[level\] \?\? level\)/);
      expect(chat).toMatch(
        /triggerLabel=\{tr\(`chat\.effort\.\$\{effectiveThinkingLevel\}`/,
      );
    });
  });
});
