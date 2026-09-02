"use client";

import { useEffect, useMemo, useState } from "react";
import {
  fetchProviderCatalog,
  getProviderCatalog,
  type ResolvedProviderCatalog,
} from "@/lib/provider-models";
import { PROVIDER_SIGNAL_DEBOUNCE_MS, PROVIDERS_CHANGED_EVENT } from "@/lib/ui-events";

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
 * Poll while the box is WARMING — an enumeration is in flight and a later ask
 * gets a better answer. Asking once and keeping the curated three for the rest
 * of the session is the defect this exists to end.
 *
 * Deliberately not "poll while `fallback`". A provider that cannot enumerate at
 * all — plugin gone, no CLI on this edition — serves a fallback forever, and
 * polling that is a request loop with no destination; it also fires in every
 * test whose fetch stub answers the catalog route with `{}`. The route says
 * `warming` only while a fork is actually out there, and holds the failed-
 * refresh backoff behind it, so the two brakes agree.
 *
 * Backed off rather than polled flat because the wait is ~3 minutes on a
 * Jetson and instant on a warm box, and capped so nothing asks forever.
 */
const WARMING_RETRY_BASE_MS = 2_000;
const WARMING_RETRY_MAX_MS = 60_000;
const WARMING_RETRY_ATTEMPTS = 12;

/**
 * Returns the RESOLVED catalogue — the models plus whether a device produced
 * them. The `fallback` flag was previously erased at this boundary, which left
 * the retry below as its only consumer: a picker could not tell "these are the
 * box's models" from "these are three hard-coded names while we wait", which
 * is the distinction this whole path exists to carry.
 */
export function useProviderCatalog(
  provider: string | null | undefined,
): ResolvedProviderCatalog | null {
  const fallback = useMemo<ResolvedProviderCatalog | null>(
    () => {
      const curated = provider ? getProviderCatalog(provider) : null;
      // The pre-fetch render is a fallback by definition — nothing has been
      // asked yet — so it says so rather than looking like an answer.
      return curated ? { ...curated, fallback: true } : null;
    },
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
          if (!next.warming || attempt >= WARMING_RETRY_ATTEMPTS) return;
          const delay = Math.min(WARMING_RETRY_BASE_MS * 2 ** attempt, WARMING_RETRY_MAX_MS);
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

    // PROVIDERS_CHANGED_EVENT alone, NOT the `onProvidersChanged` union.
    //
    // That helper also spans CHAT_MODEL_STATE_EVENT, which means "the chat's
    // model SELECTION changed" — an event ChatPopup dispatches itself, on every
    // switch. A catalogue does not change when someone picks a different row
    // out of it, so listening to it would re-fetch with `?refresh=1` on each
    // switch and ask a Jetson for a fresh three-minute enumeration for nothing.
    // Measured as a real re-render storm: it broke an unrelated ChatPopup test
    // that switches model mid-run.
    //
    // Every site that changes the provider SET — a key saved, an OAuth flow
    // approved, a provider enabled or removed, a new default — calls
    // `notifyProvidersChanged()`, which dispatches exactly this event.
    let signalTimer: ReturnType<typeof setTimeout> | null = null;
    const onSignal = () => {
      if (signalTimer) clearTimeout(signalTimer);
      signalTimer = setTimeout(() => {
        signalTimer = null;
        setReloads((n) => n + 1);
      }, PROVIDER_SIGNAL_DEBOUNCE_MS);
    };
    window.addEventListener(PROVIDERS_CHANGED_EVENT, onSignal);

    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
      if (signalTimer) clearTimeout(signalTimer);
      window.removeEventListener(PROVIDERS_CHANGED_EVENT, onSignal);
    };
  }, [provider, reloads]);

  if (!provider) return null;
  return live?.provider === provider ? live.catalog : fallback;
}
