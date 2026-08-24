import { describe, expect, it } from "vitest";
import {
  HERMES_REASONING_LEVELS,
  HERMES_REASONING_OFFERED_LEVELS,
  HERMES_REASONING_WIRE_EQUIVALENT,
  LOCAL_REASONING_LEVELS_BY_BACKEND,
  clampReasoningForProvider,
  hermesReasoningLevelsFor,
  isReasoningLevelAllowedFor,
  isThinkingOnLevel,
  localReasoningLevelsFor,
  normalizeReasoningForWire,
  type HermesLocalBackend,
} from "@/lib/hermes-reasoning";
import { thinkingEnabledForLevel } from "@/lib/local-ai-thinking";

/**
 * TASK-457 (a)+(b): every explicit reasoning level failed the turn on the
 * on-device provider when its backend was Ollama.
 *
 * MEASURED on the device's own Ollama 0.32.15 with `qwen2.5:0.5b`, whose
 * `/api/show` capabilities are ["completion","tools"] — no "thinking":
 *
 *   reasoning_effort=none    → HTTP 200
 *   reasoning_effort=minimal → HTTP 400 "…does not support thinking"
 *   reasoning_effort=low|medium|high|max|ultra → HTTP 400, same message
 *   reasoning_effort=banana-nonsense → HTTP 400 "invalid reasoning value:
 *      … (must be "minimal","low","medium","high","xhigh","ultra","max","none")"
 *
 * The route clamped `clawlocal` to exactly {minimal, max} — the two values the
 * first two lines show are guaranteed failures — and could never emit `none`,
 * the one value that works. Whatever the customer picked, the turn 400'd.
 *
 * The nonsense probe is what says this is a CAPABILITY check and not a spelling
 * one: Ollama knows the same eight words Hermes does. So the fix is to move the
 * OFF end of the switch, not to invent a private vocabulary.
 */
describe("the on-device switch knows which runtime it is talking to", () => {
  it("uses llama.cpp's OFF word on llamacpp and Ollama's on ollama", () => {
    expect(hermesReasoningLevelsFor("clawlocal", "llamacpp")).toEqual(["minimal", "max"]);
    expect(hermesReasoningLevelsFor("clawlocal", "ollama")).toEqual(["none", "max"]);
  });

  it("never offers ollama the value ollama rejects", () => {
    // `minimal` is the exact string that answered 400 on the box.
    expect(hermesReasoningLevelsFor("clawlocal", "ollama")).not.toContain("minimal");
  });

  it("clamps EVERY level onto a value its backend accepts", () => {
    for (const backend of ["llamacpp", "ollama"] as const) {
      const allowed = LOCAL_REASONING_LEVELS_BY_BACKEND[backend];
      for (const level of HERMES_REASONING_LEVELS) {
        const clamped = clampReasoningForProvider("clawlocal", level, backend);
        expect(allowed, `${backend}/${level}`).toContain(clamped);
      }
    }
  });

  it("stops rewriting `none` into a value the backend refuses", () => {
    // TASK-457 (b). The rewrite itself is deliberate — a two-state switch has
    // to land on one of its two ends — but on ollama the end it landed on was
    // the one that 400s. `none` IS ollama's off end, so it now passes through.
    expect(clampReasoningForProvider("clawlocal", "none", "ollama")).toBe("none");
    // llama.cpp is unchanged: `reasoning_effort` is inert there, the proxy
    // translates the level into chat_template_kwargs.enable_thinking, and
    // `minimal` reads better than `none` in a switch that only controls
    // thinking.
    expect(clampReasoningForProvider("clawlocal", "none", "llamacpp")).toBe("minimal");
  });

  it("keeps both OFF words meaning thinking-off in every layer", () => {
    for (const off of ["none", "minimal"] as const) {
      expect(isThinkingOnLevel("clawlocal", off), off).toBe(false);
      expect(thinkingEnabledForLevel(off), off).toBe(false);
    }
    for (const on of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(isThinkingOnLevel("clawlocal", on), on).toBe(true);
      expect(thinkingEnabledForLevel(on), on).toBe(true);
    }
  });

  it("defaults to the shipped runtime when nobody says which one is loaded", () => {
    // The browser cannot know the backend, so it asks without one; the route
    // re-clamps with the real value. The default must therefore be the runtime
    // the product actually ships (and the only one the Settings picker offers).
    expect(localReasoningLevelsFor(undefined)).toEqual(LOCAL_REASONING_LEVELS_BY_BACKEND.llamacpp);
    expect(localReasoningLevelsFor(null)).toEqual(LOCAL_REASONING_LEVELS_BY_BACKEND.llamacpp);
    expect(hermesReasoningLevelsFor("clawlocal")).toEqual(["minimal", "max"]);
  });

  it("ignores the backend for a provider that is not the on-device one", () => {
    const backend: HermesLocalBackend = "ollama";
    expect(hermesReasoningLevelsFor("anthropic", backend)).toEqual(HERMES_REASONING_OFFERED_LEVELS);
    expect(isReasoningLevelAllowedFor("anthropic", "medium", backend)).toBe(true);
  });
});

/**
 * TASK-457 (c): `ultra` is not a level. Reproduced live — Hermes'
 * `clamp_effort` turns it into `max` for every OpenAI-compatible wire
 * (agent/reasoning_effort.py: "no provider wire accepts it verbatim anywhere"),
 * and ClawBox's own clamp did the same. Offering it claimed a distinction that
 * does not exist, and on clawai it was worse than useless: HTTP 400.
 */
describe("levels the wire collapses are not offered", () => {
  it("offers no level whose only effect is to become another one", () => {
    for (const level of HERMES_REASONING_OFFERED_LEVELS) {
      expect(normalizeReasoningForWire(level), level).toBe(level);
    }
    expect(HERMES_REASONING_OFFERED_LEVELS).not.toContain("ultra");
    for (const provider of ["anthropic", "clawai", "openai", "some-new-provider"]) {
      expect(hermesReasoningLevelsFor(provider), provider).not.toContain("ultra");
    }
    expect(hermesReasoningLevelsFor("clawlocal", "llamacpp")).not.toContain("ultra");
    expect(hermesReasoningLevelsFor("clawlocal", "ollama")).not.toContain("ultra");
  });

  it("still ACCEPTS the collapsed word and folds it onto its real value", () => {
    // A client with a saved `ultra` from before it left the picker must get the
    // turn it always got, not the 400 clawai answers that word with.
    expect(HERMES_REASONING_WIRE_EQUIVALENT.ultra).toBe("max");
    expect(normalizeReasoningForWire("ultra")).toBe("max");
  });

  it("keeps every other level distinct", () => {
    const collapsed = Object.keys(HERMES_REASONING_WIRE_EQUIVALENT);
    expect(collapsed).toEqual(["ultra"]);
    expect(HERMES_REASONING_OFFERED_LEVELS).toHaveLength(HERMES_REASONING_LEVELS.length - 1);
  });
});

/**
 * The direction the clamp moves a level it cannot honour.
 *
 * Pinned because the mapping table in `docs/hermes-reasoning-levels.md` and the
 * copy at the top of hermes-reasoning.ts are the documents this project treats
 * as the source of truth, and they first shipped with this row inverted —
 * claiming `low`–`xhigh` became `max` / thinking ON. They do not: a two-state
 * provider has nothing between its two ends, and clampReasoningForProvider
 * walks DOWN, so the whole middle band lands on OFF. A reader trusting the
 * wrong row would have "fixed" the clamp backwards, silently turning thinking
 * on for every stale client.
 */
describe("a level the on-device switch cannot honour clamps DOWN, never up", () => {
  const MIDDLE = ["low", "medium", "high", "xhigh"] as const;
  const OFF_WORD: Record<HermesLocalBackend, string> = {
    llamacpp: "minimal",
    ollama: "none",
  };

  for (const backend of ["llamacpp", "ollama"] as const) {
    it(`sends ${OFF_WORD[backend]} — the OFF end — for every middle level on ${backend}`, () => {
      for (const level of MIDDLE) {
        const clamped = clampReasoningForProvider("clawlocal", level, backend);
        expect(clamped, `${backend}/${level}`).toBe(OFF_WORD[backend]);
        // The claim that matters is not the word but what it does.
        expect(isThinkingOnLevel("clawlocal", clamped), `${backend}/${level} thinking`).toBe(false);
      }
    });
  }

  it("keeps the ON end on, so the walk is not simply collapsing everything", () => {
    for (const backend of ["llamacpp", "ollama"] as const) {
      expect(clampReasoningForProvider("clawlocal", "max", backend)).toBe("max");
      expect(clampReasoningForProvider("clawlocal", "ultra", backend)).toBe("max");
      expect(isThinkingOnLevel("clawlocal", "max")).toBe(true);
    }
  });
});
