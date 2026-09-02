import fs from "fs/promises";
import path from "path";
import { runHermesCli } from "@/lib/hermes-cli";
import { hermesCliAnswered } from "@/lib/hermes-cli-answered";

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
export const FAILED_READ_TTL_MS = 60_000;

/**
 * `expiresAt` is `Infinity` for an answer and a near-future stamp for a failed
 * read. An answer needs no timer: config.yaml's mtime is a complete invalidator
 * for it, because writing that file is the only thing that can change it.
 *
 * `mtimeMs` is `null` for the one entry shape that can exist without a config
 * file: a failed read on a box that has none yet. Storing the absence as a key
 * value rather than skipping the cache keeps the comparison below total — the
 * first write to config.yaml turns `null` into a number and invalidates it, the
 * same way any other change to the file does.
 *
 * `value` is the in-flight PROMISE, not the settled string, and the entry is put
 * in the map BEFORE the CLI is awaited. That is the whole of the concurrency
 * story: callers here are concurrent rather than sequential — the capabilities
 * route asks two facts on every chat open with no route-level dedup, and
 * `readCurrentFromCli` issues three reads under one `Promise.all` — so a memo
 * that only wrote itself after the read settled shared nothing during the read.
 * With a wedged `hermes` every overlapping request then started its own Python
 * interpreter for the whole timeout before the backoff entry was ever written,
 * which is the exact fan-out the backoff exists to prevent. Same shape as
 * `harness/hermes-features`, which seeds with the backoff and stamps the real
 * expiry on afterwards.
 */
type Entry = { mtimeMs: number | null; value: Promise<string>; expiresAt: number };
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
  const hit = cache.get(key);
  if (hit && hit.mtimeMs === mtime && Date.now() < hit.expiresAt) return hit.value;

  // Seeded with the BACKOFF and published BEFORE the await, so every caller
  // that arrives while this read is running shares this one interpreter. The
  // real expiry is stamped on below, once we know whether we got an answer or
  // a failure. The entry is mutated in place rather than reassigned through
  // `cache`, so a later read that supersedes it cannot have its bookkeeping
  // undone by this one finishing late.
  const entry: Entry = {
    mtimeMs: mtime,
    value: Promise.resolve(""),
    expiresAt: Date.now() + FAILED_READ_TTL_MS,
  };
  cache.set(key, entry);
  entry.value = (async () => {
    let value = "";
    // Did the CLI ANSWER the question, or did the question fail? Verified on
    // the live box: an unset key exits 1 with `Config key not set: <key>` on
    // stderr, so a non-zero exit is the CLI saying "nothing is configured
    // there" — an answer, and one the mtime correctly invalidates. A child that
    // closed with no exit code at all was killed by a signal (OOM on a loaded
    // Jetson) and told us nothing, and a shim that exited 126/127 never reached
    // the CLI (see `hermesCliAnswered`); `runHermesCli` rejects on a timeout, a
    // missing binary and its own SIGKILL, which likewise tell us nothing.
    let answered = false;
    try {
      const r = await runHermesCli(["config", "get", key], { timeoutMs });
      answered = hermesCliAnswered(r);
      if (r.code === 0) value = r.stdout.trim();
    } catch {
      // hermes missing or timed out — fall through with "".
    }
    // An ANSWER is only KEPT against a real mtime. With no config file there is
    // nothing to invalidate against, so a `""` kept from before the box was set
    // up would outlive the first write and we would never notice it — the entry
    // is dropped instead, and only if it is still the live one, so a read that
    // superseded it mid-flight is not evicted by this one landing late.
    //
    // A FAILED read is kept either way, because its invalidator is the clock,
    // not the file — it is held for FAILED_READ_TTL_MS and then re-asked.
    // Storing it the way an answer is stored was the bug: on a linked box
    // config.yaml is never written again, so one slow moment removed the
    // composer's attach button — and the image tools the agent advertises —
    // until the web server restarted. Dropping it entirely on a box with no
    // config file is the mirror mistake: a hanging `hermes` would then start a
    // Python interpreter for every request, which is the cost this module
    // exists to avoid.
    if (!answered) {
      entry.expiresAt = Date.now() + FAILED_READ_TTL_MS;
    } else if (mtime === null) {
      if (cache.get(key) === entry) cache.delete(key);
    } else {
      entry.expiresAt = Number.POSITIVE_INFINITY;
    }
    return value;
  })();
  return entry.value;
}

/**
 * Was the last value served for `key` an ANSWER, or a placeholder?
 *
 * The two are the same `""` to a caller — deliberately, because every consumer
 * of this module fails closed — and that sameness is what stranded the browser.
 * `/setup-api/chat/capabilities` is fetched once on page load, so a `false`
 * computed from a read that merely timed out hid the composer's attach button
 * for the whole session while this module quietly recovered a minute later. The
 * page needs to know which of the two it was holding in order to come back for
 * the other, and this is the only place that knows.
 *
 * Reads the map WITHOUT touching it: a caller asking whether a fact is settled
 * must not itself start a `hermes`.
 */
export function hermesConfigReadPending(key: string): boolean {
  const hit = cache.get(key);
  // An answer is stamped `Infinity`. Anything finite is either a failure being
  // held for the backoff or a read still in flight — both are "ask me again".
  return hit !== undefined && hit.expiresAt !== Number.POSITIVE_INFINITY;
}

/** Read several keys at once. */
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
