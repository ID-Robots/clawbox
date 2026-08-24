import { describe, expect, it } from "vitest";
import {
  applyOllamaThinkingToChatBody,
  chatBodyModelId,
  isChatCompletionsPath,
} from "@/lib/local-ai-thinking";

/**
 * The second half of TASK-457 (a): the vocabulary fix stops the PICKER offering
 * a value Ollama refuses, and this stops the BACKEND refusing one anyway.
 *
 * A model without the `thinking` capability answers every reasoning_effort but
 * `none` with HTTP 400 — including `max`, which is the ON end of the switch. So
 * "Thinking on" on a qwen2.5-class model would still have been a failed turn
 * after the vocabulary fix alone. Dropping the field (verified: a body with no
 * `reasoning_effort` is a 200) makes the turn run.
 */
const body = (extra: Record<string, unknown>) => JSON.stringify({
  model: "qwen2.5:3b",
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

describe("applyOllamaThinkingToChatBody", () => {
  it("drops the field a non-thinking model would 400 on, keeping everything else", () => {
    const out = applyOllamaThinkingToChatBody(body({ reasoning_effort: "max", temperature: 0.4 }), false);
    const parsed = JSON.parse(out);
    expect(parsed).not.toHaveProperty("reasoning_effort");
    expect(parsed.model).toBe("qwen2.5:3b");
    expect(parsed.temperature).toBe(0.4);
    expect(parsed.messages).toHaveLength(1);
  });

  it("drops it for the OFF end too, so no level can fail the turn", () => {
    for (const level of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
      const parsed = JSON.parse(applyOllamaThinkingToChatBody(body({ reasoning_effort: level }), false));
      expect(parsed, level).not.toHaveProperty("reasoning_effort");
    }
  });

  it("folds the OFF end onto Ollama's own word when the model CAN think", () => {
    // A stale client still sending llama.cpp's `minimal` means "off". Sending it
    // verbatim to a thinking-capable model would make it think a little, which
    // is the one thing the switch position promised it would not do.
    const parsed = JSON.parse(applyOllamaThinkingToChatBody(body({ reasoning_effort: "minimal" }), true));
    expect(parsed.reasoning_effort).toBe("none");
  });

  it("leaves a thinking level alone when the model can think", () => {
    const original = body({ reasoning_effort: "max" });
    expect(applyOllamaThinkingToChatBody(original, true)).toBe(original);
  });

  it("forwards the body untouched when the capability is unknown", () => {
    // Probe failed — i.e. Ollama is not answering, so the turn is lost anyway.
    // Inventing a value from ignorance is the only way to break a turn that
    // would otherwise have worked.
    const original = body({ reasoning_effort: "max" });
    expect(applyOllamaThinkingToChatBody(original, null)).toBe(original);
  });

  it("does not touch a body that never asked for reasoning", () => {
    const original = body({});
    expect(applyOllamaThinkingToChatBody(original, false)).toBe(original);
  });

  it("forwards a body it cannot parse rather than replacing the backend's error", () => {
    const junk = '{"reasoning_effort": "max", oops';
    expect(applyOllamaThinkingToChatBody(junk, false)).toBe(junk);
    expect(applyOllamaThinkingToChatBody("[1,2,3]", false)).toBe("[1,2,3]");
  });

  it("ignores a non-string effort", () => {
    const original = body({ reasoning_effort: 7 });
    expect(applyOllamaThinkingToChatBody(original, false)).toBe(original);
  });
});

describe("chatBodyModelId", () => {
  it("reads the model the capability probe has to ask about", () => {
    expect(chatBodyModelId(body({}))).toBe("qwen2.5:3b");
    expect(chatBodyModelId('{"model":"  spaced  "}')).toBe("spaced");
  });

  it("answers empty for anything it cannot read", () => {
    expect(chatBodyModelId("not json")).toBe("");
    expect(chatBodyModelId("[]")).toBe("");
    expect(chatBodyModelId('{"model":42}')).toBe("");
  });
});

describe("isChatCompletionsPath", () => {
  it("matches BOTH proxy mount depths", () => {
    // llamacpp's route owns the /v1 segment, ollama's does not — so the same
    // upstream endpoint arrives here with a different number of segments.
    // Matching only the two-segment form skipped every ollama chat turn.
    expect(isChatCompletionsPath(["chat", "completions"])).toBe(true);
    expect(isChatCompletionsPath(["v1", "chat", "completions"])).toBe(true);
  });

  it("does not match anything else", () => {
    expect(isChatCompletionsPath(["models"])).toBe(false);
    expect(isChatCompletionsPath(["api", "chat"])).toBe(false);
    expect(isChatCompletionsPath(["v1", "completions"])).toBe(false);
    expect(isChatCompletionsPath(["v2", "chat", "completions"])).toBe(false);
    expect(isChatCompletionsPath(["v1", "chat", "completions", "extra"])).toBe(false);
    expect(isChatCompletionsPath([])).toBe(false);
  });
});
