/**
 * The qwen3 query-instruction prefix, preserved on the llama.cpp path.
 *
 * OpenClaw's ollama embedding adapter prepends an instruction to every SEARCH
 * query before embedding it — Qwen3-Embedding is an asymmetric model, trained
 * to see "Instruct: …\nQuery:" on the query side and bare text on the document
 * side — and applies nothing to documents. Its `openai-compatible` adapter, the
 * one that can reach a bare llama-server, applies no template at all: the
 * prefix lives only inside the ollama extension bundle
 * (dist/embedding-provider.runtime-*.js, QUERY_INSTRUCTION_TEMPLATES). Moving
 * the embedder off ollama without this would quietly degrade recall on every
 * box while the index stayed "healthy".
 *
 * What that client DOES send is `input_type`, whenever
 * memory.search.queryInputType / documentInputType are configured — ClawBox
 * writes "query" and "document". So the proxy can restore the template on the
 * way through: query inputs get the prefix, everything else passes untouched,
 * and `input_type` itself is dropped because llama-server has no such field
 * and this is exactly the kind of unknown key a stricter build would 400.
 *
 * The template is byte-for-byte OpenClaw's own, so a box migrated from ollama
 * embeds its queries exactly as it did before.
 */

export const QWEN3_QUERY_INSTRUCTION =
  "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:";

export function applyQueryInstruction(text: string): string {
  return `${QWEN3_QUERY_INSTRUCTION}${text}`;
}

/** `/v1/embeddings` (what OpenClaw calls) or bare `/embeddings`. */
export function isEmbeddingsPath(pathSegments: readonly string[]): boolean {
  const segments = pathSegments[0] === "v1" ? pathSegments.slice(1) : pathSegments;
  return segments.length === 1 && segments[0] === "embeddings";
}

/**
 * Rewrite one embeddings request body for llama-server.
 *
 * Never refuses. A body that is not a JSON object, or carries no
 * `input_type`, is returned byte-for-byte: the model answering an unprefixed
 * query beats no answer, and the proxy is not the place to validate what
 * OpenClaw sends. Only a body that names its input type is re-serialised.
 */
export function rewriteEmbeddingsBody(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
  const body = parsed as Record<string, unknown>;
  if (!("input_type" in body)) return raw;

  const { input_type: inputType, ...rest } = body;
  if (inputType !== "query") return JSON.stringify(rest);

  const input = rest.input;
  if (typeof input === "string") {
    rest.input = applyQueryInstruction(input);
  } else if (Array.isArray(input)) {
    rest.input = input.map((item) => (typeof item === "string" ? applyQueryInstruction(item) : item));
  }
  return JSON.stringify(rest);
}
