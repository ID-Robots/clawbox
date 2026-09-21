/**
 * The mascot's vocabulary, server side.
 *
 * This module used to run an on-device generator: it prompted the local
 * llama.cpp model for fresh crab lines on a weekly/daily schedule, validated
 * and merged the batch, cached it per locale in the KV store, and backed off
 * behind a failure record when the model was busy or the box was short on
 * memory. Settings → Appearance carried a "Refresh phrases" button that
 * triggered it by hand.
 *
 * All of that is gone. The hand-written packs in `src/lib/mascot-packs/` are
 * the mascot's whole vocabulary now, and the crab picks a random line out of
 * them — which is what the generator's output was blended into anyway, and
 * what every locale outside the English-only generation allowlist already got.
 *
 * What remains here is the one thing the route needs: resolve the locale, hand
 * back that locale's complete pack. The KV envelopes and failure records the
 * old scheduler left on disk are deleted on first read so a box that ran the
 * previous build does not carry them forever.
 */

import * as config from "./config-store";
import { kvDelete, kvGet, kvGetAll } from "./kv-store";
import { isPreferenceLanguage } from "./preference-schema";
import { VALIDATOR_VERSION } from "./mascot-language";
import { mergeWithPack } from "./mascot-packs";
import { type MascotPhraseSet } from "./mascot-phrases";

/** Where the lines came from. Only one source left. */
export type PhraseSource = "pack";

export interface PhraseMeta {
  source: PhraseSource;
  reason: string;
  locale: string;
  validatorVersion: number;
}

/** `meta.reason` for every response: the packs are the vocabulary. */
export const PACK_ONLY_REASON = "pack-only";

/**
 * KV written by the generator that no longer exists. The un-prefixed entries
 * are older still — they predate the per-locale envelopes.
 */
const LEGACY_EXACT_KEYS = [
  "clawbox-mascot-phrase-set",
  "clawbox-mascot-convo-lines",
  "clawbox-mascot-phrase-last-failure",
];
const LEGACY_PREFIXES = [
  "clawbox-mascot-phrase-set:",
  "clawbox-mascot-phrase-failure:",
];

let legacyPurged = false;

/**
 * Drop the old generator's leftovers, once per process.
 *
 * Deleted rather than ignored: nothing can rewrite or expire them any more, so
 * left alone they are unreachable data that outlives every code path that
 * understood it.
 */
function purgeGeneratorKeys(): void {
  if (legacyPurged) return;
  legacyPurged = true;
  try {
    const stale = [
      ...LEGACY_EXACT_KEYS.filter((key) => kvGet(key) !== null),
      ...LEGACY_PREFIXES.flatMap((prefix) => Object.keys(kvGetAll(prefix))),
    ];
    for (const key of stale) kvDelete(key);
    if (stale.length > 0) {
      console.info(`[mascot-phrases] dropped ${stale.length} key(s) from the removed phrase generator`);
    }
  } catch (err) {
    console.warn("[mascot-phrases] could not purge generator keys:", err);
  }
}

/**
 * The locale to speak.
 *
 * `requested` wins when it names a language the device ships: the client knows
 * which language it is rendering, which can be ahead of the stored preference
 * by a few hundred milliseconds right after a switch. The stored value is read
 * straight from the config store, bypassing the validation
 * `/setup-api/preferences` applies, so it is re-checked here.
 */
async function resolveLocale(requested?: string | null): Promise<string> {
  if (isPreferenceLanguage(requested)) return requested;
  const stored = await config.get("pref:ui_language");
  return isPreferenceLanguage(stored) ? stored : "en";
}

/**
 * The phrase set for `requestedLocale` — always complete, always in that
 * locale. `mergeWithPack(null, locale)` is the locale's own pack topped up
 * from the language-free neutral pack, so no category can come back empty.
 */
export async function getMascotPhrases(
  requestedLocale?: string | null,
): Promise<{ phrases: MascotPhraseSet; meta: PhraseMeta }> {
  purgeGeneratorKeys();
  const locale = await resolveLocale(requestedLocale);
  return {
    phrases: await mergeWithPack(null, locale),
    meta: {
      source: "pack",
      reason: PACK_ONLY_REASON,
      locale,
      validatorVersion: VALIDATOR_VERSION,
    },
  };
}
