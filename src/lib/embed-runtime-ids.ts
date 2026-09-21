/**
 * The memory embedder's names and numbers, with no imports.
 *
 * Split out of embed-server.ts so that the inventory (local-models.ts), the
 * status parser (clawkeep-memory.ts) and their tests can name the unit, the
 * alias and the argv rule without pulling in the runtime module — which reads
 * the config store's DATA_DIR at import and is mocked away wholesale by the
 * tests that fake /proc. Same discipline as file-guard.ts: the alias-free end
 * of the import graph owns the literals.
 *
 * Every value here is mirrored by `scripts/start-embed-server.sh` as an
 * environment default; `src/tests/unit/embed-server-pin.test.ts` pins the two.
 */

export const EMBED_UNIT = "clawbox-embed.service";

/** llama-server's `--alias`, and the `model` OpenClaw sends — never a file name. */
export const EMBED_MODEL_ALIAS = "qwen3-embedding-0.6b";
export const EMBED_HF_REPO = "Qwen/Qwen3-Embedding-0.6B-GGUF";
export const EMBED_HF_FILE = "Qwen3-Embedding-0.6B-Q8_0.gguf";
/** The Q8_0 GGUF, for the Local AI page's disk figure before it is on disk. */
export const EMBED_MODEL_BYTES = 639_000_000;

/**
 * -c, -b and -ub, as one number. Pooled embeddings need the whole sequence in
 * a single physical batch, and the batch is what sizes the compute buffer
 * (n_ubatch × n_vocab × 4 B — measured 0.6 MB per token on this build).
 * 512 is the floor below which measured documents fail; 1024 keeps twice the
 * headroom over the largest real input and leaves the rare longer one to the
 * proxy's fit guard (embed-input-fit.ts) rather than to a hard failure.
 */
export const DEFAULT_EMBED_BATCH = 1024;
export const MIN_EMBED_BATCH = 512;

export const DEFAULT_EMBED_BASE_URL = "http://127.0.0.1:8081/v1";

/** The data/ subtree; mirrored as a literal in file-guard.ts (see its import rule). */
export const EMBED_RUNTIME_SUBDIR = "embed";

/**
 * Is argv[0] llama.cpp's server? Basename only — the binary is shared with the
 * Gemma instance and with ollama's bundled copy of the same name, which is why
 * every caller pairs this with `isEmbeddingServerArgv` or with
 * local-models.ts's `OLLAMA_OWNED_PROCESS` exclusion.
 */
export function isLlamaServerExecutable(argv0: string | undefined): boolean {
  if (!argv0) return false;
  const base = argv0.replace(/ \(deleted\)$/, "").split("/").at(-1);
  return base === "llama-server";
}

/** The one flag only the embedder's llama-server carries. */
export function isEmbeddingServerArgv(argv: readonly string[]): boolean {
  return argv.includes("--embedding") || argv.includes("--embeddings");
}

/**
 * Is this URL the box itself? Decides whether an `openai-compatible`
 * embedding provider counts as "on this box" for Memory Shard and the Local
 * AI page: OpenClaw's status reports the provider id but never the URL, and
 * an owner may legitimately point that same provider id at a server across
 * the room. Only a loopback host is ours.
 */
export function isLoopbackBaseUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}
