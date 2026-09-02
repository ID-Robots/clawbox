/**
 * Memory Shard's server side: the owner's switch, the folders they added, and
 * the one thing nothing in ClawBox could do before — point the memory index at
 * the embedding model running on this box.
 *
 * SERVER ONLY. It drives the OpenClaw CLI, so a client component must import
 * `@/lib/memory-shard-state` instead (types and constants), never this.
 */

import { get as configGet, set as configSet } from "@/lib/config-store";
import { readConfig, runOpenclawConfigSetBatch } from "@/lib/openclaw-config";
import {
  EXTRA_PATHS_CONFIG_PATH,
  LOCAL_EMBEDDING_MODEL,
  MEMORY_SHARD_ENABLED_KEY,
  MEMORY_SHARD_SETUP_KEY,
  type MemorySource,
} from "@/lib/memory-shard-state";

/** The owner's consent for the index to run. Off on a new box. */
export async function getMemoryShardEnabled(): Promise<boolean> {
  return (await configGet(MEMORY_SHARD_ENABLED_KEY)) === true;
}

export async function setMemoryShardEnabled(on: boolean): Promise<boolean> {
  await configSet(MEMORY_SHARD_ENABLED_KEY, on);
  return on;
}

/**
 * Has the owner been through the wizard?
 *
 * Same shape as the coding agent's flag, including the reason an EXPLICIT value
 * wins over the fallback: the wizard switches the feature on at its provisioning
 * step so the final "Index now" has something to run, and a rule of
 * `flag || enabled` would then declare setup finished mid-wizard and swap the
 * last step for the home page.
 */
export async function getMemoryShardSetupComplete(): Promise<boolean> {
  const flag = await configGet(MEMORY_SHARD_SETUP_KEY);
  if (typeof flag === "boolean") return flag;
  // A box that was already indexing before this wizard existed has been set up
  // by definition; it must not be dragged through onboarding by an update.
  return (await configGet(MEMORY_SHARD_ENABLED_KEY)) === true;
}

export async function setMemoryShardSetupComplete(done: boolean): Promise<boolean> {
  await configSet(MEMORY_SHARD_SETUP_KEY, done);
  return done;
}

/**
 * The folders the owner added, read from OpenClaw's own config.
 *
 * `memory.search.extraPaths` is OpenClaw's supported way to widen the index, and
 * it is already what the status probe counts — so this is a READ of the thing
 * that actually governs indexing, not a ClawBox-side mirror that could drift
 * away from it.
 *
 * Each entry is `string | { path, pattern? }`; ClawBox writes the object form
 * when it has extra facts to carry (a derived folder of extracted Markdown and
 * the folder of documents it came from).
 */
export async function readExtraPaths(): Promise<string[]> {
  try {
    const config = await readConfig();
    const search = (config as Record<string, unknown>)?.memory as { search?: { extraPaths?: unknown } } | undefined;
    const raw = search?.search?.extraPaths;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry) => (typeof entry === "string" ? entry : (entry as { path?: unknown })?.path))
      .filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  } catch {
    // An unreadable config is "no extra folders", not a crash: the wizard has
    // to be able to open on a box whose gateway config is mid-write.
    return [];
  }
}

/** Replace the whole list. OpenClaw validates the shape on write. */
export async function writeExtraPaths(paths: readonly string[]): Promise<void> {
  await runOpenclawConfigSetBatch([
    [EXTRA_PATHS_CONFIG_PATH, JSON.stringify([...paths]), "--json"],
  ]);
}

/**
 * Point the memory index at the model running on this box.
 *
 * Named `switchTo...` rather than `use...`: the `use` prefix is reserved for
 * React hooks and the lint rule reads any such call as one.
 *
 * This is the gap the design surfaced: `agents.defaults.memorySearch` had no
 * route and no TypeScript caller anywhere in the product — only
 * scripts/ensure-local-embeddings.sh wrote it, at boot, and on this box it had
 * failed six times in a row. So nothing the owner could click could move memory
 * off the cloud embedder, which is why the panel says "Cloud" while the wizard
 * offers a local one.
 *
 * Written as ONE batch: the CLI costs ~8 s of start-up per invocation on a
 * Jetson, and a batch is a single validated read-modify-write rather than two
 * that can interleave.
 */
export async function switchToLocalEmbeddings(): Promise<void> {
  await runOpenclawConfigSetBatch([
    ["agents.defaults.memorySearch.provider", "ollama"],
    ["agents.defaults.memorySearch.model", LOCAL_EMBEDDING_MODEL],
  ]);
}

/** Describe the sources for the app, pairing derived folders with their origin. */
export function describeSources(paths: readonly string[], derived: Record<string, string>): MemorySource[] {
  return paths.map((path) => (derived[path] ? { path, derivedFrom: derived[path] } : { path }));
}
