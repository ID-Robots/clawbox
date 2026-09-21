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
 * The self-polling rule, in one place because it is the half of TASK-663 the
 * server cannot enforce.
 *
 * BOUNDED IN RATE, NEVER IN COUNT, while the box says `checking`. The server's
 * checking window belongs to the unit, not to a constant here: a dashboard in
 * `ExecStartPre` on a loaded box is legitimately starting for as long as its
 * `TimeoutStartSec` allows. A fixed number of polls is therefore a promise this
 * side cannot keep, and breaking it produces the worst outcome of the three —
 * the last poll is answered "still checking", nothing books another read, and
 * the panel holds spinner rows with NO banner for the life of the mount, on a
 * box that answers fine seconds later. Worse than the "Unknown + degraded"
 * this feature replaced, because that at least said something.
 *
 * What makes unbounded polling safe is the server's side of the same contract:
 * `probeStillOwed` is bounded in every branch, so a `checking` answer always
 * stops coming (`MAX_CHECKING_WINDOW_MS`, pinned by
 * `src/tests/unit/checking-retry-budget.test.ts`). The rate is the shared
 * degraded schedule, which settles at `DEGRADED_RETRY_MAX_MS`, and the loop
 * ends with the mount — nothing else ends it, deliberately.
 *
 * A FAILED read does not end it either, and that is the same rule rather than an
 * exception to it: a read that failed is no evidence the probe finished, so the
 * last thing the box actually said still stands. A count of failures was tried
 * here and it recreated the bug one door along — the setup server restarting
 * itself (an in-app update does exactly that) spends the count in under a
 * minute, and the panel then holds "Checking..." rows for the life of the mount
 * with `HermesProviderConfig` showing no message at all, since its read-error
 * line needs a NULL summary. The endpoint is this same server, served to this
 * same page: if it is gone the page is already broken, and one poll every eight
 * seconds is how it notices when it comes back.
 */

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
  /**
   * The last `setDefault` SUCCEEDED, but the box qualified it. On OpenClaw the
   * route folds TWO causes into this: the gateway had not finished restarting
   * when it answered, and the restart was refused (a unit masked by an update
   * in flight). The forwarded sentence says which. The default is written
   * either way; this is a notice, and the panel must not paint it as a failure.
   */
  defaultWarning: string | null;
  setDefault: (providerId: string) => Promise<void>;
  refresh: () => void;
}

export function useProviderStatus(options: { enabled?: boolean } = {}): UseProviderStatus {
  const enabled = options.enabled ?? true;
  const [summary, setSummary] = useState<ProviderStatusSummary | null>(null);
  const [error, setError] = useState(false);
  const [settingDefault, setSettingDefault] = useState<string | null>(null);
  const [defaultError, setDefaultError] = useState<string | null>(null);
  const [defaultWarning, setDefaultWarning] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Guards a setState after unmount, and lets a slow answer for a previous
  // nonce be discarded rather than overwriting a newer one.
  const controllerRef = useRef<AbortController | null>(null);
  // Which step of the backoff the next self-poll is on. Reset by the first
  // answer with nothing left to check, so a later boot (a gateway restart from
  // Settings) starts again at the fast end rather than at the slow one.
  const backoffStepRef = useRef(0);
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
        backoffStepRef.current = 0;
        return;
      }
      retryTimer = setTimeout(refresh, degradedRetryDelayMs(backoffStepRef.current));
      backoffStepRef.current += 1;
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
        // booting. Asked again for as long as that promise stands — see the
        // rule at the top of this file.
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
    setDefaultWarning(null);
    try {
      const res = await fetch("/setup-api/providers/default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: unknown; warning?: unknown };
      if (!res.ok) {
        throw new Error(typeof data.error === "string" && data.error ? data.error : `HTTP ${res.status}`);
      }
      // A qualified success is still a success. The route answers `ok` with a
      // `warning` when the default IS written and only the gateway restart is
      // still in flight, so everything below must still run — skipping it would
      // leave the star on the old provider over a change that landed.
      if (typeof data.warning === "string" && data.warning) setDefaultWarning(data.warning);
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
    defaultWarning,
    setDefault,
    refresh,
  };
}
