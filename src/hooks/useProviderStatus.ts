"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { notifyProvidersChanged, onProvidersChanged } from "@/lib/ui-events";
import { forgetHermesProviderPreference } from "@/lib/hermes-chat-prefs";
import { degradedRetryDelayMs } from "@/lib/degraded-retry";
import type { ProviderStatusSummary } from "@/lib/provider-status";

/**
 * The connection overview, kept live.
 *
 * Reads `/setup-api/providers/status` once, then re-reads it whenever anything
 * anywhere says the providers changed — so the strip flips to "Connected" while
 * the customer is still looking at the sign-in they just finished, rather than
 * on the next page load.
 *
 * The re-read is DEBOUNCED by `onProvidersChanged`, which matters more here
 * than for the other listeners: on Hermes this endpoint's answer comes from the
 * dashboard, and saving a key legitimately emits the signal twice (once for the
 * credential, once for the pairing).
 *
 * ...and it re-reads ON ITS OWN while any row is `checking`. Nothing emits a
 * signal when a harness finishes booting, so without this the panel that
 * happened to open during those seconds would sit on a spinner until the
 * customer navigated away and back — which is how a state that resolves in
 * eleven seconds server-side was on screen for minutes.
 */

/**
 * How many times a `checking` answer is re-asked, on the schedule the model
 * catalogue's own degraded retries use.
 *
 * The budget must OUTLAST the server's own checking window (`PROBE_GRACE_MS`),
 * or the last poll is answered "still checking" by a window that is about to
 * close and the panel settles for good on a spinner. The two constants live in
 * different modules — one of them server-only — so the relationship is pinned
 * by a test rather than by these two comments agreeing; see
 * `checking-retry-budget.test.ts` and {@link checkingRetryBudgetMs}.
 */
export const CHECKING_RETRY_ATTEMPTS = 7;

/** Wall-clock span of the whole retry schedule, for that test. */
export function checkingRetryBudgetMs(): number {
  let total = 0;
  for (let attempt = 0; attempt < CHECKING_RETRY_ATTEMPTS; attempt++) {
    total += degradedRetryDelayMs(attempt);
  }
  return total;
}

export interface UseProviderStatus {
  /** Null until the first load lands. */
  summary: ProviderStatusSummary | null;
  loading: boolean;
  /** Set when the last load failed. The strip says so rather than going blank. */
  error: boolean;
  /** The provider whose "make default" call is in flight, or null. */
  settingDefault: string | null;
  /** Rejected reason from the last `setDefault`, or null. */
  defaultError: string | null;
  setDefault: (providerId: string) => Promise<void>;
  refresh: () => void;
}

export function useProviderStatus(options: { enabled?: boolean } = {}): UseProviderStatus {
  const enabled = options.enabled ?? true;
  const [summary, setSummary] = useState<ProviderStatusSummary | null>(null);
  const [error, setError] = useState(false);
  const [settingDefault, setSettingDefault] = useState<string | null>(null);
  const [defaultError, setDefaultError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Guards a setState after unmount, and lets a slow answer for a previous
  // nonce be discarded rather than overwriting a newer one.
  const controllerRef = useRef<AbortController | null>(null);
  // How many `checking` answers this hook has already re-asked. Reset by the
  // first answer with nothing left to check, so a later boot (a gateway
  // restart from Settings) gets a fresh budget rather than the exhausted one.
  const checkingAttemptRef = useRef(0);
  // Whether the last answer we actually got had a row still being checked. Read
  // by the FAILURE path, which has no body to look at: a read that failed is no
  // evidence the probe finished, and booking no retry there would end the loop
  // on the first transient 500 with the spinner frozen on screen.
  const checkingRef = useRef(false);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // Booked from BOTH the success and the failure path — see `checkingRef`.
    const scheduleRetry = () => {
      if (!checkingRef.current) {
        checkingAttemptRef.current = 0;
        return;
      }
      if (checkingAttemptRef.current >= CHECKING_RETRY_ATTEMPTS) return;
      retryTimer = setTimeout(refresh, degradedRetryDelayMs(checkingAttemptRef.current));
      checkingAttemptRef.current += 1;
    };

    fetch("/setup-api/providers/status", { cache: "no-store", signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: ProviderStatusSummary) => {
        if (controller.signal.aborted) return;
        // Shape-checked before it is trusted. A stubbed or truncated body that
        // answered 200 with no `providers` array would otherwise reach the
        // strip and throw on `.length` — turning a degraded read into a blank
        // Settings pane.
        if (!data || !Array.isArray(data.providers)) throw new Error("Malformed status");
        setSummary(data);
        setError(false);
        // A `checking` row is a promise that this answer is going to change,
        // and nothing else on the page emits a signal when a harness finishes
        // booting. Bounded, so a box that never answers still stops polling.
        checkingRef.current = data.providers.some((row) => row.state === "checking");
        scheduleRetry();
      })
      .catch((err) => {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
        // Keep the last good answer on screen. A strip that empties itself on a
        // transient failure reads as "everything disconnected", which is the one
        // thing it must never say by accident.
        setError(true);
        scheduleRetry();
      });

    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [enabled, nonce, refresh]);

  useEffect(() => {
    if (!enabled) return;
    return onProvidersChanged(refresh);
  }, [enabled, refresh]);

  const setDefault = useCallback(async (providerId: string) => {
    setSettingDefault(providerId);
    setDefaultError(null);
    try {
      const res = await fetch("/setup-api/providers/default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (!res.ok) {
        throw new Error(typeof data.error === "string" && data.error ? data.error : `HTTP ${res.status}`);
      }
      // An explicit default outranks whatever the chat remembered from an
      // ad-hoc pick, or the chat would keep opening on the provider that was
      // just replaced. Harmless on OpenClaw, where the key is never written.
      forgetHermesProviderPreference();
      // Tell everything else — the chat header, the capability probe, and this
      // hook's own listener, which is what repaints the star.
      notifyProvidersChanged();
    } catch (e) {
      setDefaultError(e instanceof Error ? e.message : "Could not set the default");
    } finally {
      setSettingDefault(null);
    }
  }, []);

  return {
    summary,
    loading: enabled && summary === null && !error,
    error,
    settingDefault,
    defaultError,
    setDefault,
    refresh,
  };
}
