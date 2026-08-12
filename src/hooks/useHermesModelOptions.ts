"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Client view of ONE provider's model list.
//
// The scoping happens server-side (see src/lib/hermes-model-options.ts): the
// route is asked for `?provider=<slug>` and answers with that provider's models
// only, plus a `current` that is "" whenever the device's saved model belongs
// to a different provider. So this hook cannot render a foreign vendor's model
// even if it wanted to — there is nothing else in the payload.
//
// Deliberately NOT built on useProviderCatalog / provider-models.ts: those are
// the OPENCLAW namespace ("openai"/"codex"/"google", ids like
// "claude-sonnet-4-6") and Hermes uses different ids for the same providers
// ("claude-sonnet-5", "gemini-3.6-flash"). Reusing them would reintroduce the
// very mismatch this exists to fix. The abort/no-flicker discipline is reused;
// the data is not.

/**
 * "The device's provider set or selection changed."
 *
 * The invalidation is deliberately a SIGNAL, not data: the server already drops
 * both its caches on the write that precedes it (`invalidateModelOptions` on the
 * models/provider-key/clawai routes, and the `hermes config get` memo keys on
 * config.yaml's mtime), so every listener only has to re-ask. It must stay
 * lightweight — see `refresh` below for what the expensive version costs.
 */
export const HERMES_MODEL_STATE_EVENT = "clawbox:hermes-model-state-changed";

/** Emit the signal above. Call it wherever a provider configure SUCCEEDED. */
export function notifyHermesModelState(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(HERMES_MODEL_STATE_EVENT));
}

export interface HermesScopedModel {
  id: string;
  description?: string;
  featured?: boolean;
  pricing?: { input?: string; output?: string; free?: boolean };
}

export interface HermesModelScope {
  provider: string;
  authenticated: boolean | null;
  models: HermesScopedModel[];
  defaultModel: string;
  current: string;
  savedElsewhere: { provider: string; model: string } | null;
  warning?: string;
  source: "dashboard" | "catalog-file" | "cold-start";
  stale: boolean;
}

export interface UseHermesModelOptions {
  /** Null while the first load for the current provider is in flight. */
  scope: HermesModelScope | null;
  loading: boolean;
  error: string | null;
  /** Force a live re-fetch that also busts Hermes' own per-provider cache. */
  refresh: () => void;
}

const emptyScope = (provider: string): HermesModelScope => ({
  provider,
  authenticated: null,
  models: [],
  defaultModel: "",
  current: "",
  savedElsewhere: null,
  source: "cold-start",
  stale: true,
});

interface LoadedState {
  provider: string;
  scope: HermesModelScope;
  error: string | null;
}

export function useHermesModelOptions(provider: string | null): UseHermesModelOptions {
  // One state cell written only from async callbacks — `loading` is DERIVED
  // from "what we hold isn't for the provider we were asked about", so
  // switching provider needs no synchronous setState (and no extra render).
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [nonce, setNonce] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  // ONE-SHOT. `nonce` only ever increments, so gating the flag on `nonce > 0`
  // latched it on forever: after a single refresh, every later provider click
  // asked the server for an explicit refresh, which busts Hermes' per-provider
  // disk cache and re-fetches every provider's live /v1/models — the opposite
  // of the stale-while-revalidate the panel is supposed to feel like. The flag
  // is cleared only when a request actually COMPLETES, so an aborted one (fast
  // provider switch, StrictMode double-mount) still carries the user's intent
  // over to the request that replaces it.
  const pendingRefreshRef = useRef(false);

  const refresh = useCallback(() => {
    pendingRefreshRef.current = true;
    setNonce((n) => n + 1);
  }, []);

  // A provider configured elsewhere in the UI changes what this scope should
  // contain, but the effect below only re-runs when the PROVIDER changes — so
  // without this the panel and the chat header kept serving the pre-configure
  // answer until the page was reloaded.
  //
  // Note what this deliberately does NOT do: call `refresh`. Bumping the nonce
  // alone re-asks the route plainly, which is enough because the write that
  // emitted the signal already invalidated the server's caches. Going through
  // `refresh` would set the explicit flag and make the server bust Hermes' own
  // per-provider disk cache and re-enumerate EVERY provider's live /v1/models —
  // a device-wide sweep to answer "is there a new provider in the list?".
  //
  // It also leaves `loaded` in place, so `fresh` (and therefore `loading`) is
  // unchanged: the chat's model pill keeps its place instead of collapsing.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onChanged = () => setNonce((n) => n + 1);
    window.addEventListener(HERMES_MODEL_STATE_EVENT, onChanged);
    return () => window.removeEventListener(HERMES_MODEL_STATE_EVENT, onChanged);
  }, []);

  useEffect(() => {
    if (!provider) return;
    // Abort the previous provider's request so a slow response for the OLD
    // provider can never land after the user has already moved on.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    const explicitRefresh = pendingRefreshRef.current;
    const url = `/setup-api/hermes/models?provider=${encodeURIComponent(provider)}${explicitRefresh ? "&refresh=1" : ""}`;
    fetch(url, { cache: "no-store", signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: HermesModelScope) => {
        if (controller.signal.aborted) return;
        pendingRefreshRef.current = false;
        // Guard against a stale/garbled payload naming a different provider.
        setLoaded({
          provider,
          scope: data?.provider === provider ? data : emptyScope(provider),
          error: null,
        });
      })
      .catch((err) => {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
        pendingRefreshRef.current = false;
        setLoaded({ provider, scope: emptyScope(provider), error: "Couldn't load models" });
      });

    return () => controller.abort();
  }, [provider, nonce]);

  const fresh = provider && loaded?.provider === provider ? loaded : null;
  return {
    scope: fresh?.scope ?? null,
    loading: Boolean(provider) && !fresh,
    error: fresh?.error ?? null,
    refresh,
  };
}
