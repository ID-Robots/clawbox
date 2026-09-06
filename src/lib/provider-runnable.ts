// "Can this box run any model from provider X?" — answered from what the box
// has already been told, and from nothing else.
//
// WHY IT EXISTS (TASK-668). `models.mode: "replace"` — which a local-model save
// at primary scope writes — makes the core skip the authenticated catalogue for
// EVERY provider. Measured on a box, `openclaw models list --provider <p> --all
// --json | jq .count` before and after the flip: anthropic 15 -> 9, openai
// 30 -> 2, google 10 -> **0**. A provider at zero is not "not connected yet":
// there is no model to pick, so a Providers row for it offers a key entry whose
// only outcome is a picker the gateway refuses. The owner's ruling is to hide
// such a row, and to keep it exactly as today for a box that can run at least
// one of that provider's models.
//
// WHAT THIS MODULE MAY NOT DO. It never probes and never forks. `openclaw
// models list` costs about three minutes on a Jetson, and the whole reason the
// obvious version of this fix was refused is that it bought a permanent `stale`
// flag plus one fork per backoff window. The count read here is recorded by the
// enumeration the catalog route ALREADY runs (boot warmup, a picker open, the
// six-hour interval); this module only reads the file that route writes.
//
// THE ONE RULE. Only a definite count decides anything. No record, an
// unreadable record, a record for another provider — all of that is UNKNOWN,
// and unknown keeps the row. Hiding a provider on an answer nobody gave is the
// false failure this codebase keeps producing, and it would delete a working
// provider from the only screen that can fix it.

import { promises as fsp } from "fs";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";

/**
 * Beside the catalogues it is derived from, and named so it can never collide
 * with a `<provider>.json`: no provider id may start with an underscore
 * (`CATALOG_PROVIDERS` is the closed set the route validates against).
 *
 * Counts and provider ids only — the directory is public-servable
 * (`DATA_DIR_PUBLIC_SUBTREES`), and nothing here is a credential.
 */
const RECORD_PATH = path.join(DATA_DIR, "catalog-cache", "_enumerations.json");

/** What the last enumeration for a provider answered. */
interface EnumerationRecord {
  /** How many models the box listed. Zero is an ANSWER, not a failure. */
  models: number;
  atMs: number;
}

interface RecordFile {
  providers?: Record<string, EnumerationRecord>;
}

/**
 * How many models this box can run for a provider, as far as it knows.
 *
 *  * `some`    — an enumeration answered with rows.
 *  * `none`    — an enumeration answered with nothing. The row is hidden.
 *  * `unknown` — nobody has asked, or the answer could not be read. The row
 *                stays, unchanged from beta.
 */
export type ProviderRunnable = "some" | "none" | "unknown";

/**
 * Writes are serialised through this chain.
 *
 * Two refreshes can finish within the same tick (the main enumeration and the
 * subscription-surface one), and a read-modify-write pair interleaved with
 * another would drop the loser's provider. One Next process owns this file —
 * the catalog route is its only writer — so an in-process chain is the whole
 * of the problem; there is no second writer to lock against.
 */
let writeChain: Promise<void> = Promise.resolve();

async function readRecordFile(): Promise<Record<string, EnumerationRecord>> {
  try {
    const parsed = JSON.parse(await fsp.readFile(RECORD_PATH, "utf8")) as RecordFile;
    const providers = parsed?.providers;
    if (!providers || typeof providers !== "object") return {};
    return providers;
  } catch {
    // Absent, unreadable, half-written, hand-edited to nonsense: all of them
    // are "we do not know", and the caller's default is to show every row.
    return {};
  }
}

async function mutate(fn: (providers: Record<string, EnumerationRecord>) => void): Promise<void> {
  const next = writeChain.then(async () => {
    const providers = await readRecordFile();
    fn(providers);
    const tmp = `${RECORD_PATH}.${process.pid}.tmp`;
    await fsp.mkdir(path.dirname(RECORD_PATH), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify({ providers }), "utf8");
    await fsp.rename(tmp, RECORD_PATH);
  }).catch((err: unknown) => {
    // A record we could not write costs a row that stays visible, which is the
    // safe direction. It must never take the refresh that produced it down.
    console.warn(
      "[provider-runnable] could not record the enumeration:",
      err instanceof Error ? err.message : err,
    );
  });
  writeChain = next;
  return next;
}

/**
 * Record what an enumeration answered for `provider`.
 *
 * Called by the catalog route only, and only for an answer the CLI actually
 * gave: a refusal, a timeout, or a payload whose rows were all filtered out by
 * our own chat-model rule is NOT an answer and must not reach here.
 */
export function recordProviderEnumeration(provider: string, models: number): Promise<void> {
  return mutate((providers) => {
    providers[provider] = { models: Math.max(0, Math.trunc(models)), atMs: Date.now() };
  });
}

/**
 * Forget every recorded count.
 *
 * `models.mode` decides what a catalogue MEANS — under `replace` the core
 * skips the authenticated rows for every provider at once — so a flip
 * invalidates every count taken under the old mode. Forgetting is the whole
 * response: every row comes straight back (`unknown` shows), nothing is
 * re-enumerated, and the next refresh that happens for its own reasons records
 * the new truth. Marking the catalogues behind-generation instead is what the
 * owner refused: it buys a fork per provider, three minutes each.
 */
export function forgetProviderEnumerations(): Promise<void> {
  return mutate((providers) => {
    for (const key of Object.keys(providers)) delete providers[key];
  });
}

/**
 * The verdict for every provider the box has an answer for.
 *
 * One file read per call, deliberately not memoised: the callers are a
 * 30-second status poll and a picker load, and a cached verdict would keep a
 * hidden row hidden after the enumeration that brings it back.
 */
export async function readProviderRunnable(): Promise<Map<string, ProviderRunnable>> {
  const providers = await readRecordFile();
  const verdicts = new Map<string, ProviderRunnable>();
  for (const [provider, record] of Object.entries(providers)) {
    if (typeof record?.models !== "number" || !Number.isFinite(record.models)) continue;
    verdicts.set(provider, record.models > 0 ? "some" : "none");
  }
  return verdicts;
}

/**
 * The verdict for one provider — `unknown` unless the box has a count for it.
 */
export async function providerRunnable(provider: string): Promise<ProviderRunnable> {
  return (await readProviderRunnable()).get(provider) ?? "unknown";
}
