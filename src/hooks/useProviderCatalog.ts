"use client";

import { useEffect, useMemo, useState } from "react";
import {
  fetchProviderCatalog,
  getProviderCatalog,
  type ProviderCatalog,
} from "@/lib/provider-models";

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
  catalog: ProviderCatalog;
}

export function useProviderCatalog(provider: string | null | undefined): ProviderCatalog | null {
  const fallback = useMemo(
    () => (provider ? getProviderCatalog(provider) : null),
    [provider],
  );
  const [live, setLive] = useState<LiveCatalog | null>(null);

  useEffect(() => {
    if (!provider) return;
    const ctrl = new AbortController();
    fetchProviderCatalog(provider, { signal: ctrl.signal })
      .then((next) => {
        if (ctrl.signal.aborted) return;
        setLive({ provider, catalog: next });
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        console.warn(`[useProviderCatalog] fetch failed for ${provider}:`, err);
      });
    return () => ctrl.abort();
  }, [provider]);

  if (!provider) return null;
  return live?.provider === provider ? live.catalog : fallback;
}
