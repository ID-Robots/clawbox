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
 * WHY A MARK EXPIRES ON A CREDENTIAL CHANGE, and not on a clock. "It answered
 * at 19:53" stays true for ever, and the timestamp travels with the flag so a
 * consumer can age it. What is NOT true for ever is that the CURRENT credential
 * works: rotate the key and the old turn says nothing about the new one. So
 * every path that writes or replaces a provider's credential forgets that
 * provider's mark, and the row goes back to "not checked" — never to
 * "not connected", which is the third thing TASK-583's acceptance asks for.
 */
import { get, set } from "@/lib/config-store";

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

/** Provider ids are slugs — the same charset the Hermes catalogue uses. */
function isPlausibleProviderId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id);
}

function normalize(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
    // A value that is not a usable instant is not evidence of anything, and
    // shipping it would put "verified at Invalid Date" on the panel.
    if (!isPlausibleProviderId(id) || typeof at !== "string") continue;
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
  try {
    return normalize(await get(PROVIDER_VERIFIED_KEY));
  } catch {
    return {};
  }
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
  if (!isPlausibleProviderId(providerId) || Number.isNaN(at.getTime())) return;
  try {
    const stored = await readProviderVerified();
    const last = stored[providerId] ? Date.parse(stored[providerId]) : NaN;
    if (!Number.isNaN(last) && at.getTime() - last < RECORD_DEBOUNCE_MS && at.getTime() >= last) return;
    const marks = { ...stored, [providerId]: at.toISOString() };
    const ids = Object.keys(marks);
    if (ids.length > MAX_VERIFIED_PROVIDERS) {
      ids
        .sort((a, b) => Date.parse(marks[a]) - Date.parse(marks[b]))
        .slice(0, ids.length - MAX_VERIFIED_PROVIDERS)
        .forEach((id) => delete marks[id]);
    }
    await set(PROVIDER_VERIFIED_KEY, marks);
  } catch {
    /* a status mark is never worth failing a turn over */
  }
}

/**
 * Forget `providerId`'s mark — its credential has just been written, replaced
 * or removed, so what an older turn proved is no longer about the key on disk.
 */
export async function forgetProviderVerified(providerId: string): Promise<void> {
  if (!isPlausibleProviderId(providerId)) return;
  try {
    const marks = { ...(await readProviderVerified()) };
    if (!(providerId in marks)) return;
    delete marks[providerId];
    await set(PROVIDER_VERIFIED_KEY, marks);
  } catch {
    /* same reason as above: never fail a credential save over a status mark */
  }
}
