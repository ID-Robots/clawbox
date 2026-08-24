import { describe, expect, it } from "vitest";
import {
  SMALL_LOCAL_MODEL_MAX_CONTEXT_TOKENS,
  SMALL_LOCAL_MODEL_MAX_PARAM_B,
  SMALL_LOCAL_MODEL_TOOLSETS,
  isSmallLocalModel,
  parseModelParamBillions,
  slimLocalProfileEnabled,
  smallLocalModelToolsets,
} from "@/lib/local-model-profile";

/**
 * TASK-457 (d). Re-measured on the device rather than taken from the report:
 * a turn ships 30,472 chars of system text plus 61 tool schemas (19 built-in /
 * 56,275 B, 42 ClawBox MCP / 26,358 B) — ~113 KB before the customer's first
 * word, against a 64k configured window on a 2-4B model. The report's "43 KB
 * prompt / 24 tools" was wrong in both directions; the tool SCHEMAS are the
 * cost.
 *
 * These tests pin the rule that decides when a turn gets the slim profile.
 */
describe("reading a model's size out of its id", () => {
  it("reads the sizes the on-device models actually ship with", () => {
    // The shipped default: Gemma's "E2B" is its effective parameter count, and
    // it is preceded by a LETTER — the reason the pattern allows one.
    expect(parseModelParamBillions("gemma4-e2b-it-q4_0")).toBe(2);
    expect(parseModelParamBillions("gemma-4-E2B-it-qat-q4_0-gguf")).toBe(2);
    expect(parseModelParamBillions("qwen2.5:3b")).toBe(3);
    expect(parseModelParamBillions("qwen2.5:0.5b")).toBe(0.5);
    expect(parseModelParamBillions("llama3.2-1b-instruct-q8_0")).toBe(1);
    expect(parseModelParamBillions("gpt-oss:20b")).toBe(20);
  });

  it("is not fooled by a quantisation tag or a version number", () => {
    expect(parseModelParamBillions("deepseek-v4-pro")).toBeNull();
    expect(parseModelParamBillions("claude-sonnet-4-5")).toBeNull();
    expect(parseModelParamBillions("")).toBeNull();
    // `q4_0` and `qwen2.5` must not read as "4B" / "2.5B".
    expect(parseModelParamBillions("some-model-q4_0")).toBeNull();
  });

  it("reads a mixture-of-experts name as the product, not the second factor", () => {
    // 8x7b is a 47B model. Calling it 7B would slim a model with ample room;
    // overestimating only costs it the full tool set it can afford.
    expect(parseModelParamBillions("mixtral:8x7b")).toBe(56);
    expect(isSmallLocalModel({ modelId: "mixtral:8x7b" })).toBe(false);
  });
});

describe("which models get the slim profile", () => {
  it("slims everything this hardware can actually host", () => {
    for (const id of ["gemma4-e2b-it-q4_0", "qwen2.5:3b", "llama3.2:1b", "qwen2.5:0.5b"]) {
      expect(isSmallLocalModel({ modelId: id }), id).toBe(true);
    }
  });

  it("does not slim a model that is comfortably bigger than the threshold", () => {
    expect(isSmallLocalModel({ modelId: "gpt-oss:20b" })).toBe(false);
    expect(isSmallLocalModel({ modelId: `model-${SMALL_LOCAL_MODEL_MAX_PARAM_B + 1}b` })).toBe(false);
    expect(isSmallLocalModel({ modelId: `model-${SMALL_LOCAL_MODEL_MAX_PARAM_B}b` })).toBe(true);
  });

  it("prefers an exact parameter count when a backend reports one", () => {
    // Ollama's /api/show returns general.parameter_count — 494032768 for
    // qwen2.5:0.5b on the box.
    expect(isSmallLocalModel({ modelId: "mystery", parameterCount: 494_032_768 })).toBe(true);
    expect(isSmallLocalModel({ modelId: "mystery", parameterCount: 70_000_000_000 })).toBe(false);
  });

  it("slims on a small CONTEXT whatever the parameter count", () => {
    // ~113 KB of fixed preamble is roughly 28k tokens: at or below this the
    // turn cannot fit its own preamble.
    expect(isSmallLocalModel({
      modelId: "gpt-oss:20b",
      contextTokens: SMALL_LOCAL_MODEL_MAX_CONTEXT_TOKENS,
    })).toBe(true);
    expect(isSmallLocalModel({ modelId: "gpt-oss:20b", contextTokens: 131_072 })).toBe(false);
  });

  it("treats an unreadable id as small, because only on-device models are asked about", () => {
    // Callers gate on the provider being the on-device one first. Everything
    // this box can host is small, and sending 113 KB to a model we could not
    // identify is the failure being fixed.
    expect(isSmallLocalModel({ modelId: "custom-gguf" })).toBe(true);
    expect(isSmallLocalModel({})).toBe(true);
  });
});

describe("the built-in toolsets a slim turn keeps", () => {
  it("keeps the four a plain answer needs and nothing else", () => {
    expect(SMALL_LOCAL_MODEL_TOOLSETS).toEqual(["web", "memory", "file", "terminal"]);
    // The heavyweights measured by `hermes prompt-size`: computer_use 10.7 KB,
    // session_search 7.0 KB, delegation 5.8 KB.
    for (const dropped of ["computer_use", "session_search", "delegation", "clarify", "todo"]) {
      expect(SMALL_LOCAL_MODEL_TOOLSETS, dropped).not.toContain(dropped);
    }
  });

  it("takes an operator override, but only names that are safe in argv", () => {
    expect(smallLocalModelToolsets({ CLAWBOX_SMALL_MODEL_TOOLSETS: "web, todo " } as unknown as NodeJS.ProcessEnv))
      .toEqual(["web", "todo"]);
    // A leading "-" would be read by hermes as a flag; a list that filters down
    // to nothing falls back rather than sending `-t ""`.
    expect(smallLocalModelToolsets({ CLAWBOX_SMALL_MODEL_TOOLSETS: "--yolo" } as unknown as NodeJS.ProcessEnv))
      .toEqual(SMALL_LOCAL_MODEL_TOOLSETS);
    expect(smallLocalModelToolsets({} as unknown as NodeJS.ProcessEnv)).toEqual(SMALL_LOCAL_MODEL_TOOLSETS);
  });

  it("has an off switch", () => {
    expect(slimLocalProfileEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(true);
    for (const off of ["off", "0", "false", "OFF"]) {
      expect(slimLocalProfileEnabled({ CLAWBOX_SMALL_MODEL_PROFILE: off } as unknown as NodeJS.ProcessEnv), off).toBe(false);
    }
    expect(slimLocalProfileEnabled({ CLAWBOX_SMALL_MODEL_PROFILE: "on" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});

/**
 * CodeQL `js/polynomial-redos` (high) on PR #442: the two regexes this parser
 * used to be were quadratic in the length of a CLIENT-SUPPLIED string (the chat
 * request body's `model`). Measured on the old implementation with a string of
 * n `0`s — 11.7 ms at n=2,000, 47.3 ms at 4,000, 251.8 ms at 8,000, 861.4 ms at
 * 16,000: 4x per doubling, the signature of an O(n²) scan.
 *
 * The chat route bounds its own input first (isSafeHermesModelId caps ids at
 * 200 characters), but mcp/lib/profile.ts calls the same parser with whatever
 * the models endpoint reports, so the parser owns this.
 */
describe("reading a size out of a model id is linear in its length", () => {
  const timeMs = (input: string): number => {
    const started = performance.now();
    parseModelParamBillions(input);
    return performance.now() - started;
  };

  it("does not blow up on a long run of digits", () => {
    // The old implementation needed ~861 ms for 16k characters and would need
    // roughly two minutes for 200k. A generous ceiling: the point is the shape
    // of the curve, not a benchmark, so this must not go flaky on a loaded CI
    // box while still failing outright if the quadratic ever comes back.
    expect(timeMs("0".repeat(200_000))).toBeLessThan(2_000);
  });

  it("scales linearly rather than quadratically", () => {
    // Warm the JIT so the first call's compile time is not read as cost.
    timeMs("0".repeat(50_000));
    const small = Math.max(timeMs("0".repeat(50_000)), 0.05);
    const large = timeMs("0".repeat(400_000));
    // 8x the input. Linear predicts ~8x the time; quadratic predicts ~64x.
    expect(large / small).toBeLessThan(32);
  });

  it("still refuses a pathological string rather than inventing a size", () => {
    expect(parseModelParamBillions("0".repeat(10_000))).toBeNull();
    expect(parseModelParamBillions(`${"0".repeat(10_000)}b`)).toBeNull();
    expect(parseModelParamBillions(`1${"0".repeat(20)}b`)).toBe(1e20);
  });

  it("reads a second decimal point as a new number — a deliberate difference", () => {
    // The backtracking regex could start matching part-way through a digit run,
    // so `1.2.3b` gave it 2.3. The single left-to-right scan takes the maximal
    // leading number and then starts afresh, so it gives 3. No real model id
    // looks like this and both readings sit on the same side of the 8B
    // threshold; pinned so the choice stays visible rather than accidental.
    expect(parseModelParamBillions("1.2.3b")).toBe(3);
    expect(parseModelParamBillions("1.2.3.4b")).toBe(3.4);
    expect(parseModelParamBillions("1.b")).toBeNull();
  });
});
