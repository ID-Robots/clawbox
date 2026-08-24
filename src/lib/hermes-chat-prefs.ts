// Persisted Hermes chat-header selections (provider / per-provider model /
// reasoning effort). Browser-only: one localStorage key holding one small
// object, merged on write.
//
// WHY the model is stored PER PROVIDER rather than as a single string: the chat
// header scopes its model list to the selected provider, so a remembered
// "anthropic/claude-opus-5" must not resurface after the user switches to
// ClawBox AI. Keying by provider means a stale pick is simply never looked up
// for the wrong provider — and every read is re-validated anyway, both here
// (shape/charset) and by the caller against that provider's LIVE model list.
//
// These are UI preferences, not device config: `hermes -z --provider/--reasoning`
// are per-invocation overrides, so nothing here rewrites config.yaml. The Hermes
// settings panel remains the only thing that changes the device default.

import { isPlausibleHermesProviderId, isSafeHermesModelId } from '@/lib/hermes-providers';
import { isHermesReasoningLevel, type HermesReasoningLevel } from '@/lib/hermes-reasoning';

export const HERMES_CHAT_PREFS_KEY = 'clawbox:hermes:chat';

export interface HermesChatPrefs {
  provider?: string;
  /** provider id → last model the user picked for it. */
  models?: Record<string, string>;
  reasoning?: HermesReasoningLevel;
}

// Bound the map so a long-lived device can't grow the key without limit
// (one entry per provider ever selected; Hermes ships 44).
const MAX_REMEMBERED_MODELS = 64;

function sanitize(raw: unknown): HermesChatPrefs {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const prefs: HermesChatPrefs = {};

  if (isPlausibleHermesProviderId(obj.provider)) prefs.provider = obj.provider;
  if (isHermesReasoningLevel(obj.reasoning)) prefs.reasoning = obj.reasoning;

  if (obj.models && typeof obj.models === 'object') {
    const models: Record<string, string> = {};
    let count = 0;
    for (const [provider, model] of Object.entries(obj.models as Record<string, unknown>)) {
      if (count >= MAX_REMEMBERED_MODELS) break;
      if (!isPlausibleHermesProviderId(provider) || !isSafeHermesModelId(model)) continue;
      models[provider] = model;
      count += 1;
    }
    if (count > 0) prefs.models = models;
  }
  return prefs;
}

export function readHermesChatPrefs(): HermesChatPrefs {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage?.getItem(HERMES_CHAT_PREFS_KEY);
    return raw ? sanitize(JSON.parse(raw)) : {};
  } catch {
    // Unparseable / storage unavailable (private mode, quota) — the caller
    // falls back to the device's own configuration, which is always valid.
    return {};
  }
}

/** Shallow-merge `patch` over what is stored. Pass the whole `models` map. */
export function writeHermesChatPrefs(patch: HermesChatPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    const next = sanitize({ ...readHermesChatPrefs(), ...patch });
    window.localStorage?.setItem(HERMES_CHAT_PREFS_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal: the selection still applies to this session in memory.
  }
}

/**
 * Drop the remembered provider so the DEVICE default wins the next time the
 * chat seeds its header.
 *
 * Call this when the customer explicitly names a new default in Settings.
 * `seedHermesHeader` prefers this stored preference over the device's
 * configured provider — which is right for an ad-hoc pick made inside the chat,
 * and wrong the moment someone states an intent that outranks it. Without this
 * the chat kept opening on a provider the customer had just replaced, and the
 * only cure was clearing site data.
 *
 * The per-provider model picks are deliberately KEPT: they are remembered per
 * provider, so none of them can name the wrong vendor's model, and forgetting
 * them would throw away choices the new default has nothing to do with.
 */
export function forgetHermesProviderPreference(): void {
  writeHermesChatPrefs({ provider: undefined });
}
