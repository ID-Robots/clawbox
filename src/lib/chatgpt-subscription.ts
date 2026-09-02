import type { AuthProfileEntries } from "@/lib/subscription-surface";

/**
 * How the ChatGPT (Codex) subscription is referenced on OpenClaw 2 — the core
 * ClawBox pins (config/openclaw-target.txt).
 *
 * Until 2026.7 the sign-in was its own provider: the OAuth profile was
 * `codex:default` (provider `codex`) and the model `codex/<id>`, routed by the
 * codex plugin through the Codex app-server. OpenClaw 2 retired that
 * namespace. Read off the installed 2026.8.1 core (ea80657, the fleet pin) and
 * its documentation, then measured on a box (TASK-652):
 *
 *   - `codex/*` and `openai-codex/*` are LEGACY model references
 *     (dist/codex-route-model-ref: `LEGACY_CODEX_PROVIDER_IDS = {codex,
 *     openai-codex}`, `toCanonicalOpenAIModelRef` → `openai/<id>`). `config set
 *     agents.defaults.model.primary codex/gpt-5.5` answers "Unknown model" and
 *     `models list --provider codex` "Unknown provider filter".
 *   - The sign-in is `openclaw models auth login --provider openai` and yields
 *     an OAuth profile of the OPENAI provider; `--provider codex` is accepted
 *     as an alias for it and `openai-codex` refused as legacy (dist/auth).
 *   - The ChatGPT transport survives as an `api` on the openai provider,
 *     `openai-chatgpt-responses`; a route on it requires an oauth/token profile
 *     of the openai provider, the API-key transport an api-key one
 *     (dist/model-auth-openai: `openAICodexTransportRequiresOAuth`). Which
 *     profile a route gets is decided by the profile's TYPE, never by a
 *     namespace — so the subscription and an API key coexist under `openai`.
 *   - Profiles are listed by provider (`listProfilesForProvider` compares
 *     `resolveProviderIdForAuth(cred.provider)` with the route's), so a profile
 *     filed under provider `codex` is never a candidate for an `openai/*`
 *     route. Measured: with only `codex:default` on the box, a turn on
 *     `openai/gpt-5.5` failed `reason=auth` and fell through to the last-resort
 *     `models.providers.openai.apiKey` — the ClawBox AI image token.
 *   - `doctor --fix` renames `openai-codex:*` profile ids to `openai:<suffix>`
 *     (or `openai:chatgpt-<suffix>` when taken); a bare `codex:*` id, which is
 *     what ClawBox wrote, it leaves alone. Ran twice on that box; unconverted.
 *   - `agents.defaults.models["openai/<id>"].agentRuntime.id = "codex"` is the
 *     key the core itself keeps when it migrates a `codex/*` reference, and is
 *     honoured for the Codex app-server runtime on the canonical reference
 *     (dist/openai-routing: `modelSelectionShouldEnsureCodexPlugin`).
 *
 * So: the sign-in is filed as an openai-provider OAuth profile under a key of
 * its own, beside the API-key profile `openai:default`; the model is
 * `openai/<id>` with the Codex runtime armed on it; and `models.providers.codex`
 * / `openai-codex` are never written — doctor flags such an entry as shadowing
 * the OAuth credential. The pickers keep `codex` as the UI id for "ChatGPT
 * subscription" — labels, catalogue and reasoning table hang off it — only
 * what the box is asked to run changed.
 *
 * Unconfirmed on hardware (CI only): that a turn on `openai/<id>` with an
 * `openai:chatgpt` OAuth profile completes on a 2026.8.1 box. The owner's
 * session proves it.
 */

/** The id the pickers, labels and reasoning table use for the ChatGPT subscription. */
export const CHATGPT_UI_PROVIDER = "codex";

/** The provider the sign-in is filed under and the model reference names. */
export const CHATGPT_PROVIDER = "openai";

/**
 * The auth profile key ClawBox files the ChatGPT sign-in under. Not
 * `openai:default` — that is the API-key profile, and the two coexist. The
 * `chatgpt` suffix is the core's own vocabulary for this profile (doctor
 * allocates `openai:chatgpt-<suffix>` when `openai:<suffix>` is taken).
 */
export const CHATGPT_PROFILE_KEY = "openai:chatgpt";

/** Newest model on every ChatGPT tier including Free; gpt-5.6 is plan-gated. */
export const CHATGPT_DEFAULT_MODEL_ID = "gpt-5.5";

/** `openai/<id>` — the only reference OpenClaw 2 resolves for the subscription. */
export function chatgptModelRef(modelId: string): string {
  return `${CHATGPT_PROVIDER}/${modelId}`;
}

/** The config path that arms the Codex app-server runtime for `modelRef`. */
export function chatgptRuntimeConfigPath(modelRef: string): string {
  return `agents.defaults.models.${modelRef}.agentRuntime.id`;
}

function profileProvider(profileKey: string, entry: { provider?: string } | undefined): string {
  const raw = typeof entry?.provider === "string" && entry.provider.trim()
    ? entry.provider
    : profileKey.split(":")[0];
  return raw.trim().toLowerCase();
}

function isOauth(entry: { mode?: string } | undefined): boolean {
  return typeof entry?.mode === "string" && entry.mode.trim().toLowerCase() === "oauth";
}

/** Does this box hold a ChatGPT sign-in the core can route — an openai OAuth profile? */
export function hasChatgptOauthProfile(profiles: AuthProfileEntries): boolean {
  return Object.entries(profiles ?? {}).some(
    ([key, entry]) => isOauth(entry) && profileProvider(key, entry) === CHATGPT_PROVIDER,
  );
}

/**
 * A ChatGPT sign-in filed the OpenClaw 1 way (provider `codex` or
 * `openai-codex`): the core never consults it, so the box has a sign-in it
 * cannot run on. The honest state is "sign in again", not a model the picker
 * offers and the write refuses.
 */
export function hasLegacyChatgptProfile(profiles: AuthProfileEntries): boolean {
  return Object.entries(profiles ?? {}).some(([key, entry]) => {
    const provider = profileProvider(key, entry);
    return isOauth(entry) && (provider === "codex" || provider === "openai-codex");
  });
}

/** Is `ref` in the retired `codex/` or `openai-codex/` namespace? */
export function isLegacyCodexRef(ref: string | null | undefined): boolean {
  const provider = typeof ref === "string" ? ref.split("/", 1)[0].trim().toLowerCase() : "";
  return provider === "codex" || provider === "openai-codex";
}

/** `codex/<id>` → `openai/<id>`: the same model, where OpenClaw 2 resolves it. */
export function canonicalChatgptModelRef(legacyRef: string): string {
  return chatgptModelRef(legacyRef.slice(legacyRef.indexOf("/") + 1));
}
