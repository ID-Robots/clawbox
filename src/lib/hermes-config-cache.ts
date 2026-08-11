import fs from "fs/promises";
import path from "path";
import { runHermesCli } from "@/lib/hermes-cli";

/**
 * A memo around `hermes config get <key>`.
 *
 * Every one of those reads spawns a Python CLI and costs ~600 ms on this
 * hardware. Opening the chat or the Settings AI panel does several of them, so
 * the panel sat on a skeleton and the chat's provider list "took time" — all of
 * it waiting on answers that had not changed since the last time we asked.
 *
 * The cache is keyed on config.yaml's mtime rather than on a timer: `hermes
 * config set` rewrites that file, so an unchanged mtime is proof the stored
 * answer is still current — no staleness window to tune, and no risk of serving
 * a value the user just changed.
 *
 * Note the deliberate choice NOT to parse config.yaml ourselves. That was tried
 * and reverted: `^\s*(?:default|model)\s*:` matched the first `model:` anywhere
 * in the file, so it was order-dependent and wrong on some configs. The CLI is
 * the same store the dashboard reads and stays the source of truth; we only
 * avoid asking it the same question twice.
 */

const CONFIG_PATH = path.join(
  process.env.HERMES_HOME || path.join(process.env.HOME || "/home/clawbox", ".hermes"),
  "config.yaml",
);

type Entry = { mtimeMs: number; value: string };
const cache = new Map<string, Entry>();

/** mtime of config.yaml, or null when it doesn't exist yet (fresh device). */
async function configMtime(): Promise<number | null> {
  try {
    return (await fs.stat(CONFIG_PATH)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Read one config key, serving a cached answer while config.yaml is unchanged.
 * Returns "" on any failure, matching the callers' existing contract — a
 * missing hermes binary or an unset key are both "we don't know", not errors.
 */
export async function hermesConfigGet(key: string, timeoutMs = 10_000): Promise<string> {
  const mtime = await configMtime();
  if (mtime !== null) {
    const hit = cache.get(key);
    if (hit && hit.mtimeMs === mtime) return hit.value;
  }
  let value = "";
  try {
    const r = await runHermesCli(["config", "get", key], { timeoutMs });
    if (r.code === 0) value = r.stdout.trim();
  } catch {
    // hermes missing or timed out — fall through with "".
  }
  // Only cache against a real mtime. With no config file there is nothing to
  // invalidate against, so we would never notice the first write.
  if (mtime !== null) cache.set(key, { mtimeMs: mtime, value });
  return value;
}

/** Read several keys at once, sharing one stat and one mtime comparison. */
export async function hermesConfigGetMany(
  keys: string[],
  timeoutMs = 10_000,
): Promise<Record<string, string>> {
  const pairs = await Promise.all(
    keys.map(async (k) => [k, await hermesConfigGet(k, timeoutMs)] as const),
  );
  return Object.fromEntries(pairs);
}

/**
 * Forget everything. Only needed for a write that changes the config WITHOUT
 * touching config.yaml's mtime — which shouldn't happen, but a stale provider
 * in the chat header is a bad enough failure to be worth the belt and braces
 * after we apply a provider ourselves.
 */
export function invalidateHermesConfigCache(): void {
  cache.clear();
}
