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
 * Is a refusal on record for the credential this box holds?
 *
 * The read half of the same key `scripts/gateway-pre-start.sh` opens at boot,
 * for the writers on this side that must not undo its stand-down: re-writing
 * the image row and the image slot on a pass that did not change the credential
 * would put the two out of step and start the storm again.
 *
 * Answers false to a store it cannot read, for the same reason the shell reader
 * does: not knowing is not a refusal.
 */
export async function clawaiCredentialRefusalOnRecord(): Promise<boolean> {
  try {
    return isRecordedRefusal(await get(CLAWAI_CREDENTIAL_REFUSED_KEY));
  } catch {
    return false;
  }
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
 * poll must not fail because a HINT could not be saved. The caller's own
 * in-memory memo still mutes its surface, and the next refusal tries again.
 *
 * WHAT IT COSTS WHEN IT FAILS, honestly: the boot script goes on arming the
 * agent's image path at every gateway start. This whole mechanism is
 * BOOT-SCOPED in both directions — recording a refusal does not restart
 * anything, so a box already running keeps spending refused calls until it is
 * restarted for some other reason, and clearing one does not restart anything
 * either, so a healed credential gets its pictures back at the next start
 * rather than at the next poll. That is the trade for not letting a hint
 * bounce the gateway.
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
 *
 * `notRecordedSince` is what keeps a SLOW answer from erasing a FRESH verdict.
 * The portal poll asks about the credential the box held when its request
 * started, and up to four seconds can pass before it answers; in that window
 * the device can be re-linked and the NEW credential refused. Clearing then
 * would be a verdict about a token the box no longer holds erasing one about
 * the token it does. Callers that learned something at a known moment pass that
 * moment and a stamp written since is left alone. A caller that WROTE the
 * credential passes nothing: an explicit re-link retires every refusal on
 * record, whenever it was written, because it is the event this whole mark
 * exists to end.
 */
export async function clearPersistedClawaiCredentialRefusal(
  notRecordedSince?: number,
): Promise<void> {
  try {
    const at = await get(CLAWAI_CREDENTIAL_REFUSED_KEY);
    if (!isRecordedRefusal(at)) return;
    if (notRecordedSince !== undefined && (at as number) >= notRecordedSince) return;
    await set(CLAWAI_CREDENTIAL_REFUSED_KEY, undefined);
  } catch {
    // Bounded, in the same boot-scoped way as the write above: an uncleared
    // stamp costs the image path until a later clear lands and the gateway
    // starts again. Note that an UNREADABLE store never gets here at all —
    // `get` swallows the read and answers `undefined`, which reads as "nothing
    // to clear" — so this catch is about a store that can be read and not
    // written.
  }
}
