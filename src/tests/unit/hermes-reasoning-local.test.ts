import { describe, expect, it } from "vitest";
import {
  HERMES_REASONING_LEVELS,
  HERMES_REASONING_OFFERED_LEVELS,
  LOCAL_REASONING_LEVELS,
  binaryReasoningLabel,
  binaryReasoningTriggerLabel,
  clampReasoningForProvider,
  hermesReasoningLevelsFor,
  isReasoningLevelAllowedFor,
  isThinkingOnLevel,
  providerHasBinaryReasoning,
  providerHasReasoningControl,
} from "@/lib/hermes-reasoning";
import { thinkingEnabledForLevel } from "@/lib/local-ai-thinking";

/**
 * REVERSAL — read this before "restoring" the old behaviour.
 *
 * The chat header used to offer eight thinking levels for the on-device model
 * and every one did the same nothing, so the pill was hidden entirely. That
 * measurement was right and still is: llama.cpp's OpenAI-compatible server
 * ignores `reasoning_effort` (an invented field name likewise answers HTTP
 * 200 with an identical response).
 *
 * But "ignores reasoning_effort" was not the same question as "has no thinking
 * control". VERIFIED against the shipped binary (llama-server version 1
 * (db7d8b2)) with the server running `--reasoning off`, same question each time:
 *
 *   chat_template_kwargs.enable_thinking=false →   0 reasoning chars,   4 tok,  207 ms
 *   chat_template_kwargs.enable_thinking=true  → 703 reasoning chars, 253 tok, 8416 ms
 *
 * Both directions, no restart. And unlike `reasoning_effort`, that field is
 * VALIDATED — a non-boolean returns HTTP 400 — which is how we know it is read
 * rather than tolerated.
 *
 * What did NOT become available is a graded scale: `--reasoning-budget` is a
 * launch flag and is not honoured per request (budget 64 → 371 reasoning chars,
 * budget 0 → 518 — noise, not enforcement). So the model gets TWO levels, and
 * offering Low/Medium/High would recreate the original bug.
 *
 * Three provider shapes must stay distinguishable:
 *   - REJECTS some levels   (clawai/ultra — refuse it, the turn would 400)
 *   - TWO-STATE switch      (clawlocal — on or off, nothing in between)
 *   - NO CONTROL            (none today; drop the parameter and answer)
 */
describe("the on-device model's thinking switch", () => {
  it("offers exactly two levels, not eight and not zero", () => {
    expect(hermesReasoningLevelsFor("clawlocal")).toEqual(LOCAL_REASONING_LEVELS);
    expect(hermesReasoningLevelsFor("clawlocal")).toHaveLength(2);
    expect(providerHasReasoningControl("clawlocal")).toBe(true);
    expect(providerHasBinaryReasoning("clawlocal")).toBe(true);
  });

  it("offers no graded middle, because the backend has none", () => {
    const levels = hermesReasoningLevelsFor("clawlocal");
    for (const middle of ["low", "medium", "high", "xhigh"] as const) {
      expect(levels).not.toContain(middle);
      expect(isReasoningLevelAllowedFor("clawlocal", middle)).toBe(false);
    }
  });

  it("labels the two ends as a switch, not as points on an effort scale", () => {
    const [off, on] = LOCAL_REASONING_LEVELS;
    expect(binaryReasoningLabel("clawlocal", off)).toBe("Thinking off");
    expect(binaryReasoningLabel("clawlocal", on)).toBe("Thinking on");
  });

  it("gives no switch label for providers with a real effort scale", () => {
    expect(binaryReasoningLabel("clawai", "max")).toBeNull();
    expect(binaryReasoningLabel("anthropic", "medium")).toBeNull();
    expect(binaryReasoningTriggerLabel("anthropic", "medium")).toBeNull();
    expect(providerHasBinaryReasoning("anthropic")).toBe(false);
  });

  it("has a compact pill form of each label for the header's width budget", () => {
    const [off, on] = LOCAL_REASONING_LEVELS;
    expect(binaryReasoningTriggerLabel("clawlocal", off)).toBe("Off");
    expect(binaryReasoningTriggerLabel("clawlocal", on)).toBe("On");
    // Every surface that names a level — pill, menu, and the "Switched
    // thinking to X." confirmation — must agree that this is a switch. A
    // scale word leaking into any of them implies a Medium that cannot exist.
    for (const level of LOCAL_REASONING_LEVELS) {
      expect(binaryReasoningLabel("clawlocal", level)).not.toMatch(/minimal|max/i);
      expect(binaryReasoningTriggerLabel("clawlocal", level)).not.toMatch(/minimal|max/i);
    }
  });

  it("defaults to thinking OFF, matching the server's own launch default", () => {
    // LLAMACPP_REASONING defaults to `off` in scripts/start-llamacpp.sh, and
    // the bake-off that chose this model was measured with it off. A user
    // arriving with the shared default must not silently land on the 8s path.
    const clamped = clampReasoningForProvider("clawlocal", "medium");
    expect(clamped).toBe(LOCAL_REASONING_LEVELS[0]);
    expect(binaryReasoningLabel("clawlocal", clamped)).toBe("Thinking off");
  });

  it("keeps a deliberate high setting when switching from another provider", () => {
    // Someone sitting on `max` asked for maximum effort; landing them on the
    // thinking-on end honours that rather than quietly downgrading it.
    expect(clampReasoningForProvider("clawlocal", "max")).toBe("max");
    expect(clampReasoningForProvider("clawlocal", "ultra")).toBe("max");
  });

  it("clamps every level to one of the two ends, never outside them", () => {
    for (const level of HERMES_REASONING_LEVELS) {
      expect(LOCAL_REASONING_LEVELS).toContain(clampReasoningForProvider("clawlocal", level));
    }
  });

  it("clamps a level BELOW the switch down to off, never up to on", () => {
    // `none` sits under both ends, so the walk-down finds no candidate. Landing
    // on the far end would turn "no reasoning at all" into the slowest setting.
    expect(clampReasoningForProvider("clawlocal", "none")).toBe(LOCAL_REASONING_LEVELS[0]);
    expect(isThinkingOnLevel("clawlocal", clampReasoningForProvider("clawlocal", "none"))).toBe(false);
  });
});

/**
 * The switch's direction is decided in ONE place and read by two layers: the
 * chat header's label and cost hint, and the proxy's `enable_thinking` boolean.
 *
 * They used to derive it independently — the UI positionally ("the last
 * option"), the proxy by name (a set containing "minimal"). They agreed only
 * because both happened to mention the same word. Reorder LOCAL_REASONING_LEVELS
 * and the pill would read "Thinking off" while the wire said `true`: a dial that
 * lies, silently, which is precisely the failure this whole area exists to
 * prevent. These tests fail if the two ever drift again.
 */
describe("the label and the wire agree about which end is on", () => {
  const [off, on] = LOCAL_REASONING_LEVELS;

  it("maps the OFF end to no thinking, in both layers", () => {
    expect(isThinkingOnLevel("clawlocal", off)).toBe(false);
    expect(thinkingEnabledForLevel(off)).toBe(false);
    expect(binaryReasoningLabel("clawlocal", off)).toBe("Thinking off");
  });

  it("maps the ON end to thinking, in both layers", () => {
    expect(isThinkingOnLevel("clawlocal", on)).toBe(true);
    expect(thinkingEnabledForLevel(on)).toBe(true);
    expect(binaryReasoningLabel("clawlocal", on)).toBe("Thinking on");
  });

  it("resolves a level from the middle of the scale to thinking-on", () => {
    // `hermes --reasoning` can send any of eight words. Anything above the off
    // end counts as "think", so raising effort can never reduce thinking.
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(thinkingEnabledForLevel(level), level).toBe(true);
    }
    expect(thinkingEnabledForLevel("none")).toBe(false);
  });

  it("treats a value that is not a level at all as no thinking", () => {
    expect(thinkingEnabledForLevel("banana")).toBe(false);
    expect(thinkingEnabledForLevel("")).toBe(false);
  });
});

describe("providers with a full or restricted dial", () => {
  it("still reports levels for providers that have a real dial", () => {
    expect(providerHasReasoningControl("anthropic")).toBe(true);
    expect(hermesReasoningLevelsFor("anthropic")).toEqual(HERMES_REASONING_OFFERED_LEVELS);
    // clawai has a dial; it just refuses the top notch.
    expect(providerHasReasoningControl("clawai")).toBe(true);
    expect(hermesReasoningLevelsFor("clawai")).not.toContain("ultra");
    expect(hermesReasoningLevelsFor("clawai")).toContain("max");
  });

  it("treats an unknown provider as having the full dial", () => {
    expect(hermesReasoningLevelsFor("some-new-provider")).toEqual(HERMES_REASONING_OFFERED_LEVELS);
    expect(providerHasReasoningControl(undefined)).toBe(true);
  });

  it("still walks DOWN to the nearest supported level where a scale exists", () => {
    expect(clampReasoningForProvider("clawai", "ultra")).toBe("max");
    expect(clampReasoningForProvider("clawai", "low")).toBe("low");
  });
});
