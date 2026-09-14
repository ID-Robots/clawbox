/**
 * WHO decided which engine serves a capability — the owner, or the automatic
 * ClawBox AI cloud default.
 *
 * Its own thin module, importing nothing but the config store and the key
 * table, because every surface a person can pick from writes it: the Voice tab
 * through `/setup-api/tts`, the transcription picker through `/setup-api/stt`,
 * the Memory Shard provider route. Those three are cheap routes, and reaching
 * the applier for two setters would pull the OpenClaw CLI, the memory index and
 * the embedder probe into all of them.
 */

import { get, set } from "@/lib/config-store";
import { CHOICE_SOURCE_KEYS, type CloudCapability } from "@/lib/clawai-cloud-defaults-state";

/**
 * Record that the OWNER pinned this capability's engine, so no later default
 * moves it.
 */
export async function noteOwnerChoice(capability: CloudCapability): Promise<void> {
  await set(CHOICE_SOURCE_KEYS[capability], "owner");
}

/**
 * Hand a capability back to the automatic default.
 *
 * The other half of {@link noteOwnerChoice}, and the reason the key holds a
 * word rather than a boolean: "the owner chose the box" and "the owner asked
 * for whatever the subscription covers" are different answers, and DELETING the
 * key would make the second indistinguishable from never having been asked —
 * which, on a box whose stored engine is the on-device one, reads as an owner
 * pick all over again (see `ownerChoiceFrom`).
 */
export async function clearOwnerChoice(capability: CloudCapability): Promise<void> {
  await set(CHOICE_SOURCE_KEYS[capability], "auto");
}

/** The recorded word for one capability, exactly as it sits in the store. */
export async function readChoiceSource(capability: CloudCapability): Promise<unknown> {
  return await get(CHOICE_SOURCE_KEYS[capability]);
}
