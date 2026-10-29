/**
 * What an `auth.profiles` entry's `mode` says about the credential behind it.
 *
 * Its own module, with no imports, so the speech-to-text preference
 * (stt-preference.ts) can ask the same question subscription-surface.ts asks
 * without loading that module's config-store and surface tables.
 * gateway-pre-start.sh carries a copy of the mode set
 * (`CLAWBOX_KEY_PROFILE_MODES`); keep the two in step.
 */

/** Auth-profile modes that mean "this provider has a bearer key of its own". */
const KEY_MODES: ReadonlySet<string> = new Set(["token", "api_key", "api-key"]);

/**
 * Does this auth profile carry a key/token of its own (as opposed to OAuth)?
 * Exported because the chat route asks the same question of the openai
 * profiles and had its own hard-coded copy of the mode set.
 */
export function isKeyModeProfile(entry: { mode?: string } | undefined): boolean {
  return typeof entry?.mode === "string" && KEY_MODES.has(entry.mode.trim().toLowerCase());
}
