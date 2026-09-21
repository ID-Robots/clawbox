import { describe, expect, it, vi } from "vitest";
import {
  EMBED_FIT_MARGIN,
  createLlamaServerFitTransport,
  fitEmbeddingInputs,
  type EmbedFitTransport,
} from "@/lib/embed-input-fit";

/**
 * The embedder runs a 1,024-token batch and llama-server refuses any input
 * longer than that outright; OpenClaw chunks by characters, so CJK and code
 * chunks can be far more tokens than English ones of the same length. This
 * pins the proxy-side guard that trims an overflowing input to the head that
 * fits instead of letting the document drop out of the index.
 */

/** A fake tokenizer: one token per character, so lengths are easy to reason about. */
function charTokenizer(): EmbedFitTransport & { tokenizeCalls: string[]; detokenizeCalls: number[][] } {
  const tokenizeCalls: string[] = [];
  const detokenizeCalls: number[][] = [];
  return {
    tokenizeCalls,
    detokenizeCalls,
    async tokenize(text) {
      tokenizeCalls.push(text);
      return Array.from(text, (c) => c.codePointAt(0)!);
    },
    async detokenize(tokens) {
      detokenizeCalls.push(tokens);
      return String.fromCodePoint(...tokens);
    },
  };
}

describe("fitEmbeddingInputs", () => {
  it("returns the body byte-for-byte when every input already fits", async () => {
    const t = charTokenizer();
    const raw = JSON.stringify({ model: "m", input: ["short", "also short"] });
    const out = await fitEmbeddingInputs(raw, 100, t);
    expect(out).toEqual({ body: raw, trimmed: 0 });
    // Nothing that cannot overflow is ever tokenized: bytes ≤ limit is proof.
    expect(t.tokenizeCalls).toEqual([]);
  });

  it("only tokenizes inputs whose byte length could overflow, and leaves them when they do not", async () => {
    // 200 ASCII bytes with a limit of 100 tokens → must be checked. Under the
    // real tokenizer 200 English chars is ~50 tokens; here the fake makes it
    // 200, so use a two-bytes-per-token fake to model "long in bytes, short in
    // tokens".
    const t: EmbedFitTransport = {
      tokenize: vi.fn(async (text: string) => new Array(Math.ceil(text.length / 4)).fill(1)),
      detokenize: vi.fn(async () => "never"),
    };
    const raw = JSON.stringify({ input: ["x".repeat(200)] });
    const out = await fitEmbeddingInputs(raw, 100, t);
    expect(out.trimmed).toBe(0);
    expect(out.body).toBe(raw);
    expect(t.tokenize).toHaveBeenCalledTimes(1);
    expect(t.detokenize).not.toHaveBeenCalled();
  });

  it("trims a genuine overflow to the first `limit` tokens", async () => {
    const t = charTokenizer();
    const long = "a".repeat(150);
    const out = await fitEmbeddingInputs(JSON.stringify({ model: "m", input: ["ok", long] }), 100, t);
    expect(out.trimmed).toBe(1);
    const body = JSON.parse(out.body);
    expect(body.input[0]).toBe("ok");
    expect(body.input[1]).toBe("a".repeat(100));
    expect(body.model).toBe("m");
    expect(t.detokenizeCalls[0]).toHaveLength(100);
  });

  it("treats multi-byte text by its bytes, which is what bounds the token count", async () => {
    // 60 CJK characters are 180 UTF-8 bytes: over a 100-token limit in bytes,
    // and under the fake one-token-per-character tokenizer they fit — the
    // check runs, nothing is trimmed.
    const t = charTokenizer();
    const cjk = "記".repeat(60);
    const out = await fitEmbeddingInputs(JSON.stringify({ input: [cjk] }), 100, t);
    expect(out.trimmed).toBe(0);
    expect(t.tokenizeCalls).toHaveLength(1);
    // 120 of them are 360 bytes and 120 tokens: trimmed to 100.
    const out2 = await fitEmbeddingInputs(JSON.stringify({ input: ["記".repeat(120)] }), 100, t);
    expect(JSON.parse(out2.body).input[0]).toBe("記".repeat(100));
  });

  it("handles a bare string input", async () => {
    const t = charTokenizer();
    const out = await fitEmbeddingInputs(JSON.stringify({ input: "b".repeat(120) }), 100, t);
    expect(JSON.parse(out.body).input).toBe("b".repeat(100));
    expect(out.trimmed).toBe(1);
  });

  it("leaves an input alone when the tokenizer fails, rather than refusing the batch", async () => {
    const t: EmbedFitTransport = {
      tokenize: vi.fn(async () => {
        throw new Error("server hiccup");
      }),
      detokenize: vi.fn(),
    };
    const raw = JSON.stringify({ input: ["c".repeat(120)] });
    const out = await fitEmbeddingInputs(raw, 100, t);
    expect(out).toEqual({ body: raw, trimmed: 0 });
  });

  it("passes non-JSON, non-object and input-less bodies through untouched", async () => {
    const t = charTokenizer();
    for (const raw of ["nope", "[1]", "null", JSON.stringify({ model: "m" })]) {
      expect(await fitEmbeddingInputs(raw, 10, t)).toEqual({ body: raw, trimmed: 0 });
    }
    expect(t.tokenizeCalls).toEqual([]);
  });

  it("keeps a margin for the specials the server appends", () => {
    // The caller subtracts this from the batch; a limit equal to the batch
    // would trim to a length the server then pushes back over the edge.
    expect(EMBED_FIT_MARGIN).toBeGreaterThanOrEqual(2);
  });
});

describe("createLlamaServerFitTransport", () => {
  it("posts to /tokenize and /detokenize at the server root, without specials", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        if (url.endsWith("/tokenize")) return new Response(JSON.stringify({ tokens: [1, 2, 3] }), { status: 200 });
        return new Response(JSON.stringify({ content: "he" }), { status: 200 });
      }),
    );
    try {
      const t = createLlamaServerFitTransport("http://127.0.0.1:8081/");
      expect(await t.tokenize("hey")).toEqual([1, 2, 3]);
      expect(await t.detokenize([1, 2])).toBe("he");
      expect(calls[0].url).toBe("http://127.0.0.1:8081/tokenize");
      expect(calls[0].body).toEqual({ content: "hey", add_special: false, with_pieces: false });
      expect(calls[1].url).toBe("http://127.0.0.1:8081/detokenize");
      expect(calls[1].body).toEqual({ tokens: [1, 2] });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws on a non-2xx or a malformed answer, so the caller keeps the input as it was", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    try {
      const t = createLlamaServerFitTransport("http://127.0.0.1:8081");
      await expect(t.tokenize("x")).rejects.toThrow(/tokens/);
      await expect(t.detokenize([1])).rejects.toThrow(/content/);
    } finally {
      vi.unstubAllGlobals();
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    try {
      const t = createLlamaServerFitTransport("http://127.0.0.1:8081");
      await expect(t.tokenize("x")).rejects.toThrow(/503/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
