/**
 * Would `openclaw models auth paste-api-key` change anything? (TASK-1535)
 *
 * The configure route stores every API-key credential through that CLI — the
 * one writer that owns the auth store's schema on every core generation — and
 * pays its 5-14 s start-up on a Jetson for it. A Settings save re-sends the
 * credential the box already holds (the owner switching model, re-saving the
 * same ClawBox AI token), and the ClawBox AI pass then pasted the same token a
 * second time inside the same request: two of the four rounds a re-save was
 * measured spending 50 s in. This answers whether the paste would be a no-op,
 * so the route can leave it out, and answers false wherever it cannot be sure.
 *
 * The paste does three things (`modelsAuthPasteApiKeyCommand` →
 * `saveModelProviderApiKey` in the pinned core): it puts `{type: "api_key",
 * provider, key}` at the profile in the default agent's store; it rewrites
 * `auth.profiles.<id>` as `{provider, mode: "api_key"}`, keeping only a
 * non-empty `email` and `displayName` of what was there; and it may promote the
 * profile in `auth.order` (`applyAuthProfileConfig`) — to the front of an order
 * the provider has, or into a new one when the provider has a peer profile of
 * another mode. So it changes nothing when:
 *
 *  - the store already holds exactly this key ({@link gatewayAuthStoreHoldsApiKey});
 *  - `auth.profiles.<id>` already is that entry;
 *  - the provider's order cannot move: it has no peer profile, and no order or
 *    one this profile already leads.
 *
 * And only where the paste's store is the one that was read. The CLI writes the
 * DEFAULT agent's store, which is `main` unless the config names a roster; with
 * one, the paste may write an agent store this module never looks at — so a box
 * with a roster always pastes.
 *
 * SERVER ONLY.
 */

import { gatewayAuthStoreHoldsApiKey } from "@/lib/openclaw-auth-store";
import type { OpenClawConfig } from "@/lib/openclaw-config";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The keys of `auth.profiles.<id>` a paste leaves standing. */
const KEPT_PROFILE_KEYS = new Set(["provider", "mode", "email", "displayName"]);

/**
 * Is `candidate` this provider, or one the core may resolve to it? Exact, or
 * one is the other plus a `-suffix` (`openai` / `openai-codex`): a guess at the
 * core's aliasing that errs toward "related", which only ever means "paste".
 */
function relatedProvider(candidate: string, provider: string): boolean {
  return candidate === provider || candidate.startsWith(`${provider}-`) || provider.startsWith(`${candidate}-`);
}

export interface ApiKeyPaste {
  config: OpenClawConfig;
  /** The `--provider` the paste would be given. */
  provider: string;
  /** The `--profile-id` it would be given. */
  profileId: string;
  key: string;
  /** The store check; {@link gatewayAuthStoreHoldsApiKey} unless a test says otherwise. */
  storeHoldsKey?: (profileId: string, provider: string, key: string) => boolean;
}

export function apiKeyPasteChangesNothing(paste: ApiKeyPaste): boolean {
  const provider = paste.provider.trim().toLowerCase();
  if (!provider || provider !== paste.provider || !paste.key || !paste.profileId) return false;
  const config = paste.config as Json;

  const agents = isRecord(config.agents) ? config.agents : {};
  if (agents.list !== undefined && !(Array.isArray(agents.list) && agents.list.length === 0)) return false;
  if (agents.entries !== undefined) {
    if (!isRecord(agents.entries) || Object.keys(agents.entries).some((id) => id !== "main")) return false;
  }

  const auth = isRecord(config.auth) ? config.auth : {};
  const profiles = isRecord(auth.profiles) ? auth.profiles : {};
  const entry = Object.hasOwn(profiles, paste.profileId) ? profiles[paste.profileId] : undefined;
  if (!isRecord(entry) || entry.provider !== provider || entry.mode !== "api_key") return false;
  for (const [key, value] of Object.entries(entry)) {
    if (!KEPT_PROFILE_KEYS.has(key)) return false;
    if ((key === "email" || key === "displayName") && (typeof value !== "string" || !value)) return false;
  }
  for (const [id, profile] of Object.entries(profiles)) {
    if (id === paste.profileId) continue;
    const peer = isRecord(profile) && typeof profile.provider === "string"
      ? profile.provider.trim().toLowerCase()
      : id.split(":", 1)[0].trim().toLowerCase();
    if (relatedProvider(peer, provider)) return false;
  }

  if (auth.order !== undefined) {
    if (!isRecord(auth.order)) return false;
    for (const [key, order] of Object.entries(auth.order)) {
      if (!relatedProvider(key.trim().toLowerCase(), provider)) continue;
      if (key !== provider || !Array.isArray(order) || order[0] !== paste.profileId) return false;
      if (new Set(order).size !== order.length) return false;
    }
  }

  return (paste.storeHoldsKey ?? gatewayAuthStoreHoldsApiKey)(paste.profileId, provider, paste.key);
}
