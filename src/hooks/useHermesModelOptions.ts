"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  HERMES_MODEL_STATE_EVENT,
  notifyHermesModelState,
  onProvidersChanged,
} from "@/lib/ui-events";
import {
  DEGRADED_RETRY_BASE_MS,
  DEGRADED_RETRY_MAX_MS,
  DEGRADED_RETRY_ATTEMPTS,
  degradedRetryDelayMs,
} from "@/lib/degraded-retry";

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
 *
 * Both now LIVE in `@/lib/ui-events`, next to the edition-neutral signal that
 * supersedes them, and are re-exported here so every existing importer — and
 * the test that pins the string — keeps working unchanged.
 */
export { HERMES_MODEL_STATE_EVENT, notifyHermesModelState };

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
  /** The box HAD a live catalogue and could not refresh it — not a cold box. */
  degraded?: "dashboard-unreachable";
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

/**
 * True when the box handed back a PLACEHOLDER rather than its answer.
 *
 * `stale` means "this did not come from the live Hermes dashboard" — the reply
 * was built from Hermes' on-disk manifest (which only ever carries `openrouter`
 * and `nous`, and knows nothing about this device) or from the cold-start
 * floor. For a provider the manifest has never heard of, that reply is `models:
 * []` with HTTP 200: indistinguishable, to every consumer that does not read
 * this flag, from "this provider serves nothing".
 *
 * `stale === false` is already the box's own readiness signal on this route:
 * `SetupWizard.pollHermesReady` polls it to decide the Hermes dashboard has
 * come up. This reads the same flag for the same fact — the chat header simply
 * never adopted it.
 *
 * Only `stale` is consulted, never `source`: a reply that omits the field
 * entirely is not evidence of degradation, and treating it as such would put
 * every such caller into a retry loop.
 */
function isPlaceholder(scope: HermesModelScope | null | undefined): boolean {
  return scope?.stale === true;
}

/**
 * The same JSON value, whatever object identity it arrived in. The scope is the
 * route's payload as parsed, so this compares exactly what a re-read can bring
 * back — every field, the ones a later server adds included — rather than a
 * hand-kept list of the fields this file happens to know about today.
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameJson(item, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameJson(left[key], right[key]));
}

/**
 * Go back for the real catalogue, with backoff, while the box is still
 * answering with a placeholder.
 *
 * This is the OpenClaw picker's `warming` loop (`useProviderCatalog`), pointed
 * at the fact the Hermes payload already publishes. Every reboot has a window
 * of it: `clawbox-setup` logs "Ready in 0ms" and starts serving while
 * `clawbox-hermes-dashboard` needs another 11-12 s, and a chat opened in that
 * window used to keep the empty answer for the rest of the session — the model
 * pill needs more than one id to render at all, so it simply never appeared.
 *
 * Bounded for the same reason that one is: a box whose dashboard is not coming
 * back must not be polled forever, and while these retries run the surfaces
 * read as LOADING — including the Settings panel's model select, which holds
 * back its own "this list is stale" note until they settle. The schedule and
 * that reasoning now live in `@/lib/degraded-retry`, shared with the two other
 * surfaces that wait out the same boot window.
 */
// Re-exported so the callers that already import the schedule from this hook
// keep working; the schedule itself lives in `@/lib/degraded-retry`, which has
// no React and no imports, so a surface that is not a hook can share it.
export {
  DEGRADED_RETRY_BASE_MS,
  DEGRADED_RETRY_MAX_MS,
  DEGRADED_RETRY_ATTEMPTS,
  degradedRetryDelayMs,
};

export function useHermesModelOptions(provider: string | null): UseHermesModelOptions {
  // One state cell written only from async callbacks — `loading` is DERIVED
  // from "what we hold isn't for the provider we were asked about", so
  // switching provider needs no synchronous setState (and no extra render).
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  // What `loaded` holds, for the fetch callbacks: an answer that is what the
  // hook already hands out is dropped BEFORE it reaches React. A fresh object
  // with the same contents is a new `scope` to every memo downstream, and the
  // host here is the chat popup — rendered whole for a list it already draws.
  const loadedRef = useRef<LoadedState | null>(null);
  // Bumped by `refresh` alone, the owner's explicit ask: re-running the load
  // effect is the point there. A provider-set signal restarts the load inside
  // the effect instead (see below).
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

  useEffect(() => {
    if (!provider) return;
    // Abort the previous provider's request so a slow response for the OLD
    // provider can never land after the user has already moved on. Replaced,
    // not reused, when a provider-set signal restarts the load below: the read
    // it drops predates the change and must never land either.
    controllerRef.current?.abort();
    let controller = new AbortController();
    controllerRef.current = controller;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    /** Hand an answer over — unless it is exactly what is already handed out. */
    const settle = (next: LoadedState) => {
      const shown = loadedRef.current;
      if (
        shown
        && shown.provider === next.provider
        && shown.error === next.error
        && sameJson(shown.scope, next.scope)
      ) return;
      loadedRef.current = next;
      setLoaded(next);
    };

    /** Ask again later, keeping what is on screen. True when one was booked. */
    const retryLater = (): boolean => {
      if (attempt >= DEGRADED_RETRY_ATTEMPTS) return false;
      // ALWAYS a plain load, never the user's `refresh=1`. That flag busts
      // Hermes' per-provider disk cache and re-enumerates every provider's live
      // /v1/models, and this schedule (1+2+4+8+8+8 s) crosses the server's 10 s
      // throttle twice — so carrying it would turn one Refresh click on a
      // degraded box into three device-wide sweeps. It also could not help: a
      // placeholder means the dashboard is unreachable, and `?refresh=true`
      // goes to that same dashboard.
      timer = setTimeout(() => load(false), degradedRetryDelayMs(attempt));
      attempt += 1;
      return true;
    };

    const load = (refresh: boolean) => {
      // This read's own signal: a restart swaps `controller` for a new one,
      // and the answer to a read it dropped must still see itself aborted.
      const { signal } = controller;
      const url = `/setup-api/hermes/models?provider=${encodeURIComponent(provider)}${refresh ? "&refresh=1" : ""}`;
      fetch(url, { cache: "no-store", signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((data: HermesModelScope) => {
          if (signal.aborted) return;
          // The request COMPLETED, which is the condition this flag is cleared
          // on — a degraded body is still the server answering. Only an ABORT
          // (fast provider switch, StrictMode double-mount) carries the intent
          // over, because that request never got an answer at all.
          pendingRefreshRef.current = false;
          // Read the RESPONSE's own flag, not the substituted scope's:
          // `emptyScope` is `stale: true` by construction, so gating on it would
          // put the provider-mismatch guard below into the retry loop as well.
          const placeholder = isPlaceholder(data);
          if (placeholder && retryLater()) {
            // Deliberately NOT installed: `loaded` is what makes `loading` go
            // false, and a placeholder is not something to settle on. Holding
            // it keeps the model pill in its place with the loading label
            // instead of collapsing the header, and keeps the send path saying
            // "still loading this provider's models" (`modelsReady`) rather
            // than "this provider has none".
            return;
          }
          if (placeholder) {
            // The budget is spent and the box is STILL answering with the
            // manifest: the dashboard is not coming back on its own. Settle —
            // a box whose harness is gone must not be polled for ever — but
            // settle honestly. This used to install the placeholder with
            // `error: null`, which is how a dead dashboard rendered as a
            // provider that simply has these models; the rejected-request
            // branch below already reported the same fact. TASK-678.
            settle({
              provider,
              scope: data?.provider === provider ? data : emptyScope(provider),
              error: "Couldn't load models",
            });
            return;
          }
          // Guard against a stale/garbled payload naming a different provider.
          settle({
            provider,
            scope: data?.provider === provider ? data : emptyScope(provider),
            error: null,
          });
        })
        .catch((err) => {
          if (signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
          // Cleared here too, and BEFORE the retry: only an abort preserves the
          // intent (see above). An HTTP error, a dropped connection and a
          // failed parse all leave this branch with retries pending, and a
          // provider switch inside that window would re-run the effect and send
          // `refresh=1` for a provider the owner never clicked Refresh on — the
          // same device-wide /v1/models sweep, through a third door.
          pendingRefreshRef.current = false;
          // A REJECTED request is the same news as a placeholder, and it is the
          // shape the reported incident actually took: the box restarted three
          // times inside four minutes, so the reads in that window were dropped
          // connections and 502s, not tidy degraded 200s. Retrying only the
          // polite failure would have left the observed case unfixed.
          if (retryLater()) return;
          settle({ provider, scope: emptyScope(provider), error: "Couldn't load models" });
        });
    };

    // Only the FIRST attempt carries the user's explicit refresh. A retry must
    // not: `refresh=1` busts Hermes' per-provider disk cache and re-enumerates
    // every provider's live /v1/models, which is a device-wide sweep to answer
    // "is the dashboard up yet?".
    load(pendingRefreshRef.current);

    // A provider configured elsewhere in the UI changes what this scope should
    // contain, but this effect only re-runs when the PROVIDER changes — so
    // without this the panel and the chat header kept serving the pre-configure
    // answer until the page was reloaded.
    //
    // Note what this deliberately does NOT do: call `refresh`. It re-asks the
    // route plainly, which is enough because the write that emitted the signal
    // already invalidated the server's caches. Going through `refresh` would
    // set the explicit flag and make the server bust Hermes' own per-provider
    // disk cache and re-enumerate EVERY provider's live /v1/models — a
    // device-wide sweep to answer "is there a new provider in the list?". (A
    // Refresh the owner pressed whose read is still out is the one exception,
    // and only because that read is dropped here: the intent rides over to the
    // read that replaces it, as it does across a provider switch.)
    //
    // It also leaves `loaded` in place, so `fresh` (and therefore `loading`) is
    // unchanged: the chat's model pill keeps its place instead of collapsing.
    //
    // Restarted right here rather than through a state counter that re-ran
    // this effect: the counter rendered the host — the whole chat popup — on
    // every signal just to get here, including on an OpenClaw box, where the
    // provider is null and nothing was ever asked. Listening only while there
    // is a provider ends that too. The restart is the one the re-run did: the
    // read in flight and a booked retry dropped, the retry budget back to zero.
    //
    // Subscribed through `onProvidersChanged` rather than to the Hermes name
    // alone: a provider connected anywhere in the UI is the same news whichever
    // vocabulary the emitter happened to use, and the shared subscriber also
    // debounces — a key save legitimately emits twice (credential, then pairing)
    // and this hook would otherwise re-ask the route for both halves.
    const off = onProvidersChanged(() => {
      controller.abort();
      if (timer) clearTimeout(timer);
      timer = null;
      controller = new AbortController();
      controllerRef.current = controller;
      attempt = 0;
      load(pendingRefreshRef.current);
    });

    return () => {
      if (timer) clearTimeout(timer);
      controller.abort();
      off();
    };
  }, [provider, nonce]);

  const fresh = provider && loaded?.provider === provider ? loaded : null;
  return {
    scope: fresh?.scope ?? null,
    loading: Boolean(provider) && !fresh,
    error: fresh?.error ?? null,
    refresh,
  };
}
