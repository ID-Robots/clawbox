/**
 * Which AI providers have actually SERVED a turn on this box, and when.
 *
 * SERVER ONLY.
 *
 * WHAT THIS IS FOR. `credentialPresent` says a key is on disk. It does not say
 * the key works, and on a real box the two came apart: a provider with a
 * revoked key, a rate-limited subscription and a typo'd custom endpoint all
 * render exactly like a working one. The honest second field is `verified`, and
 * on every box measured it was null on all 48 rows — present in the shape,
 * never populated (TASK-583).
 *
 * WHY NOT A PROBE. Verifying by calling each provider is credential-bearing
 * traffic from a route the UI polls: latency on every render, a request per
 * provider per poll, bad behaviour on a box with no internet, and it can burn
 * the owner's own quota. That is why TASK-583 was split out of TASK-446 rather
 * than implemented as a probe, and its acceptance says so in as many words: no
 * verification traffic on any polled route.
 *
 * WHERE THE EVIDENCE COMES FROM INSTEAD. A COMPLETED TURN IS THE EXERCISE. The
 * chat route already learns who served each answer from the harness's own
 * billing record (`session_model_usage.billing_provider`, read once per turn by
 * `billedProviderFor`) — evidence that already exists, on the device, at zero
 * cost. This module is only the memory of that: the conclusion is cached here
 * so a polled route can read it without opening the agent's database on a page
 * load, which `hermes-turn-record.ts` documents as the thing not to do.
 *
 * WHAT IT COVERS, EXACTLY. A turn through ClawBox's OWN chat route, on the
 * dashboard transport, where the provider came from the harness's record or the
 * transport's own frame. NOT a Telegram or Discord turn, not `hermes chat` from
 * the Terminal, and not the CLI leg — whose provider can fall back to
 * `hermes config get model.provider`, which is what the box is CONFIGURED with
 * and no evidence at all. Hermes' `session_model_usage` does hold
 * `billing_provider` and `last_seen` for every one of those transports, and one
 * grouped query over it would cover them all; it is not read here because that
 * database must not be opened on a page load (`hermes-turn-record.ts` says why)
 * and because `last_seen`'s epoch and units have never been established on a
 * box. A row that has simply never been exercised through this route stays
 * null — "not checked" — which is the right answer for it.
 *
 * WHY A MARK EXPIRES ON A CREDENTIAL CHANGE, and not on a clock. "It answered
 * at 19:53" stays true for ever, and the timestamp travels with the flag so a
 * consumer can age it. What is NOT true for ever is that the CURRENT credential
 * works: rotate the key and the old turn says nothing about the new one. So
 * every ClawBox path that writes or replaces a provider's credential forgets
 * that provider's mark, and the row goes back to "not checked" — never to
 * "not connected", which is the third thing TASK-583's acceptance asks for.
 *
 * ClawBox is NOT the only writer, though, and pretending otherwise would be the
 * probe-once class: a key changed in Hermes' own dashboard, or with
 * `hermes auth add` from the Terminal, never passes through this process. So
 * every read also asks the harness's own pooled credential store when it was
 * last written (`~/.hermes/auth.json`, 0600, what `hermes auth add` rewrites)
 * and drops any mark older than that. It is deliberately coarse — one file for
 * every provider, so one key change forgets them all — because "not checked" is
 * always a safe answer and the next turn earns the mark straight back.
 *
 * SERVER ONLY.
 */
import fs from "fs";
import path from "path";
import { get, set } from "@/lib/config-store";
import { createSerialLock } from "@/lib/serial-lock";
import { HERMES_AUTO_PROVIDER, isPlausibleHermesProviderId } from "@/lib/hermes-providers";

/** The config-store key. A map of provider id → ISO 8601 instant. */
export const PROVIDER_VERIFIED_KEY = "provider_verified_at";

/**
 * How many providers are remembered. A box has tens of providers, not
 * thousands, and this store is read on a polled route: an unbounded map grown
 * by a loop of odd ids would be paid for on every render. The oldest mark is
 * dropped first, because the newest is the one a customer is looking at.
 */
export const MAX_VERIFIED_PROVIDERS = 32;

export type ProviderVerifiedMarks = Readonly<Record<string, string>>;

/**
 * Both writers are read-modify-writes of one map, and they run concurrently: a
 * settling turn records while a credential save forgets. Unserialised, the
 * record writes back the snapshot it read BEFORE the delete and the forget is
 * silently undone — the same reason `provider-enablement.ts` serialises its own
 * list. Every failure is swallowed here too: this runs on the settle path of a
 * turn a customer is waiting on and on a credential save, and losing a status
 * mark must never cost either.
 */
const withMarks = (() => {
  const lock = createSerialLock();
  return (work: () => Promise<void>): Promise<void> =>
    lock(async () => {
      try {
        await work();
      } catch {
        /* a status mark is never worth failing a turn or a save over */
      }
    });
})();

/**
 * Providers a mark may be stored under: a real catalogue slug, never a KIND.
 *
 * `auto` and `custom` are both, and a turn can report either — a mark under one
 * matches no row, says nothing about any credential, and occupies a slot.
 * `billedProviderFor` refuses `custom` for the same reason.
 */
const PSEUDO_PROVIDERS = new Set<string>([HERMES_AUTO_PROVIDER, "custom"]);

function isMarkableProviderId(id: unknown): id is string {
  return typeof id === "string"
    && isPlausibleHermesProviderId(id)
    && !PSEUDO_PROVIDERS.has(id);
}

/**
 * When Hermes' pooled credential store was last written, or null when it cannot
 * be asked. One `stat`, on a file the harness owns — never its contents.
 */
function credentialsWrittenAtMs(): number | null {
  const home = process.env.HERMES_HOME || path.join(process.env.HOME || "/home/clawbox", ".hermes");
  try {
    return fs.statSync(path.join(home, "auth.json")).mtimeMs;
  } catch {
    // No store yet, or not ours to read. Not knowing must not invalidate
    // everything: a box with no pooled credentials has nothing to invalidate.
    return null;
  }
}

function normalize(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
    // A value that is not a usable instant is not evidence of anything, and
    // shipping it would put "verified at Invalid Date" on the panel.
    if (!isMarkableProviderId(id) || typeof at !== "string") continue;
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) continue;
    out[id] = when.toISOString();
  }
  return out;
}

/**
 * Every provider this box has seen answer, newest value per provider.
 *
 * Never throws: a store that cannot be read means "nothing has been verified",
 * which is the same honest answer as an empty map — and far better than a
 * providers panel that 500s because a cache file was half-written.
 */
export async function readProviderVerified(): Promise<ProviderVerifiedMarks> {
  let marks: Record<string, string>;
  try {
    marks = normalize(await get(PROVIDER_VERIFIED_KEY));
  } catch {
    return {};
  }
  const credentialsAt = credentialsWrittenAtMs();
  if (credentialsAt === null) return marks;
  const fresh: Record<string, string> = {};
  for (const [id, at] of Object.entries(marks)) {
    if (Date.parse(at) >= credentialsAt) fresh[id] = at;
  }
  return fresh;
}

/**
 * How recent a stored mark has to be for a new turn to leave it alone.
 *
 * This runs on the settle path of EVERY turn, and "it answered at 19:53" does
 * not get truer by being rewritten at 19:54 — while the WRITE is a read, a
 * serialise and a rename of the whole config store. The store itself is the
 * memo, deliberately: a module-level one would go stale against a file another
 * process (or another test) had changed underneath it.
 */
export const RECORD_DEBOUNCE_MS = 60 * 60 * 1000;

/**
 * Remember that `providerId` served a turn.
 *
 * Best effort by design: this runs on the settle path of a turn the customer is
 * waiting on, and losing a status mark is never worth losing an answer.
 */
export async function recordProviderVerified(
  providerId: string,
  at: Date = new Date(),
): Promise<void> {
  if (!isMarkableProviderId(providerId) || Number.isNaN(at.getTime())) return;
  await withMarks(async () => {
    const stored = await readProviderVerified();
    const last = stored[providerId] ? Date.parse(stored[providerId]) : NaN;
    // Never backwards: a Jetson whose RTC is behind until NTP settles would
    // otherwise make the panel's "verified <when>" older than the truth.
    if (!Number.isNaN(last) && (at.getTime() <= last || at.getTime() - last < RECORD_DEBOUNCE_MS)) return;
    const marks = { ...stored, [providerId]: at.toISOString() };
    const ids = Object.keys(marks);
    if (ids.length > MAX_VERIFIED_PROVIDERS) {
      ids
        .sort((a, b) => Date.parse(marks[a]) - Date.parse(marks[b]))
        .slice(0, ids.length - MAX_VERIFIED_PROVIDERS)
        .forEach((id) => delete marks[id]);
    }
    await set(PROVIDER_VERIFIED_KEY, marks);
  });
}

/**
 * Forget `providerId`'s mark — its credential has just been written, replaced
 * or removed, so what an older turn proved is no longer about the key on disk.
 */
export async function forgetProviderVerified(providerId: string): Promise<void> {
  if (!isMarkableProviderId(providerId)) return;
  await withMarks(async () => {
    const marks = { ...(await readProviderVerified()) };
    if (!(providerId in marks)) return;
    delete marks[providerId];
    await set(PROVIDER_VERIFIED_KEY, marks);
  });
}
