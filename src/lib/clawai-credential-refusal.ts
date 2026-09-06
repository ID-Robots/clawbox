import { get, set } from "@/lib/config-store";

/**
 * The proxy refused this box's ClawBox AI credential, written down where the
 * ROOT boot script can read it. SERVER ONLY.
 *
 * Split out of `@/lib/harness/credentials` so the two writers can share it
 * without sharing that module's graph: the in-process memo there is armed by
 * the picture and microphone paths, and `/setup-api/ai-models/status` arms the
 * same fact from the portal poll — importing the harness credentials module
 * into that badge route pulls the whole Hermes adapter in behind it.
 */

/**
 * The store key.
 *
 * The in-process memo in `@/lib/harness/credentials` is a module variable in
 * the Next process. Three readers of
 * "has this box's ClawBox AI credential been refused" are not in that process:
 * `scripts/gateway-pre-start.sh`, which runs as root before the gateway and
 * decides whether to declare the agent's image path at all; the agent itself;
 * and the next Next process after a restart. TASK-727 is what that costs — the
 * pre-start re-armed `models.providers.openai` and the image slot at every
 * gateway start on a box whose credential the proxy had permanently refused,
 * and the agent went on spending refused calls against it, because the one
 * process that knew could not tell the one process that decided.
 *
 * Written to `data/config.json`, the same store `clawai_tier` uses and the same
 * file the pre-start already opens through `CLAWBOX_DEVICE_STORE`. The value is
 * a millisecond timestamp so an operator can see WHEN; nothing reads it beyond
 * "is it a positive number", because the fact does not expire on a clock — it
 * ends when the credential changes or the portal accepts it again, which are
 * exactly the two events that clear it.
 */
export const CLAWAI_CREDENTIAL_REFUSED_KEY = "clawai_credential_refused_at";

/**
 * What the boot script counts as a recorded refusal, spelled the same way here.
 *
 * `_clawai_credential_refused()` in `scripts/gateway-pre-start.sh` stands down
 * on a positive number and on nothing else — an absent key, a null, a string, a
 * zero all mean "nobody has told us this credential is dead". Both writers ask
 * the same question so neither can leave a value the other side would read
 * differently, and so a store nobody has written is never mistaken for one that
 * records something.
 */
function isRecordedRefusal(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Record that the proxy or the portal refused this box's ClawBox AI credential.
 *
 * Same evidential bar as `noteClawaiCredentialRefused` in
 * `@/lib/harness/credentials`: only the service's OWN
 * identification of the credential as the problem may call this, never a bare
 * 401/403 off the wire.
 *
 * Best effort, and deliberately so. The store can be unwritable (a root-owned
 * `data/config.json` is a state this repo has seen), and a picture or a badge
 * poll must not fail because a HINT could not be saved. What is lost when it
 * fails is one boot's worth of stand-down, not the refusal itself: the caller's
 * own in-memory memo still mutes its surface, and the next poll writes again.
 */
export async function persistClawaiCredentialRefusal(): Promise<void> {
  try {
    if (isRecordedRefusal(await get(CLAWAI_CREDENTIAL_REFUSED_KEY))) return;
    await set(CLAWAI_CREDENTIAL_REFUSED_KEY, Date.now());
  } catch {
    // See the docblock: a hint that could not be written is not an outcome the
    // caller can do anything about, and it is re-derived on the next refusal.
  }
}

/**
 * Forget the persisted refusal — the credential changed, or the portal has just
 * accepted the one this box holds.
 *
 * Read before write, so the overwhelmingly common path (nothing recorded) never
 * opens the store for writing at all, and a box whose `data/config.json` cannot
 * be written is not made to fail on every re-link.
 */
export async function clearPersistedClawaiCredentialRefusal(): Promise<void> {
  try {
    if (!isRecordedRefusal(await get(CLAWAI_CREDENTIAL_REFUSED_KEY))) return;
    await set(CLAWAI_CREDENTIAL_REFUSED_KEY, undefined);
  } catch {
    // Bounded the other way, and self-healing: an uncleared stamp costs one
    // boot of a suppressed image repair, and the portal poll clears it within
    // its 30-second cadence once the credential is accepted again.
  }
}
