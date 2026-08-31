/**
 * The TypeScript mirror of `config/clawbox-resource-limits.env` (TASK-455).
 *
 * That file is the single source of truth — it is what the shell scripts read
 * at runtime, and it is where the measurement behind each number is written
 * down. This module exists because the API and Settings UI have to be able to
 * SAY what the limits are ("Ollama is capped at 5G") without shelling out, and
 * because a bundled Next.js standalone build does not ship `config/`.
 *
 * The two are pinned together by `src/tests/unit/resource-limits.test.ts`,
 * which parses the env file and asserts every value here matches. Changing a
 * number in one place and not the other fails CI — which is the whole point of
 * having a mirror rather than a second opinion.
 */

export interface ResourceLimits {
  /** Total physical RAM of the target device, MiB. Documentation only. */
  memTotalMiB: number;
  ollama: { memoryHigh: string; memoryMax: string };
  browser: { memoryHigh: string; memoryMax: string };
  desktop: { memoryHigh: string; memoryMax: string };
  ollamaNumParallel: number;
  ollamaContextLength: number;
}

export const RESOURCE_LIMITS: ResourceLimits = {
  memTotalMiB: 7607,
  ollama: { memoryHigh: "5G", memoryMax: "5632M" },
  browser: { memoryHigh: "1200M", memoryMax: "1536M" },
  desktop: { memoryHigh: "1400M", memoryMax: "2048M" },
  ollamaNumParallel: 2,
  ollamaContextLength: 4096,
};

/**
 * The largest Ollama model, in billions of parameters, the search offers to
 * pull. Derived from the cap above, not from the box's 8 GB: the env file
 * records that a 7-8B Q4 model (~5,400 MiB projected, plus KV cache for
 * `ollamaNumParallel` slots) does NOT fit under `ollama.memoryMax`, so
 * offering one only turns into a pull that is OOM-killed on first load. The
 * next size class down (3-4B) does fit with room for the desktop.
 */
export const OLLAMA_MAX_MODEL_PARAM_B = 4;

/** The env-file key each mirrored value is pinned to. */
export const RESOURCE_LIMIT_KEYS: Record<string, string | number> = {
  CLAWBOX_MEM_TOTAL_MIB: RESOURCE_LIMITS.memTotalMiB,
  CLAWBOX_OLLAMA_MEMORY_HIGH: RESOURCE_LIMITS.ollama.memoryHigh,
  CLAWBOX_OLLAMA_MEMORY_MAX: RESOURCE_LIMITS.ollama.memoryMax,
  CLAWBOX_BROWSER_MEMORY_HIGH: RESOURCE_LIMITS.browser.memoryHigh,
  CLAWBOX_BROWSER_MEMORY_MAX: RESOURCE_LIMITS.browser.memoryMax,
  CLAWBOX_DESKTOP_MEMORY_HIGH: RESOURCE_LIMITS.desktop.memoryHigh,
  CLAWBOX_DESKTOP_MEMORY_MAX: RESOURCE_LIMITS.desktop.memoryMax,
  CLAWBOX_OLLAMA_NUM_PARALLEL: RESOURCE_LIMITS.ollamaNumParallel,
  CLAWBOX_OLLAMA_CONTEXT_LENGTH: RESOURCE_LIMITS.ollamaContextLength,
};

/** systemd size suffixes, as bytes. `K` is 1024 here, matching systemd. */
const SUFFIXES: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/**
 * Parse a systemd memory size ("5G", "1200M", "512") into bytes, or null when
 * it is not one. Used by the tests and by the status route, which reports the
 * limits in a shape the UI can format.
 */
export function parseSystemdSize(value: string): number | null {
  const m = /^(\d+)([KMGT]?)$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] ? n * SUFFIXES[m[2]] : n;
}
