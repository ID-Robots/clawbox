"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchProviderCatalog,
  getProviderCatalog,
  type ResolvedProviderCatalog,
} from "@/lib/provider-models";
import { onProvidersChanged, PROVIDERS_CHANGED_EVENT } from "@/lib/ui-events";

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
 * Same answer? Compared field by field rather than by identity, because the
 * route mints a new object per request and most warming polls carry rows the
 * picker is already rendering.
 */
function sameCatalog(a: ResolvedProviderCatalog, b: ResolvedProviderCatalog): boolean {
  return a.defaultModelId === b.defaultModelId
    && a.allowCustom === b.allowCustom
    && a.fallback === b.fallback
    && a.warming === b.warming
    && a.stale === b.stale
    && a.models.length === b.models.length
    && a.models.every((model, i) => (
      model.id === b.models[i].id
      && model.label === b.models[i].label
      && model.availableOnSubscription === b.models[i].availableOnSubscription
    ));
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
  // Set by the provider-set signal, read and cleared by the next load. A REF,
  // not the reload counter: `reloads > 0` stays true for the rest of the
  // session after any connect, so using it as "force a re-enumeration" made
  // every later provider switch in the picker send `?refresh=1` for a provider
  // that had received no signal at all — a fresh ~3-minute fork on a Jetson
  // for a catalogue that was already live.
  const forceNextLoad = useRef(false);
  // Bumped by the same signal, purely to re-run the effect.
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
          // Only when something actually changed. During a warm-up every poll
          // returns the same curated rows, and a fresh object identity there
          // re-runs eight memos and two setState effects in AIModelsStep and
          // the same again in ChatPopup, per poll, per mounted picker.
          setLive((current) => (
            current && current.provider === provider && sameCatalog(current.catalog, next)
              ? current
              : { provider, catalog: next }
          ));
          if (!next.warming || attempt >= WARMING_RETRY_ATTEMPTS) return;
          const delay = Math.min(WARMING_RETRY_BASE_MS * 2 ** attempt, WARMING_RETRY_MAX_MS);
          attempt += 1;
          timer = setTimeout(() => load(false), delay);
        })
        .catch((err) => {
          if (ctrl.signal.aborted) return;
          console.warn(`[useProviderCatalog] fetch failed for ${provider}:`, err);
        });
    };

    // A connect is exactly when the catalogue becomes enumerable — the plugin
    // is enabled and the credential is written — so that ONE read asks the
    // route to re-enumerate rather than serve the pre-connect snapshot. The
    // warming polls that may follow do not: the route is already enumerating,
    // and telling it to start again on each poll is how a picker turns a
    // three-minute fork into several.
    const force = forceNextLoad.current;
    forceNextLoad.current = false;
    load(force);

    // The provider SET changed — a key saved, an OAuth flow approved, a
    // provider enabled or removed, a new default. Deliberately NOT the whole
    // `PROVIDER_SIGNAL_EVENTS` union: it also spans CHAT_MODEL_STATE_EVENT,
    // which means "the chat's model SELECTION changed", and a catalogue does
    // not change when someone picks a different row out of the list it already
    // has. Waking on it would ask a Jetson to re-enumerate on every switch.
    const off = onProvidersChanged(
      () => {
        forceNextLoad.current = true;
        setReloads((n) => n + 1);
      },
      { events: [PROVIDERS_CHANGED_EVENT] },
    );

    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
      off();
    };
  }, [provider, reloads]);

  if (!provider) return null;
  return live?.provider === provider ? live.catalog : fallback;
}
