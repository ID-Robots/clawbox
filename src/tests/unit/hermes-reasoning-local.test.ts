import { describe, expect, it } from "vitest";
import {
  HERMES_REASONING_LEVELS,
  clampReasoningForProvider,
  hermesReasoningLevelsFor,
  isReasoningLevelAllowedFor,
  providerHasReasoningControl,
} from "@/lib/hermes-reasoning";

/**
 * The chat header offered eight thinking levels for the on-device model and
 * every one of them did the same nothing.
 *
 * Measured on-device: all eight `--reasoning` values returned 0 — including
 * `ultra`, which ClawBox AI rejects — and posting `reasoning_effort: "banana"`,
 * then an entirely invented field name, both answered HTTP 200 with a response
 * identical to sending no field at all. llama.cpp's OpenAI-compatible server
 * ignores unknown JSON keys, so there is no dial to turn.
 *
 * Two provider shapes must stay distinguishable: one that REJECTS some levels
 * (clawai/ultra — refuse it, the turn would 400) and one that has NO CONTROL
 * (clawlocal — drop the parameter and answer, since it could not have mattered).
 */
describe("providers with no reasoning control", () => {
  it("reports no levels for the on-device model", () => {
    expect(hermesReasoningLevelsFor("clawlocal")).toEqual([]);
    expect(providerHasReasoningControl("clawlocal")).toBe(false);
  });

  it("still reports levels for providers that have a real dial", () => {
    expect(providerHasReasoningControl("anthropic")).toBe(true);
    expect(hermesReasoningLevelsFor("anthropic")).toEqual(HERMES_REASONING_LEVELS);
    // clawai has a dial; it just refuses the top notch.
    expect(providerHasReasoningControl("clawai")).toBe(true);
    expect(hermesReasoningLevelsFor("clawai")).not.toContain("ultra");
    expect(hermesReasoningLevelsFor("clawai")).toContain("max");
  });

  it("treats an unknown provider as having the full dial", () => {
    expect(hermesReasoningLevelsFor("some-new-provider")).toEqual(HERMES_REASONING_LEVELS);
    expect(providerHasReasoningControl(undefined)).toBe(true);
  });

  it("allows no level at all, so nothing can be sent as if it mattered", () => {
    for (const level of HERMES_REASONING_LEVELS) {
      expect(isReasoningLevelAllowedFor("clawlocal", level)).toBe(false);
    }
  });

  it("clamping never invents a level for a provider with no dial", () => {
    // The caller drops the parameter entirely; clamp must not hand back a level
    // that would then be passed through as if the provider understood it.
    const clamped = clampReasoningForProvider("clawlocal", "ultra");
    expect(hermesReasoningLevelsFor("clawlocal")).not.toContain(clamped);
  });

  it("still walks DOWN to the nearest supported level where a dial exists", () => {
    expect(clampReasoningForProvider("clawai", "ultra")).toBe("max");
    expect(clampReasoningForProvider("clawai", "low")).toBe("low");
  });
});
