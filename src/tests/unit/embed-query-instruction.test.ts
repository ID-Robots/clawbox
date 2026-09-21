import { describe, expect, it } from "vitest";
import {
  QWEN3_QUERY_INSTRUCTION,
  applyQueryInstruction,
  isEmbeddingsPath,
  rewriteEmbeddingsBody,
} from "@/lib/embed-query-instruction";

/**
 * The embedder moved from ollama to a bare llama-server behind the local-AI
 * proxy. OpenClaw's ollama adapter prefixed every search query with an
 * instruction the model was trained on; its openai-compatible adapter does not,
 * and sends `input_type` instead. This pins the proxy-side restoration of that
 * prefix — the one thing that keeps recall quality identical across the move.
 */

describe("the qwen3 query instruction", () => {
  it("is byte-for-byte the template OpenClaw's ollama adapter applies", () => {
    // dist/embedding-provider.runtime-*.js, QUERY_INSTRUCTION_TEMPLATES,
    // entry `prefix: "qwen3-embedding"`. A drift here re-embeds every query
    // differently from every document already in the index.
    expect(QWEN3_QUERY_INSTRUCTION).toBe(
      "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:",
    );
    expect(applyQueryInstruction("what was the tunnel link")).toBe(
      "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:what was the tunnel link",
    );
  });
});

describe("rewriteEmbeddingsBody", () => {
  it("prefixes every input of a query request and drops input_type", () => {
    const out = JSON.parse(
      rewriteEmbeddingsBody(JSON.stringify({ model: "m", input: ["a", "b"], input_type: "query" })),
    );
    expect(out).toEqual({ model: "m", input: [applyQueryInstruction("a"), applyQueryInstruction("b")] });
    expect("input_type" in out).toBe(false);
  });

  it("leaves document inputs untouched but still drops input_type", () => {
    // Documents are indexed bare; only the field llama-server does not know
    // about is removed.
    const out = JSON.parse(
      rewriteEmbeddingsBody(JSON.stringify({ model: "m", input: ["ping"], input_type: "document" })),
    );
    expect(out).toEqual({ model: "m", input: ["ping"] });
  });

  it("returns a body with no input_type byte-for-byte", () => {
    const raw = '{"model":"m","input":["x"],"dimensions":1024}';
    expect(rewriteEmbeddingsBody(raw)).toBe(raw);
  });

  it("handles a bare string input the same way as an array", () => {
    const out = JSON.parse(rewriteEmbeddingsBody(JSON.stringify({ input: "q", input_type: "query" })));
    expect(out.input).toBe(applyQueryInstruction("q"));
  });

  it("leaves non-string array items alone", () => {
    // Token-id arrays are legal OpenAI input; prefixing them is meaningless.
    const out = JSON.parse(
      rewriteEmbeddingsBody(JSON.stringify({ input: [[1, 2, 3], "q"], input_type: "query" })),
    );
    expect(out.input).toEqual([[1, 2, 3], applyQueryInstruction("q")]);
  });

  it("never refuses: malformed JSON and non-objects pass through", () => {
    for (const raw of ["not json", "[1,2]", "null", '"str"', ""]) {
      expect(rewriteEmbeddingsBody(raw)).toBe(raw);
    }
  });

  it("keeps every other field the client sent", () => {
    const out = JSON.parse(
      rewriteEmbeddingsBody(
        JSON.stringify({ model: "m", input: ["q"], input_type: "query", dimensions: 1024, user: "u" }),
      ),
    );
    expect(out.dimensions).toBe(1024);
    expect(out.user).toBe("u");
  });
});

describe("isEmbeddingsPath", () => {
  it("matches the OpenAI path with and without the version segment", () => {
    expect(isEmbeddingsPath(["v1", "embeddings"])).toBe(true);
    expect(isEmbeddingsPath(["embeddings"])).toBe(true);
  });

  it("does not match models, health or chat", () => {
    expect(isEmbeddingsPath(["v1", "models"])).toBe(false);
    expect(isEmbeddingsPath(["health"])).toBe(false);
    expect(isEmbeddingsPath(["v1", "chat", "completions"])).toBe(false);
    expect(isEmbeddingsPath([])).toBe(false);
  });
});
