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
