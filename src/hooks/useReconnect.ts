"use client";

import { useEffect, useRef, useState } from "react";

export type ReconnectPhase = "grace" | "probing" | "ready";

export interface UseReconnectOptions {
  /**
   * Reachability check, called once per attempt (1-indexed) after the grace
   * period, then every `intervalMs` until it resolves true. The mechanism
   * varies by handoff kind — a same-origin `fetch`, a cross-origin `<img>`
   * load, a no-cors ping — but the grace/poll/settle engine around it is
   * identical, which is what this hook owns.
   */
  probe: (attempt: number) => Promise<boolean>;
  /**
   * Fired exactly once, `readyDelayMs` after the first successful probe (or
   * immediately when a `hardTimeoutMs` fallback trips). This is the redirect /
   * continue / reload the caller wants once the device is back.
   */
  onReady: () => void;
  /** Wait before the first probe — the link needs a moment to actually drop. */
  graceMs?: number;
  /** Delay between failed probes. */
  intervalMs?: number;
  /** Hold on the "back online" phase this long before `onReady` (0 = immediate). */
  readyDelayMs?: number;
  /** Fallback: fire `onReady` unconditionally after this long, even if no probe ever succeeded. */
  hardTimeoutMs?: number;
  /** When false the engine stays idle (no timers armed). Flip true to start. */
  enabled?: boolean;
}

/**
 * Shared controller for the "device dropped, wait for it to come back" flow
 * behind the setup/settings reconnect overlays. Collapses the duplicated
 * grace-timer → probe-loop → settle engine that lived in `WifiHandoffOverlay`,
 * `CredentialsHandoffOverlay`, `ReconnectingOverlay`, and the hostname-reboot
 * effect in `SettingsApp`. Callers supply the reachability `probe` and the
 * `onReady` action; everything about timing, cancellation, and single-firing
 * lives here.
 *
 * Returns the current phase so overlays can drive their step UI. Side-effect
 * callers (no UI) can ignore it.
 */
export function useReconnect({
  probe,
  onReady,
  graceMs = 4000,
  intervalMs = 2500,
  readyDelayMs = 0,
  hardTimeoutMs,
  enabled = true,
}: UseReconnectOptions): ReconnectPhase {
  const [phase, setPhase] = useState<ReconnectPhase>("grace");

  // Callers pass inline closures for probe/onReady whose identity changes every
  // render; keep them in refs so a parent re-render doesn't tear down and
  // restart the engine effect (which would reset the grace timer mid-handoff).
  const probeRef = useRef(probe);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    probeRef.current = probe;
  }, [probe]);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let fired = false;
    let loopTimer: ReturnType<typeof setTimeout> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    setPhase("grace");

    const fire = () => {
      if (cancelled || fired) return;
      fired = true;
      setPhase("ready");
      settleTimer = setTimeout(() => {
        if (!cancelled) onReadyRef.current();
      }, readyDelayMs);
    };

    const graceTimer = setTimeout(() => {
      if (cancelled) return;
      setPhase("probing");
      let attempt = 0;
      const loop = async () => {
        if (cancelled || fired) return;
        attempt += 1;
        const reachable = await probeRef.current(attempt);
        if (cancelled || fired) return;
        if (reachable) {
          fire();
          return;
        }
        loopTimer = setTimeout(loop, intervalMs);
      };
      loop();
    }, graceMs);

    const hardTimer =
      hardTimeoutMs != null
        ? setTimeout(() => {
            if (!cancelled) fire();
          }, hardTimeoutMs)
        : null;

    return () => {
      cancelled = true;
      clearTimeout(graceTimer);
      if (loopTimer) clearTimeout(loopTimer);
      if (settleTimer) clearTimeout(settleTimer);
      if (hardTimer) clearTimeout(hardTimer);
    };
  }, [enabled, graceMs, intervalMs, readyDelayMs, hardTimeoutMs]);

  return phase;
}
