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
 * What the mtime key does NOT cover is a read that never completed. A timeout
 * or a missing binary produces no answer about the key, and storing "" for it
 * against the current mtime remembers a failed QUESTION as a negative ANSWER —
 * permanently, because on a linked, stable box nothing rewrites config.yaml
 * again. Those are held for a short backoff instead (see `FAILED_READ_TTL_MS`).
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

/**
 * How long a read that never COMPLETED is remembered before we ask again.
 *
 * A timeout, a missing binary or a child we had to SIGKILL is not an answer
 * about the key — it is the question failing — so it must not be stored against
 * config.yaml's mtime the way an answer is. But forgetting it outright would
 * turn a hanging `hermes` into one ~800 ms Python start per request, which is
 * the exact cost this module exists to avoid, so it is held briefly and then
 * re-asked. Matches `PROBE_TTL_FAIL_MS` next door in `harness/clawai-images`.
 */
const FAILED_READ_TTL_MS = 60_000;

/**
 * `expiresAt` is `Infinity` for an answer and a near-future stamp for a failed
 * read. An answer needs no timer: config.yaml's mtime is a complete invalidator
 * for it, because writing that file is the only thing that can change it.
 */
type Entry = { mtimeMs: number; value: string; expiresAt: number };
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
    if (hit && hit.mtimeMs === mtime && Date.now() < hit.expiresAt) return hit.value;
  }
  let value = "";
  // Did the CLI ANSWER the question, or did the question fail? Verified on the
  // live box: an unset key exits 1 with `Config key not set: <key>` on stderr,
  // so a non-zero exit is the CLI saying "nothing is configured there" — an
  // answer, and one the mtime correctly invalidates. A child that closed with
  // no exit code at all was killed by a signal (OOM on a loaded Jetson) and
  // told us nothing; `runHermesCli` rejects on a timeout, a missing binary and
  // its own SIGKILL, which likewise tell us nothing about the key.
  let answered = false;
  try {
    const r = await runHermesCli(["config", "get", key], { timeoutMs });
    answered = typeof r.code === "number";
    if (r.code === 0) value = r.stdout.trim();
  } catch {
    // hermes missing or timed out — fall through with "", uncached.
  }
  // Only cache against a real mtime. With no config file there is nothing to
  // invalidate against, so we would never notice the first write.
  //
  // A failed read is held only for FAILED_READ_TTL_MS. Storing it the way an
  // answer is stored was the bug: on a linked box config.yaml is never written
  // again, so one slow moment removed the composer's attach button — and the
  // image tools the agent advertises — until the web server restarted.
  if (mtime !== null) {
    cache.set(key, {
      mtimeMs: mtime,
      value,
      expiresAt: answered ? Number.POSITIVE_INFINITY : Date.now() + FAILED_READ_TTL_MS,
    });
  }
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
