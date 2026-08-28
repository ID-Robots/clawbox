// The owner's per-provider switch: "this provider stays connected, but the box
// may not route to it."
//
// WHY IT IS A SEPARATE FACT FROM "connected". Disconnecting a provider throws
// its credential away, and re-entering a key from a phone is the chore this
// exists to avoid. The switch keeps the credential and takes the provider out
// of every place the box picks a model — the chat header, "make this the
// default", the fallback slot — so switching it back on is one click.
//
// THE ONE RULE. The current default can never be disabled. A box whose default
// is switched off has nowhere to send the next message, and every consumer
// below would then have to decide on its own what to do about that. Refusing
// here, once, with the fix in the message, is the whole design.
//
// The read side (`DISABLED_PROVIDERS_KEY`, `parseDisabledProviders`) lives in
// provider-status.ts because the status is what stamps `enabled` on every
// row; this module owns the write and the rule.

import { get as getConfigValue, set as setConfigValue } from "@/lib/config-store";
import { getActiveHarness, type Harness } from "@/lib/harness";
import { createSerialLock } from "@/lib/serial-lock";
import {
  canonicalProviderId,
  DISABLED_PROVIDERS_KEY,
  parseDisabledProviders,
  readProviderStatus,
} from "@/lib/provider-status";

export type SetProviderEnabledResult =
  | { ok: true }
  | { ok: false; kind: "is_default" | "unknown_provider"; error: string };

/**
 * One writer of the disabled list at a time. The list is read, changed and
 * written back as a whole; two switches flipped together — two tabs, or a
 * fast owner — would each read the same list and the second write would
 * silently undo the first. The store's atomic rename protects the file, not
 * the update.
 */
const withDisabledList = createSerialLock();

/** The canonical ids the owner has switched off. Empty when nothing is. */
export async function getDisabledProviders(): Promise<Set<string>> {
  return parseDisabledProviders(await getConfigValue(DISABLED_PROVIDERS_KEY));
}

/**
 * True unless the owner switched this provider off. An id in any spelling the
 * harness accepts (`codex`, `deepseek`) answers for the row it collapses onto,
 * so a consumer never has to normalise before asking.
 */
export async function isProviderEnabled(id: string): Promise<boolean> {
  const harness = await getActiveHarness().catch(() => "openclaw" as Harness);
  const canonical = canonicalProviderId(harness, id);
  if (!canonical) return true;
  return !(await getDisabledProviders()).has(canonical);
}

/**
 * Flip the switch for one provider.
 *
 * Validated against the live status rather than a static list, for two
 * reasons: the set of known providers differs per harness (and on Hermes
 * includes whatever the dashboard reports), and the default is decided there
 * — the same way the strip decides it — so this cannot disagree with what the
 * owner is looking at. A degraded status has no rows, and then nothing is
 * known; refusing is the safe direction when the default cannot be told.
 */
export async function setProviderEnabled(id: string, enabled: boolean): Promise<SetProviderEnabledResult> {
  const status = await readProviderStatus();
  const canonical = canonicalProviderId(status.harness, id);
  const row = canonical ? status.providers.find((candidate) => candidate.id === canonical) : undefined;
  if (!row || !canonical) {
    return { ok: false, kind: "unknown_provider", error: "That AI provider is not known to this box." };
  }
  if (!enabled && row.isDefault) {
    return { ok: false, kind: "is_default", error: "Make another provider the default first." };
  }

  await withDisabledList(async () => {
    const disabled = await getDisabledProviders();
    if (enabled) disabled.delete(canonical);
    else disabled.add(canonical);
    // Sorted so the stored list is stable across flips and diffs cleanly.
    await setConfigValue(DISABLED_PROVIDERS_KEY, [...disabled].sort());
  });
  return { ok: true };
}
