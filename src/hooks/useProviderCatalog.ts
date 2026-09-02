"use client";

import { useEffect, useMemo, useState } from "react";
import {
  fetchProviderCatalog,
  getProviderCatalog,
  type ProviderCatalog,
  type ResolvedProviderCatalog,
} from "@/lib/provider-models";
import { onProvidersChanged } from "@/lib/ui-events";

/**
 * Resolve the live model catalog for `provider` via
 * /setup-api/ai-models/catalog, with the static cold-start arrays in
 * provider-models.ts as fallback while the fetch is in flight.
 *
 * Both AIModelsStep and the chat-popup model switcher used to inline
 * the fetch + AbortController + fallback dance themselves; the two
 * copies drifted on the first follow-up edit. This hook collapses both
 * to a single source of truth.
 *
 * The fallback comes from a useMemo (static, no state churn) so the
 * "provider unchanged" path doesn't snap the catalog back to fallback
 * before the live fetch resolves — that flicker bit the chat header on
 * every WS poll. Live results live in their own state and are returned
 * in preference whenever they match the current provider; stale fetches
 * (provider changed before the previous fetch resolved) are aborted and
 * discarded so the consumer never sees a wrong-provider catalog.
 */
interface LiveCatalog {
  provider: string;
  catalog: ResolvedProviderCatalog;
}

/**
 * A catalogue marked `fallback` is a placeholder, not an answer: the box has
 * not enumerated one yet (the refresh behind the route takes ~3 minutes on a
 * Jetson), or the provider only just became listable. Asking once and keeping
 * the curated three for the rest of the session is the defect this retry
 * exists to end.
 *
 * Backed off rather than polled flat because the wait is minutes on the slow
 * path and instant on the fast one, and capped so an unconfigurable provider —
 * one that will never enumerate — does not leave a picker asking forever. The
 * route answers each of these from cache and single-flights the refresh
 * behind it, so a retry costs one cheap request.
 */
const FALLBACK_RETRY_BASE_MS = 2_000;
const FALLBACK_RETRY_MAX_MS = 60_000;
const FALLBACK_RETRY_ATTEMPTS = 12;

export function useProviderCatalog(provider: string | null | undefined): ProviderCatalog | null {
  const fallback = useMemo(
    () => (provider ? getProviderCatalog(provider) : null),
    [provider],
  );
  const [live, setLive] = useState<LiveCatalog | null>(null);
  // Bumped by the providers-changed signal. It is in the dependency list, so a
  // connect re-runs the effect with `refresh` set instead of the effect having
  // to reach a fetch that has already been torn down.
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    if (!provider) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const load = (refresh: boolean) => {
      fetchProviderCatalog(provider, { signal: ctrl.signal, refresh })
        .then((next) => {
          if (ctrl.signal.aborted) return;
          setLive({ provider, catalog: next });
          if (!next.fallback || attempt >= FALLBACK_RETRY_ATTEMPTS) return;
          const delay = Math.min(FALLBACK_RETRY_BASE_MS * 2 ** attempt, FALLBACK_RETRY_MAX_MS);
          attempt += 1;
          timer = setTimeout(() => load(true), delay);
        })
        .catch((err) => {
          if (ctrl.signal.aborted) return;
          console.warn(`[useProviderCatalog] fetch failed for ${provider}:`, err);
        });
    };

    // A connect is exactly when the catalogue becomes enumerable — the plugin
    // is enabled and the credential is written — so that read asks the route
    // to re-enumerate rather than serve the pre-connect snapshot.
    load(reloads > 0);
    const off = onProvidersChanged(() => setReloads((n) => n + 1));

    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
      off();
    };
  }, [provider, reloads]);

  if (!provider) return null;
  return live?.provider === provider ? live.catalog : fallback;
}
