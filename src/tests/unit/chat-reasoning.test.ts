import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translations } from "@/lib/translations";
import type { Locale } from "@/lib/i18n";
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

    it("defaults ClawBox AI — both spellings — and every cloud provider to medium", () => {
      // The owner's ruling of 2026-09-15: a fresh ClawBox AI session thinks at
      // Medium. `deepseek` is the gateway's spelling of the same provider.
      expect(getProviderReasoningConfig("deepseek").default).toBe("medium");
      expect(getProviderReasoningConfig("clawai").default).toBe("medium");
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

  describe("ClawBox AI legacy aliases serving Flash 4.1", () => {
    const PRO = "deepseek/deepseek-v4-pro";
    const FLASH = "deepseek/deepseek-v4-flash";

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.each(["clawai", "deepseek"])("defaults both legacy aliases to medium under %s", (provider) => {
      for (const model of [PRO, FLASH, "clawai/deepseek-v4-pro", "clawai/deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash"]) {
        expect(getProviderReasoningConfig(provider, model).default).toBe("medium");
      }
    });

    it("keeps provider-only callers at the same medium default", () => {
      expect(getProviderReasoningConfig("clawai", FLASH).default).toBe("medium");
      expect(getProviderReasoningConfig("deepseek", FLASH).default).toBe("medium");
      expect(getProviderReasoningConfig("clawai", null).default).toBe("medium");
      expect(getProviderReasoningConfig("clawai", undefined)).toBe(REASONING_BY_PROVIDER.clawai);
      expect(getProviderReasoningConfig("clawai")).toBe(REASONING_BY_PROVIDER.clawai);
    });

    it("offers the same uniform ladder on both legacy aliases", () => {
      expect(getProviderReasoningConfig("clawai", PRO).levels).toEqual(["off", "low", "medium", "high"]);
      expect(getProviderReasoningConfig("clawai", PRO).levels).toEqual(getProviderReasoningConfig("clawai", FLASH).levels);
    });

    it("leaves other providers alone even when handed a legacy ClawBox AI model id", () => {
      expect(getProviderReasoningConfig("llamacpp", PRO)).toBe(REASONING_BY_PROVIDER.llamacpp);
      expect(getProviderReasoningConfig("openrouter", PRO)).toBe(REASONING_BY_PROVIDER.openrouter);
      expect(getProviderReasoningConfig("bogus", PRO)).toBe(FALLBACK_REASONING_CONFIG);
    });

    it("starts both legacy aliases at medium when the user has never touched the picker", () => {
      vi.stubGlobal("window", { localStorage: { getItem: () => null } });
      expect(readPersistedThinkingLevel("clawai", getProviderReasoningConfig("clawai", PRO))).toBe("medium");
      expect(readPersistedThinkingLevel("clawai", getProviderReasoningConfig("clawai", FLASH))).toBe("medium");
    });

    it.each(["clawai", "deepseek"])("honours a saved %s level with either legacy model alias", (provider) => {
      const key = `clawbox:chat:thinkingLevel:${provider}`;
      const store: Record<string, string> = { [key]: "off" };
      vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store[k] ?? null } });
      expect(readPersistedThinkingLevel(provider, getProviderReasoningConfig(provider, PRO))).toBe("off");
      store[key] = "high";
      expect(readPersistedThinkingLevel(provider, getProviderReasoningConfig(provider, PRO))).toBe("high");
      expect(readPersistedThinkingLevel(provider, getProviderReasoningConfig(provider, FLASH))).toBe("high");
    });

    it("clamps an unsupported wire level to the medium default for both legacy aliases", () => {
      // A stale `xhigh` from the old picker lands on the default, not on off.
      expect(resolveWireThinkingLevel("clawai", "xhigh", PRO)).toBe("medium");
      expect(resolveWireThinkingLevel("clawai", "xhigh", FLASH)).toBe("medium");
      expect(resolveWireThinkingLevel("clawai", "xhigh")).toBe("medium");
      // Supported levels pass through on both aliases.
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

describe("Claude models that mandate thinking", () => {
  // The gateway refuses `thinkingLevel: "off"` for them — seen on a box:
  //   thinkingLevel "off" is not supported for anthropic/claude-fable-5-1
  //   (use minimal|low|medium|adaptive|high|xhigh|max)
  // and the chat's safe start value IS "off", so every fresh session hit it.
  it("never offers or sends Off for Fable 5 / Mythos 5", () => {
    for (const model of ["anthropic/claude-fable-5-1", "claude-fable-5", "anthropic/claude-mythos-5-1"]) {
      const cfg = getProviderReasoningConfig("anthropic", model);
      expect(cfg.levels).not.toContain("off");
      expect(cfg.default).toBe("medium");
      expect(resolveWireThinkingLevel("anthropic", "off", model)).toBe("medium");
    }
  });

  // M2 of the 2026-09-17 review. The hand-written regex under-matched the
  // core's own predicate (`requiresClaudeMandatoryAdaptiveThinking`,
  // packages/llm-core/src/model-contracts/anthropic.ts at v2026.9.3), which
  // also names `claude-mythos-preview` and anchors both ends.
  it("names claude-mythos-preview, which the core's own predicate does", () => {
    for (const model of [
      "anthropic/claude-mythos-preview",
      "claude-mythos-preview",
      // The core's boundary is `(?:^|-)`, so a HYPHEN-prefixed id counts. A
      // dotted deployment id (`us.anthropic.claude-…`) does not reach this
      // regex the way it reaches the core's, which runs
      // `resolveClaudeModelIdentity` first; the gateway's own `thinkingLevels`
      // is what covers that case here (see the intersection suite below).
      "anthropic/bedrock-claude-mythos-preview",
    ]) {
      const cfg = getProviderReasoningConfig("anthropic", model);
      expect(cfg.levels).not.toContain("off");
      expect(resolveWireThinkingLevel("anthropic", "off", model)).toBe("medium");
    }
  });

  it("is anchored at BOTH ends, so a longer id is not swept in", () => {
    // No trailing boundary meant `claude-fable-50` matched and lost its Off.
    for (const model of [
      "anthropic/claude-fable-50",
      "anthropic/claude-mythos-55",
      "anthropic/claude-mythos-previewer",
      "anthropic/notclaude-fable-5",
    ]) {
      expect(getProviderReasoningConfig("anthropic", model).levels).toContain("off");
    }
  });

  it("leaves the other Claude models, and other providers, as they were", () => {
    expect(getProviderReasoningConfig("anthropic", "anthropic/claude-opus-5").levels).toContain("off");
    expect(getProviderReasoningConfig("openai", "openai/gpt-5.5").levels).toContain("off");
    expect(resolveWireThinkingLevel("anthropic", "off", "anthropic/claude-opus-5")).toBe("off");
  });

  it("reads the level to fall back to out of the gateway's menu-style refusal", () => {
    expect(parseUnsupportedThinkingLevelError(
      'thinkingLevel "off" is not supported for anthropic/claude-fable-5-1 (use minimal|low|medium|adaptive|high|xhigh|max)',
    )).toBe("medium");
    expect(parseUnsupportedThinkingLevelError(
      'thinkingLevel "off" is not supported for some/model (use adaptive|high)',
    )).toBe("adaptive");
    // The single-level form still reads as before.
    expect(parseUnsupportedThinkingLevelError(
      'thinkingLevel "high" is not supported for llamacpp/gemma4-e2b-it-q4_0 (use off)',
    )).toBe("off");
  });
});

describe("the gateway's own thinkingLevels, intersected with ClawBox's ladder", () => {
  // HARNESS-FIRST. `models.list` carries `thinkingLevels` per MODEL
  // (packages/gateway-protocol/src/schema/agents-models-skills.ts at
  // v2026.9.3), built from the same profile the gateway then judges a
  // `thinkingLevel` against — so a level it publishes is a level it will take.
  // `/setup-api/chat/model` reads it over the in-process socket and stamps it
  // on the row; the local table stays as the offline fallback.
  const UNIFORM = ["off", "low", "medium", "high"];

  it("keeps only what both agree on", () => {
    const cfg = getProviderReasoningConfig("openai", "openai/gpt-5.5", ["low", "medium", "high", "xhigh"]);
    // `xhigh` is the gateway's and not the ladder's; `off` is the ladder's and
    // not the gateway's. Neither is offered.
    expect(cfg.levels).toEqual(["low", "medium", "high"]);
    expect(cfg.default).toBe("medium");
  });

  it("drops Off for a model the gateway says refuses it, whatever the local table thinks", () => {
    // The whole failure M2 is about, for a model no regex here names: the
    // gateway is the one that knows.
    const cfg = getProviderReasoningConfig("anthropic", "anthropic/claude-something-new", ["low", "medium", "high"]);
    expect(cfg.levels).not.toContain("off");
    expect(resolveWireThinkingLevel("anthropic", "off", "anthropic/claude-something-new", ["low", "medium", "high"]))
      .toBe("medium");
  });

  it("falls back to the local table when the gateway was not asked or said nothing", () => {
    for (const levels of [undefined, null, [], ["not-a-level"]] as const) {
      expect(getProviderReasoningConfig("openai", "openai/gpt-5.5", levels).levels).toEqual(UNIFORM);
    }
  });

  it("offers the gateway's own levels when the two share none", () => {
    // A model that takes only `adaptive`/`max`: offering the uniform ladder
    // would be four controls the gateway refuses. The default is clamped in.
    const cfg = getProviderReasoningConfig("anthropic", "anthropic/claude-odd", ["adaptive", "max"]);
    expect(cfg.levels.length).toBeGreaterThan(0);
    expect(cfg.levels.every((level) => ["adaptive", "max"].includes(level))).toBe(true);
    expect(cfg.levels).toContain(cfg.default);
  });

  it("never lets the wire value leave the intersection", () => {
    const wire = resolveWireThinkingLevel("openai", "off", "openai/gpt-5.5", ["low", "medium", "high"]);
    expect(wire).not.toBe("off");
    expect(["low", "medium", "high"]).toContain(wire);
  });
});
