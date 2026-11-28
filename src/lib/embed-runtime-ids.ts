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

// ─── the local models an owner can pick (TASK-2411) ─────────────────────────
//
// The embedder above is the DEFAULT slot: its file, repo and alias can still
// be moved by the EMBED_* lines in .env, exactly as before. The catalog below
// is the closed list the owner picks from in Settings → Local AI and Memory
// Shard. Every reader — this module, scripts/embed-model-select.sh (the unit's
// start script, ensure-local-embeddings.sh and install.sh's embed_model step)
// — maps an id to a file through THIS table and nothing else, so a value in
// data/config.json can never name a path or a repository of its own.
// src/tests/unit/local-embedding-models.test.ts pins the bash copy to it.

export type LocalEmbeddingModelId = "qwen3-embedding-0.6b" | "qwen3-embedding-4b";
export type LocalEmbeddingQuant = "Q8_0" | "Q4_K_M";

export interface LocalEmbeddingVariant {
  quant: LocalEmbeddingQuant;
  file: string;
  /** Exactly as the Hub lists it: the disk check and the progress bar use it. */
  bytes: number;
  /** The Hub's LFS sha256: a download is verified against it before it is used. */
  sha256: string;
}

export interface LocalEmbeddingModelSpec {
  id: LocalEmbeddingModelId;
  /** The model's own name, for the picker. */
  label: string;
  hfRepo: string;
  /** Vector width: the index's memory budget and its identity both use it. */
  dimensions: number;
  license: "Apache-2.0";
  /** Best first: the gate picks the first one the hardware can hold. */
  variants: readonly LocalEmbeddingVariant[];
}

export const DEFAULT_LOCAL_EMBEDDING_MODEL_ID: LocalEmbeddingModelId = "qwen3-embedding-0.6b";

export const LOCAL_EMBEDDING_MODELS: readonly LocalEmbeddingModelSpec[] = [
  {
    id: "qwen3-embedding-0.6b",
    label: "Qwen3-Embedding-0.6B",
    hfRepo: "Qwen/Qwen3-Embedding-0.6B-GGUF",
    dimensions: 1024,
    license: "Apache-2.0",
    variants: [
      {
        quant: "Q8_0",
        file: "Qwen3-Embedding-0.6B-Q8_0.gguf",
        bytes: 639_150_592,
        sha256: "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
      },
    ],
  },
  {
    id: "qwen3-embedding-4b",
    label: "Qwen3-Embedding-4B",
    hfRepo: "Qwen/Qwen3-Embedding-4B-GGUF",
    dimensions: 2560,
    license: "Apache-2.0",
    variants: [
      {
        quant: "Q8_0",
        file: "Qwen3-Embedding-4B-Q8_0.gguf",
        bytes: 4_279_660_224,
        sha256: "b60ae5ce2dd6a0b77f82cadf21def1f310a3e10cde380ad0081b07a9d416949d",
      },
      {
        quant: "Q4_K_M",
        file: "Qwen3-Embedding-4B-Q4_K_M.gguf",
        bytes: 2_496_703_776,
        sha256: "2b0cf8f17b4c723c27303015383c27ec4bf2d8314bb677d05e920dd70bb0f16b",
      },
    ],
  },
];

export function isLocalEmbeddingModelId(value: unknown): value is LocalEmbeddingModelId {
  return LOCAL_EMBEDDING_MODELS.some((m) => m.id === value);
}

export function localEmbeddingModelSpec(id: LocalEmbeddingModelId): LocalEmbeddingModelSpec {
  return LOCAL_EMBEDDING_MODELS.find((m) => m.id === id) ?? LOCAL_EMBEDDING_MODELS[0];
}

/** The variant of a model at `quant`, or its first when it has no such quant. */
export function localEmbeddingVariant(id: LocalEmbeddingModelId, quant?: string | null): LocalEmbeddingVariant {
  const spec = localEmbeddingModelSpec(id);
  return spec.variants.find((v) => v.quant === quant) ?? spec.variants[0];
}

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
