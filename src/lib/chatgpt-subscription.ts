import { parseModelSlug } from "@/lib/provider-models";
import type { OpenclawConfigSetArgs } from "@/lib/openclaw-config";
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

/**
 * The `agentRuntime.id` that sends a turn through the Codex app-server. Named
 * once because five sites write or read it — the configure batch, both chat
 * arm sites, the same-model repair, and `scripts/gateway-pre-start.sh`'s boot
 * seed — and a typo in any one of them is a silent HTML-challenge failure.
 */
export const CHATGPT_AGENT_RUNTIME_ID = "codex";

/**
 * Provider ids an OpenClaw 1 ChatGPT sign-in was filed under: `openai-codex`
 * up to 2026.5, `codex` in 2026.6/2026.7. Both are LEGACY on the pinned core —
 * for a profile (never consulted for an `openai/*` route) and for a model
 * reference (`Unknown model`) alike. The pair used to be spelled out at six
 * call sites; ask the predicate below instead.
 */
const LEGACY_CHATGPT_PROVIDERS: ReadonlySet<string> = new Set(["codex", "openai-codex"]);

/** Is `provider` one of the retired ChatGPT provider ids? */
export function isLegacyChatgptProvider(provider: string | null | undefined): boolean {
  return typeof provider === "string" && LEGACY_CHATGPT_PROVIDERS.has(provider.trim().toLowerCase());
}

/**
 * The provider a model reference is WRITTEN under for a row the UI calls
 * `uiProvider`. `codex` is a label, not a namespace, on OpenClaw 2: the row's
 * models are `openai/<id>`. Every surface that turns a row into a reference —
 * or a reference back into a row's model id — has to go through this, or it
 * compares the UI id against a reference that never carries it.
 */
export function chatgptReferenceProvider(uiProvider: string | null | undefined): string {
  const normalized = typeof uiProvider === "string" ? uiProvider.trim().toLowerCase() : "";
  return isLegacyChatgptProvider(normalized) ? CHATGPT_PROVIDER : normalized;
}

/** `openai/<id>` — the only reference OpenClaw 2 resolves for the subscription. */
export function chatgptModelRef(modelId: string): string {
  return `${CHATGPT_PROVIDER}/${modelId}`;
}

/** The config path that arms the Codex app-server runtime for `modelRef`. */
function chatgptRuntimeConfigPath(modelRef: string): string {
  return `agents.defaults.models.${modelRef}.agentRuntime.id`;
}

/** The whole `config set` op that arms the Codex runtime on `modelRef`. */
export function chatgptRuntimeArmOp(modelRef: string): OpenclawConfigSetArgs {
  return [chatgptRuntimeConfigPath(modelRef), CHATGPT_AGENT_RUNTIME_ID];
}

/**
 * The provider an auth profile belongs to: its own `provider` field, or the
 * key prefix when the entry does not carry one.
 *
 * Exported because four call sites derived it inline and one of them read the
 * key prefix first, which answers `openai` for a `openai:chatgpt` entry filed
 * under any other provider.
 */
export function profileProviderId(
  profileKey: string,
  entry: { provider?: string } | undefined,
): string {
  const raw = typeof entry?.provider === "string" && entry.provider.trim()
    ? entry.provider
    : profileKey.split(":")[0];
  return raw.trim().toLowerCase();
}

/** Is this auth profile an OAuth (subscription) credential? */
export function isOauthProfile(entry: { mode?: string } | undefined): boolean {
  return typeof entry?.mode === "string" && entry.mode.trim().toLowerCase() === "oauth";
}

/** Does this box hold a ChatGPT sign-in the core can route — an openai OAuth profile? */
export function hasChatgptOauthProfile(profiles: AuthProfileEntries): boolean {
  return Object.entries(profiles ?? {}).some(
    ([key, entry]) => isOauthProfile(entry) && profileProviderId(key, entry) === CHATGPT_PROVIDER,
  );
}

/**
 * A ChatGPT sign-in filed the OpenClaw 1 way (provider `codex` or
 * `openai-codex`): the core never consults it, so the box has a sign-in it
 * cannot run on. The honest state is "sign in again", not a model the picker
 * offers and the write refuses.
 */
export function hasLegacyChatgptProfile(profiles: AuthProfileEntries): boolean {
  return Object.entries(profiles ?? {}).some(
    ([key, entry]) => isOauthProfile(entry) && isLegacyChatgptProvider(profileProviderId(key, entry)),
  );
}

/** Is `ref` in the retired `codex/` or `openai-codex/` namespace? */
export function isLegacyCodexRef(ref: string | null | undefined): boolean {
  return isLegacyChatgptProvider(parseModelSlug(ref)?.provider);
}

/** `codex/<id>` → `openai/<id>`: the same model, where OpenClaw 2 resolves it. */
export function canonicalChatgptModelRef(legacyRef: string): string {
  const parsed = parseModelSlug(legacyRef);
  return chatgptModelRef(parsed?.modelId ?? legacyRef);
}

/**
 * Every openai auth profile on this box, `preferred` first — the argument list
 * for `openclaw models auth order set --provider openai`.
 *
 * A list, never the single preferred id, for two reasons the core's own
 * ordering makes concrete (dist/order-*.js `resolveAuthProfileOrderWithMetadata`):
 *
 *  * An explicit order REPLACES the candidate list rather than reordering it
 *    (`baseOrder = explicitOrder ?? …`). A one-entry order written at ChatGPT
 *    sign-in therefore hides an `openai:default` API key saved afterwards —
 *    the turn keeps going to the ChatGPT account and 400s on the API-only
 *    models the owner switched modes to reach.
 *  * When every profile in an explicit order is present but INELIGIBLE (an
 *    expired OAuth credential is the ordinary case), the plan is
 *    `{kind: "empty", explicitOrder: true}` and the core refuses every turn on
 *    the provider with "Explicit auth order for openai has no usable
 *    profiles" — with a working API key in the same store. The core's own
 *    repair (`allBaseProfilesMissing`) only covers profiles that are GONE.
 *
 * Naming both profiles keeps the preference and leaves the other credential
 * reachable. The ids come from openclaw.json's `auth.profiles`, which the CLI
 * itself maintains beside the store; if that drifts and names a profile the
 * store lacks, `order set` rejects the whole call and the caller says so in
 * its answer rather than reporting a preference it did not record.
 */
export function openaiAuthOrder(profiles: AuthProfileEntries, preferred: string): string[] {
  const others = Object.entries(profiles ?? {})
    .filter(([key, entry]) => key !== preferred && profileProviderId(key, entry) === CHATGPT_PROVIDER)
    .map(([key]) => key)
    .sort();
  return [preferred, ...others];
}
