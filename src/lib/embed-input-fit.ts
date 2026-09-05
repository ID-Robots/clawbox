/**
 * Keep every embedding input inside the batch the embedder runs with.
 *
 * llama-server in embedding mode needs a whole input in one physical batch:
 * anything longer than `-ub` is refused with "input is too large to process",
 * OpenClaw retries the 500 three times and then records the document as
 * failed — dropped from the index, silently, until the next full run. Ollama
 * never had this problem because it truncated (`truncate: true` is its
 * default) and ran a 2,048-token batch that cost 1.2 GB. The embedder runs a
 * 1,024-token batch (embed-server.ts) and this guard is what makes that safe:
 * an input that would not fit is trimmed to the head that does, so the
 * document is indexed by its opening rather than lost.
 *
 * It matters because OpenClaw chunks by CHARACTERS (400 "tokens" × 4), not by
 * the model's tokenizer. 1,600 characters of English is ~400 tokens; the same
 * length of JSON or code is ~550; of Japanese or Chinese it can be 1,600. The
 * measured maximum on an English box was 484 — the guard exists for the boxes
 * that are not.
 *
 * Cost: only inputs whose UTF-8 byte length exceeds the limit can overflow
 * (byte-level BPE never yields more tokens than bytes), so short inputs and
 * every query pass with no round trip; a long one costs one `/tokenize` call
 * against the already-awake server, and only a genuine overflow pays for a
 * `/detokenize`. The transport is injected so the arithmetic is unit-tested
 * without a server.
 */

export interface EmbedFitTransport {
  tokenize(text: string): Promise<number[]>;
  detokenize(tokens: number[]): Promise<string>;
}

/**
 * Tokens the server adds around the content (EOS, and BOS on some
 * templates), kept out of the budget so an input trimmed to exactly the limit
 * still fits after the server has had its say.
 */
export const EMBED_FIT_MARGIN = 8;

export interface EmbedFitResult {
  body: string;
  /** How many inputs were trimmed; 0 means `body` is the input byte-for-byte. */
  trimmed: number;
}

function couldExceed(text: string, limitTokens: number): boolean {
  return Buffer.byteLength(text, "utf8") > limitTokens;
}

async function fitOne(text: string, limitTokens: number, transport: EmbedFitTransport): Promise<string | null> {
  if (!couldExceed(text, limitTokens)) return null;
  const tokens = await transport.tokenize(text);
  if (tokens.length <= limitTokens) return null;
  return await transport.detokenize(tokens.slice(0, limitTokens));
}

/**
 * Trim every input in an embeddings request body that would overflow
 * `limitTokens`. Returns the body untouched — the same string — when nothing
 * needed trimming, when it is not a JSON object, or when it has no `input`.
 *
 * A tokenizer failure leaves that one input as it was: the server then
 * answers for it exactly as it would have without the guard, which is the
 * outcome the guard improves on, not one it must prevent at any cost.
 */
export async function fitEmbeddingInputs(
  raw: string,
  limitTokens: number,
  transport: EmbedFitTransport,
): Promise<EmbedFitResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { body: raw, trimmed: 0 };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { body: raw, trimmed: 0 };
  const body = parsed as Record<string, unknown>;
  const input = body.input;

  let trimmed = 0;
  const fit = async (item: unknown): Promise<unknown> => {
    if (typeof item !== "string") return item;
    try {
      const fitted = await fitOne(item, limitTokens, transport);
      if (fitted === null) return item;
      trimmed += 1;
      return fitted;
    } catch {
      return item;
    }
  };

  if (typeof input === "string") {
    body.input = await fit(input);
  } else if (Array.isArray(input)) {
    const out: unknown[] = [];
    for (const item of input) out.push(await fit(item));
    body.input = out;
  } else {
    return { body: raw, trimmed: 0 };
  }

  return trimmed === 0 ? { body: raw, trimmed: 0 } : { body: JSON.stringify(body), trimmed };
}

/**
 * The real transport: llama-server's `/tokenize` and `/detokenize`, which
 * live at the server root rather than under `/v1`. `add_special: false`
 * because the server adds its own specials when it embeds — counting them
 * here too would double the margin.
 */
export function createLlamaServerFitTransport(rootUrl: string, signal?: AbortSignal): EmbedFitTransport {
  const base = rootUrl.replace(/\/+$/, "");
  const post = async (path: string, payload: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: signal ?? AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`${path} answered HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  return {
    async tokenize(text) {
      const data = await post("/tokenize", { content: text, add_special: false, with_pieces: false });
      const tokens = data.tokens;
      if (!Array.isArray(tokens) || !tokens.every((t) => typeof t === "number")) {
        throw new Error("/tokenize answered without a tokens[] array");
      }
      return tokens as number[];
    },
    async detokenize(tokens) {
      const data = await post("/detokenize", { tokens });
      if (typeof data.content !== "string") throw new Error("/detokenize answered without content");
      return data.content;
    },
  };
}
