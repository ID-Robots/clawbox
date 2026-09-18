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

import type { CloudUnavailableReason } from "@/lib/clawai-cloud-defaults-state";

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
  | "pulling-model"
  | "switching-provider"
  | "ready"
  | "failed";

export interface ProvisionState {
  phase: ProvisionPhase;
  /** 0..1 while the download reports a percentage, null otherwise. */
  progress: number | null;
  /** One line the owner can act on. Never a raw stack. */
  detail: string | null;
}

/**
 * The local embedding model, as OpenClaw names it: llama-server's `--alias`
 * (config/clawbox-embed.service), sent as `model` in every request. Not a
 * file name and not an ollama tag — the model moved off ollama onto ClawBox's
 * own llama.cpp, where it costs ~2 GB while awake instead of 2.8 and nothing
 * while asleep. Keep in step with src/lib/embed-server.ts.
 */
export const LOCAL_EMBEDDING_MODEL = "qwen3-embedding-0.6b";

/** The OpenClaw provider id the embedder is reached through: its core
 *  OpenAI-compatible client, pointed at ClawBox's local-AI proxy. */
export const LOCAL_EMBEDDING_PROVIDER = "openai-compatible";

/**
 * How wide a vector the model on this box answers with.
 *
 * Qwen3-Embedding-0.6B is 1,024 dimensions. It is a CONSTANT here rather than a
 * number in a comment because the index's memory budget is a function of it —
 * `maxIndexChunks` in `memory-index-local.ts` — and the cloud model is three
 * times as wide. A width written in prose beside a ceiling derived from it is
 * how the ceiling came to be sized for a model the box had stopped using.
 */
export const LOCAL_EMBEDDING_DIMENSIONS = 1024;

/** The engine, for the sentences that name it ("Qwen 3 via llama.cpp"). */
export const LOCAL_EMBEDDING_ENGINE = "llama.cpp";

/** Roughly what the download costs, for the sentence shown before it starts. */
export const LOCAL_EMBEDDING_BYTES = 639_000_000;

/** Where OpenClaw keeps the owner's extra folders. */
export const EXTRA_PATHS_CONFIG_PATH = "memory.search.extraPaths";

/**
 * Where the SAME list lives on the edition that has no OpenClaw.
 *
 * Not a mirror of the line above — the two are never both in play. On OpenClaw
 * the list is read and written where the indexer reads it, which is
 * `memory.search.extraPaths`; on the Hermes SKU ClawBox is the indexer
 * (`src/lib/memory-index-local.ts`), so its own store is what governs. One
 * copy either way, and no box has two.
 */
export const MEMORY_SHARD_SOURCES_KEY = "memory_shard_sources";

/**
 * Where the index is embedded on that same edition: `"cloud"` | `"local"`.
 *
 * The counterpart of OpenClaw's `memory.search.provider`/`.remote.baseUrl`, for
 * the same reason the line above exists — the thing that INDEXES owns the
 * setting, and on this SKU that is ClawBox. A WORD and never an address: see
 * `src/lib/memory-embedder.ts`, which is the only reader and writer of it.
 *
 * Absent is not "local". Absent is "nobody has pinned this box", which the
 * cloud-defaults resolver answers — the cloud whenever the box's subscription
 * covers it (the owner's ruling of 2026-09-18).
 */
export const MEMORY_SHARD_EMBEDDER_KEY = "memory_shard_embedder";

/** Documents ClawBox can turn into Markdown for the indexer. */
export const EXTRACTABLE_EXTENSIONS = [".pdf", ".docx", ".odt", ".rtf", ".txt"] as const;

/** What OpenClaw's indexer reads on its own. Everything else has to be
 *  extracted into one of these first — it accepts `.md` and nothing else. */
export const INDEXABLE_EXTENSIONS = [".md"] as const;

/**
 * The folder list as a parsed config holds it.
 *
 * ONE parser, because there are two readers: OpenClaw's `memory.search.extraPaths`
 * (the live setting on that edition) and the one-time carry-over the other arm
 * does after a harness swap. Two copies of this drifted apart the moment
 * OpenClaw grew the object form, and the carry-over would have silently dropped
 * folders the live reader keeps.
 *
 * Each entry is `string | { path, pattern? }`; ClawBox writes the object form
 * when it has extra facts to carry (a derived folder of extracted Markdown and
 * the folder of documents it came from).
 */
export function extraPathsOf(config: unknown): string[] {
  const search = (config as Record<string, unknown>)?.memory as { search?: { extraPaths?: unknown } } | undefined;
  return stringList(search?.search?.extraPaths);
}

/** The strings in a value that should be a list of them, and nothing else. */
export function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (typeof entry === "string" ? entry : (entry as { path?: unknown })?.path))
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

/**
 * What the schedule routes accept as a time of day. The ONE copy: the home
 * card and the setup wizard both keep a half-typed value in the field and
 * save only a value this accepts — two regexes for one rule had already
 * drifted apart once (the wizard saved "" and the server quietly made it
 * 03:00).
 */
export const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Where the memory index is embedded: the ClawBox AI cloud, or the model on this box. */
export type EmbeddingSource = "cloud" | "local";

/** GET /setup-api/clawkeep/memory/provider: what the embedder switch draws from. */
export interface EmbedderChoiceStatus {
  /** Where the index is embedded right now. */
  source: EmbeddingSource;
  /**
   * …and whether that is WRITTEN DOWN, or is the default rule speaking.
   *
   * The half a caller cannot work out afterwards, and the one the wizard's last
   * step turns on: with no choice recorded the box already embeds in the cloud
   * wherever its subscription covers it, so a wizard that read `source: "cloud"`
   * as "nothing to do" finished without writing the pin — and the next boot's
   * automatic promotion then wrote it and rebuilt an index that was already
   * correct. False from a server that predates the field, which is the safe
   * direction: it makes the caller post.
   */
  recorded: boolean;
  /**
   * This box can point its memory index at the ClawBox AI cloud at all.
   *
   * True on every edition since 2026-09-18. It used to be false where ClawBox
   * itself is the indexer, because that client accepted only a loopback
   * endpoint; it now accepts exactly two — the loopback proxy and the ClawBox
   * AI endpoint the image was built with — so the fence is still a fence and
   * the owner's choice is the same one on both editions.
   */
  cloudSupported: boolean;
  /** Linked, on a paid ClawBox AI plan, and the cloud embedder answered this box. */
  cloudAvailable: boolean;
  /**
   * WHY the cloud model is not on offer, in the cloud-defaults resolver's own
   * vocabulary — each word has a different remedy, and the switch says which.
   *
   * Null when the cloud IS on offer, and also when the box could not work the
   * answer out at all (an older server, or a facts read that failed): a reason
   * is never guessed, and the generic note stands in.
   */
  cloudReason: CloudUnavailableReason | null;
  /** The model for this box is on disk. */
  localInstalled: boolean;
}

/**
 * The words {@link EmbedderChoiceStatus.cloudReason} may carry, for the parse
 * below. Typed against the resolver's union, so a word DROPPED from it stops
 * this file compiling; a word added to it falls through to the generic note,
 * which is the safe direction.
 */
const CLOUD_UNAVAILABLE_REASONS: readonly CloudUnavailableReason[] = [
  "not_linked",
  "plan",
  "route_unavailable",
  "edition",
  "owner",
];

/**
 * May the owner pick the ClawBox AI cloud model?
 *
 * THE ONE COPY: the wizard's step 3 and the settings card both ask it, and they
 * had drifted — the card exempted a box already indexing in the cloud and the
 * wizard did not, so a live probe that answered false (it is an HTTP request,
 * and false is what it answers on any hiccup) pre-selected a cloud box onto the
 * 640 MB model on this box and Index now posted the move.
 *
 * A box already ON the cloud can always stay there: nothing has to be reached
 * to keep an index where it is.
 */
export function cloudEmbedderPickable(status: EmbedderChoiceStatus): boolean {
  return status.source === "cloud" || (status.cloudSupported && status.cloudAvailable);
}

/**
 * The note under the switch when the cloud model cannot be picked: the REASON
 * and its remedy, rather than "not available on this box right now" — which is
 * what a box that had simply never been connected to ClawBox AI said, and read
 * as a fault of the box (owner, 2026-09-17).
 */
export function cloudUnavailableNoteKey(reason: CloudUnavailableReason | null): string {
  switch (reason) {
    case "not_linked":
      return "clawkeep.memory.embedder.cloudNotLinked";
    case "plan":
      return "clawkeep.memory.embedder.cloudPlan";
    case "route_unavailable":
      return "clawkeep.memory.embedder.cloudRouteDown";
    case "edition":
      return "clawkeep.memory.embedder.cloudUnsupported";
    // "owner" is not a refusal — the owner can always change their own pick
    // back — and null is "the box could not say". Both get the generic line.
    default:
      return "clawkeep.memory.embedder.cloudUnavailable";
  }
}

/**
 * Read a GET answer defensively. An older server answers 404, and a status
 * route that shares the path prefix answers something else entirely; neither
 * may be drawn as a choice.
 */
export function parseEmbedderChoiceStatus(raw: unknown): EmbedderChoiceStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.source !== "cloud" && r.source !== "local") return null;
  return {
    source: r.source,
    // An older server sends no such field, and `false` there is the direction
    // that costs nothing: the caller posts a choice that was already made
    // rather than skipping the one write that records it.
    recorded: r.recorded === true,
    cloudSupported: r.cloudSupported === true,
    cloudAvailable: r.cloudAvailable === true,
    // An older server sends no reason at all; null is the generic note.
    cloudReason: CLOUD_UNAVAILABLE_REASONS.find((reason) => reason === r.cloudReason) ?? null,
    localInstalled: r.localInstalled === true,
  };
}
