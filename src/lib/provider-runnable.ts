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
// flag plus one fork per backoff window. The count read here is recorded by an
// enumeration the catalog route was ALREADY going to run — its boot warmup, or
// a picker open — and that route's freshness and backoff rules are untouched by
// it. This module only reads the file that route writes.
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
 *
 * Resolved per call, and null rather than thrown when there is no data
 * directory to resolve it against. A module-level `path.join` on an undefined
 * root throws AT IMPORT, which would take down every route that transitively
 * imports the Providers strip — the opposite of what a file whose absence is
 * supposed to mean "we do not know" may do.
 */
function recordPath(): string | null {
  return DATA_DIR ? path.join(DATA_DIR, "catalog-cache", "_enumerations.json") : null;
}

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
  const file = recordPath();
  if (!file) return {};
  try {
    const parsed = JSON.parse(await fsp.readFile(file, "utf8")) as RecordFile;
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
    const file = recordPath();
    if (!file) return;
    const providers = await readRecordFile();
    fn(providers);
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify({ providers }), "utf8");
    await fsp.rename(tmp, file);
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
 * Forget one provider's count, because the BOX changed under it.
 *
 * Called from `notifyProviderSetChanged` — a key pasted, a plugin switched on,
 * a plan changed — where the number stops describing anything before the next
 * enumeration can say what replaced it. Nothing is started here: the row simply
 * goes back to `unknown` and is shown.
 */
export function forgetProviderEnumeration(provider: string): Promise<void> {
  return mutate((providers) => {
    delete providers[provider];
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
 * How long a recorded count is still a fact about this box.
 *
 * The catalog route's own freshness interval, and the same argument: past it,
 * the enumeration behind the number is old enough that the route would re-ask
 * before serving it. It matters most in one direction — a row hidden by a
 * count nothing has refreshed since comes BACK rather than staying gone, and
 * the picker open that follows is what re-enumerates it. Every other path that
 * brings a row back is an event (`notifyProviderSetChanged`, a `models.mode`
 * flip); this is the one that needs no event at all.
 */
const RECORD_TTL_MS = 6 * 60 * 60_000;

/**
 * The verdict for every provider the box has a CURRENT answer for.
 *
 * One file read per call, deliberately not memoised: the callers are a
 * 30-second status poll and a picker load, and a cached verdict would keep a
 * hidden row hidden after the enumeration that brings it back.
 */
export async function readProviderRunnable(): Promise<Map<string, ProviderRunnable>> {
  const providers = await readRecordFile();
  const verdicts = new Map<string, ProviderRunnable>();
  const now = Date.now();
  for (const [provider, record] of Object.entries(providers)) {
    if (typeof record?.models !== "number" || !Number.isFinite(record.models)) continue;
    // A clock that jumped backwards makes `now - atMs` negative, which is not
    // "expired" — an unusable stamp is treated as expired instead, the side
    // that shows the row.
    const ageMs = typeof record.atMs === "number" && Number.isFinite(record.atMs)
      ? now - record.atMs
      : Number.POSITIVE_INFINITY;
    if (ageMs > RECORD_TTL_MS) continue;
    verdicts.set(provider, record.models > 0 ? "some" : "none");
  }
  return verdicts;
}
