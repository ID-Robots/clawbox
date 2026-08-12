import { setMany } from "@/lib/config-store";
import { sanitizePreferenceWrites } from "@/lib/preference-schema";

/**
 * Write `pref:*` entries to the config store, applying the preference rules
 * first.
 *
 * The one door for code that stores preferences without going through
 * POST /setup-api/preferences — the app install and uninstall routes, and the
 * webapp registry. All three read the current value, change one entry and write
 * the whole thing back, so the rules have to cover the entries they carry over
 * as well as the one they are changing.
 *
 * Deliberately NOT folded into `config-store.setMany`: most of what that writes
 * is not a preference at all (provider tokens, setup flags, updater state), and
 * the preference rules — a length cap, no control characters — would be wrong
 * for an opaque secret.
 */
export async function setPreferences(updates: Record<string, unknown>): Promise<void> {
  const checked = sanitizePreferenceWrites(updates);
  // Every entry can be dropped, and an empty write would still cost a full
  // read-modify-rewrite of config.json.
  if (Object.keys(checked).length === 0) return;
  await setMany(checked);
}
