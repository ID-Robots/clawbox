import { describe, expect, it } from "vitest";
import {
  lastModelSegment,
  shortModelPillLabel,
  REASONING_PILL_ICON,
} from "@/lib/chat-header-pills";
import { hermesProviderPillLabel } from "@/lib/hermes-providers";

describe("lastModelSegment", () => {
  it("keeps only the model half of a vendor/model slug", () => {
    expect(lastModelSegment("anthropic/claude-fable-5")).toBe("claude-fable-5");
    expect(lastModelSegment("openai/gpt-5.4-mini")).toBe("gpt-5.4-mini");
  });

  it("passes a bare id through unchanged", () => {
    expect(lastModelSegment("deepseek-v4-pro")).toBe("deepseek-v4-pro");
  });
});

describe("shortModelPillLabel", () => {
  // The defect: at the docked panel width the model pill rendered
  // "claude-fable-5" in 61px of a 89px need, so it read "claude-fab…" — the
  // truncation ate the only part that distinguishes one model from another,
  // while the surviving part just repeated the provider pill next to it.
  it("drops a leading vendor token the provider pill already shows", () => {
    expect(shortModelPillLabel("claude-fable-5", "Claude")).toBe("fable-5");
    expect(shortModelPillLabel("gemini-2.5-flash", "Gemini")).toBe("2.5-flash");
    expect(shortModelPillLabel("deepseek-v4-pro", "DeepSeek")).toBe("v4-pro");
  });

  it("drops a trailing vendor token too (OpenAI Codex ids end with the vendor)", () => {
    expect(shortModelPillLabel("gpt-5.4-codex", "Codex")).toBe("gpt-5.4");
  });

  it("handles the OpenClaw catalog's space-separated labels", () => {
    expect(shortModelPillLabel("Claude Sonnet 4.6", "Claude")).toBe("Sonnet 4.6");
    expect(shortModelPillLabel("GPT-5.4 Mini", "GPT")).toBe("5.4 Mini");
  });

  it("matches provider labels that differ only in punctuation or spacing", () => {
    // Provider pill "Gemma 4" vs model token "gemma4".
    expect(shortModelPillLabel("gemma4-e2b-it-q4_0", "Gemma 4")).toBe("e2b-it-q4_0");
  });

  it("strips the vendor half of a slug before comparing", () => {
    expect(shortModelPillLabel("anthropic/claude-fable-5", "Claude")).toBe("fable-5");
  });

  it("never empties the pill", () => {
    // Nothing left to say if the whole label IS the provider name.
    expect(shortModelPillLabel("claude", "Claude")).toBe("claude");
    expect(shortModelPillLabel("Claude", "Claude")).toBe("Claude");
  });

  it("leaves an unrelated model id alone", () => {
    // OpenRouter's pill says "OpenRouter", so the vendor prefix here is the
    // only thing naming the vendor and must survive.
    expect(shortModelPillLabel("claude-haiku-4-5", "OpenRouter")).toBe("claude-haiku-4-5");
    expect(shortModelPillLabel("deepseek-v4-pro", "ClawBox")).toBe("deepseek-v4-pro");
  });

  it("only strips whole tokens, never a prefix of one", () => {
    // "claudette" starts with "claude" but is a different word.
    expect(shortModelPillLabel("claudette-1", "Claude")).toBe("claudette-1");
  });

  it("tolerates empty / missing input", () => {
    expect(shortModelPillLabel("", "Claude")).toBe("");
    expect(shortModelPillLabel(null, "Claude")).toBe("");
    expect(shortModelPillLabel("claude-fable-5", "")).toBe("claude-fable-5");
    expect(shortModelPillLabel("claude-fable-5", null)).toBe("claude-fable-5");
  });

  it("composes with the real provider pill labels", () => {
    // The exact pairing the chat header builds: hermesProviderPillLabel feeds
    // shortModelPillLabel, so the two must agree on the vendor's spelling.
    expect(
      shortModelPillLabel("claude-fable-5", hermesProviderPillLabel("anthropic")),
    ).toBe("fable-5");
    expect(
      shortModelPillLabel("gemma4-e2b-it-q4_0", hermesProviderPillLabel("clawlocal")),
    ).toBe("e2b-it-q4_0");
  });
});

describe("REASONING_PILL_ICON", () => {
  it("is a bare Material Symbols ligature name", () => {
    // Anything else (an emoji, markup, a URL) would render as literal text in
    // the pill, which is exactly the failure mode the icon exists to avoid.
    expect(REASONING_PILL_ICON).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});

// Width regression guard.
//
// Rendered widths measured in the device's own Chromium against the real
// stylesheet (Satoshi 11px/600, .header-dropdown-trigger-label). Anything not
// listed here has not been measured and must not be asserted on.
const MEASURED_LABEL_PX: Record<string, number> = {
  // provider pills
  Claude: 42,
  GPT: 25,
  Codex: 38,
  Gemini: 43,
  OpenRouter: 75,
  // model pills — before and after the de-duplication
  "claude-fable-5": 89,
  "fable-5": 44,
  "Claude Sonnet 4.6": 113,
  "Sonnet 4.6": 67,
  "5.6 Terra": 55,
  "5.6 Sol": 43,
  "2.5 Flash": 56,
  // reasoning pill — before and after dropping the word prefix
  "Thinking: Medium": 111,
  Medium: 49,
  Minimal: 49,
};

// Label room in the header row at the 420px docked default:
//   420 − 24 (header padding) − 108 (status dot, dock + close buttons, gaps)
//     = 288px of pill row
//   − 30 − 30 (the two plain pills' padding) − 42 (the icon pill's padding +
//     glyph) − 6 (borders) − 12 (two 6px gaps)
//     = 168px of text
const LABEL_BUDGET_PX = 168;

function rowWidth(...labels: string[]): number {
  return labels.reduce((total, label) => {
    const px = MEASURED_LABEL_PX[label];
    if (px === undefined) throw new Error(`no measurement for "${label}"`);
    return total + px;
  }, 0);
}

describe("header pill width budget", () => {
  it("the pre-fix labels overran the row — this is the defect", () => {
    // On the device: 25 / 61 / 56 of the 42 / 89 / 111 they needed, i.e.
    // "Cla…", "claude-fab…", "Thinki…".
    expect(rowWidth("Claude", "claude-fable-5", "Thinking: Medium"))
      .toBeGreaterThan(LABEL_BUDGET_PX);
  });

  it("fits the Hermes default (Anthropic)", () => {
    const provider = hermesProviderPillLabel("anthropic");
    expect(provider).toBe("Claude");
    expect(rowWidth(provider, shortModelPillLabel("claude-fable-5", provider), "Medium"))
      .toBeLessThanOrEqual(LABEL_BUDGET_PX);
  });

  it("fits the widest shipped OpenClaw default (Claude Sonnet)", () => {
    expect(rowWidth("Claude", shortModelPillLabel("Claude Sonnet 4.6", "Claude"), "Medium"))
      .toBeLessThanOrEqual(LABEL_BUDGET_PX);
    // ...and would NOT have fitted without the de-duplication.
    expect(rowWidth("Claude", "Claude Sonnet 4.6", "Medium"))
      .toBeGreaterThan(LABEL_BUDGET_PX);
  });

  it("fits the other shipped provider defaults", () => {
    expect(rowWidth("GPT", "5.6 Terra", "Medium")).toBeLessThanOrEqual(LABEL_BUDGET_PX);
    expect(rowWidth("Codex", "5.6 Sol", "Medium")).toBeLessThanOrEqual(LABEL_BUDGET_PX);
    expect(rowWidth("Gemini", "2.5 Flash", "Medium")).toBeLessThanOrEqual(LABEL_BUDGET_PX);
    // Longest Hermes level word is no worse than "Medium".
    expect(rowWidth("Claude", "fable-5", "Minimal")).toBeLessThanOrEqual(LABEL_BUDGET_PX);
  });
});
