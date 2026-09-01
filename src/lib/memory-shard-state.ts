/**
 * Memory Shard's own state: the owner's switch, the setup flag, and the shapes
 * the wizard and the app both read.
 *
 * Client-safe on purpose. `@/lib/clawkeep-memory` imports `node:child_process`
 * to drive the OpenClaw CLI, so a component that imported it for a type would
 * be fine (types erase) but one that imported a VALUE from it would pull
 * child_process into the browser bundle and fail the build outright. Same split
 * as coding-agent-status.ts and coding-pr-state.ts.
 */

/** The owner's consent for the index to run at all. Off on a new box. */
export const MEMORY_SHARD_ENABLED_KEY = "memory_shard_enabled";

/** False until the owner finishes the setup wizard. */
export const MEMORY_SHARD_SETUP_KEY = "memory_shard_setup_complete";

/**
 * A folder the owner added as a source, as the app sees it.
 *
 * `path` is what OpenClaw indexes. When `derivedFrom` is set, `path` is a
 * ClawBox-managed folder of extracted Markdown and `derivedFrom` is the folder
 * of PDFs and documents it was extracted from — the owner picked the latter and
 * should be shown it, not our scratch directory.
 */
export interface MemorySource {
  path: string;
  derivedFrom?: string;
  /** Files ClawBox converted into `path` on the last extraction. */
  extracted?: number;
  /** Files it could not read, so the owner is not told a folder is covered
   *  when part of it is not. */
  skipped?: number;
}

/** What the provisioning step is doing, for the status line under the spinner. */
export type ProvisionPhase =
  | "idle"
  | "checking"
  | "enabling-ollama"
  | "pulling-model"
  | "switching-provider"
  | "ready"
  | "failed";

export interface ProvisionState {
  phase: ProvisionPhase;
  /** 0..1 while pulling, null otherwise — Ollama's pull stream carries real
   *  completed/total bytes, so this is a true percentage, not a guess. */
  progress: number | null;
  /** One line the owner can act on. Never a raw stack. */
  detail: string | null;
}

/**
 * The local embedding model.
 *
 * Named here for the first time in TypeScript: it existed only in
 * scripts/ensure-local-embeddings.sh, so nothing the owner could click knew
 * what to pull. ~639 MB, 0.6B parameters — far under the ollama.service
 * ceiling in resource-limits.ts.
 */
export const LOCAL_EMBEDDING_MODEL = "qwen3-embedding:0.6b";

/** Roughly what the pull costs, for the sentence shown before it starts. */
export const LOCAL_EMBEDDING_BYTES = 639_000_000;

/** Where OpenClaw keeps the owner's extra folders. */
export const EXTRA_PATHS_CONFIG_PATH = "memory.search.extraPaths";

/** Documents ClawBox can turn into Markdown for the indexer. */
export const EXTRACTABLE_EXTENSIONS = [".pdf", ".docx", ".odt", ".rtf", ".txt"] as const;

/** What OpenClaw's indexer reads on its own. Everything else has to be
 *  extracted into one of these first — it accepts `.md` and nothing else. */
export const INDEXABLE_EXTENSIONS = [".md"] as const;
