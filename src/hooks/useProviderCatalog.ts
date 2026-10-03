"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchProviderCatalog,
  getProviderCatalog,
  isCatalogProvider,
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
      && model.hint === b.models[i].hint
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
 *
 * Null, WITHOUT a request, for a provider the route has no catalogue for — the
 * box's own llama.cpp / Ollama above all (TASK-1196). The chat header passes
 * whatever provider the active row names, and on a local-model box every chat
 * open, provider signal and remount asked `?provider=llamacpp` and drew the
 * route's "Unknown provider" 400, for an answer that could only ever be null:
 * there is no curated list for such a provider and never a live one.
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
  // What `live` holds, for the fetch callbacks: an answer the picker already
  // shows is dropped BEFORE it reaches React. Handing the setter an updater
  // that returns the same object is not free — after a commit React may still
  // call the whole host component once to find out nothing moved, and the
  // host is the chat popup, rendered whole for a catalogue it already draws.
  const liveRef = useRef<LiveCatalog | null>(null);

  useEffect(() => {
    if (!provider || !isCatalogProvider(provider)) return;
    // Replaced, not reused, when a provider-set signal restarts the reads: the
    // old request's answer predates the change and must never land.
    let ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const load = (refresh: boolean) => {
      const { signal } = ctrl;
      fetchProviderCatalog(provider, { signal, refresh })
        .then((next) => {
          if (signal.aborted) return;
          // Only when something actually changed. During a warm-up every poll
          // returns the same curated rows, and a fresh object identity there
          // re-runs eight memos and two setState effects in AIModelsStep and
          // the same again in ChatPopup, per poll, per mounted picker.
          const current = liveRef.current;
          if (!(current && current.provider === provider && sameCatalog(current.catalog, next))) {
            const fresh = { provider, catalog: next };
            liveRef.current = fresh;
            setLive(fresh);
          }
          if (!next.warming || attempt >= WARMING_RETRY_ATTEMPTS) return;
          const delay = Math.min(WARMING_RETRY_BASE_MS * 2 ** attempt, WARMING_RETRY_MAX_MS);
          attempt += 1;
          timer = setTimeout(() => load(false), delay);
        })
        .catch((err) => {
          if (signal.aborted) return;
          console.warn(`[useProviderCatalog] fetch failed for ${provider}:`, err);
        });
    };

    // A plain read: the route's own warm-up and backoff decide what it serves.
    // Never `?refresh=1` merely because the provider changed — that made every
    // later provider switch in the picker send it for a provider that had
    // received no signal at all, a fresh ~3-minute fork on a Jetson for a
    // catalogue that was already live.
    load(false);

    // The provider SET changed — a key saved, an OAuth flow approved, a
    // provider enabled or removed, a new default. Deliberately NOT the whole
    // `PROVIDER_SIGNAL_EVENTS` union: it also spans CHAT_MODEL_STATE_EVENT,
    // which means "the chat's model SELECTION changed", and a catalogue does
    // not change when someone picks a different row out of the list it already
    // has. Waking on it would ask a Jetson to re-enumerate on every switch.
    //
    // A connect is exactly when the catalogue becomes enumerable — the plugin
    // is enabled and the credential is written — so that ONE read asks the
    // route to re-enumerate rather than serve the pre-connect snapshot. The
    // warming polls that may follow do not: the route is already enumerating,
    // and telling it to start again on each poll is how a picker turns a
    // three-minute fork into several.
    //
    // Restarted right here rather than through a state counter that re-ran
    // this effect: the counter rendered the host — the whole chat popup — on
    // every signal just to get here, and a catalogue that came back the same
    // then cost nothing more. The restart is the one the re-run did: the read
    // in flight and the warming poll dropped, the poll's budget back to zero.
    const off = onProvidersChanged(
      () => {
        ctrl.abort();
        if (timer) clearTimeout(timer);
        timer = null;
        ctrl = new AbortController();
        attempt = 0;
        load(true);
      },
      { events: [PROVIDERS_CHANGED_EVENT] },
    );

    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
      off();
    };
  }, [provider]);

  if (!provider) return null;
  return live?.provider === provider ? live.catalog : fallback;
}
