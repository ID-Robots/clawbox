"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClawaiTier } from "@/lib/clawbox-ai-tiers";

// ClawBox AI device-authorisation state machine (RFC 8628 style), lifted out of
// AIModelsStep so the OpenClaw wizard and the Hermes provider panel run the
// SAME flow rather than two copies that can drift. The endpoints
// (/setup-api/ai-models/clawai/start + /poll) are harness-agnostic: start only
// mints a code and writes the session file.

export interface ClawaiDeviceLoginOptions {
  scope?: "primary" | "local";
  /** Read at start() time so a tier change between renders is picked up. */
  getTier: () => ClawaiTier;
  /** A new attempt is beginning — hosts clear any previous status here. */
  onStart?: () => void;
  /** Kick-off in flight. Mirrors the five places OpenClaw toggled `saving`. */
  onBusyChange?: (busy: boolean) => void;
  /** Token landed; the device is finishing configuration. */
  onConfiguring?: () => void;
  onComplete: () => void;
  onError: (message: string) => void;
}

export interface ClawaiDeviceLogin {
  deviceCode: string | null;
  verificationUrl: string | null;
  polling: boolean;
  start: () => Promise<void>;
  stop: () => void;
  reset: () => void;
}

export function useClawaiDeviceLogin(options: ClawaiDeviceLoginOptions): ClawaiDeviceLogin {
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  // Callbacks live in a ref so `start`/`stop`/`reset` keep STABLE identities.
  // Without this the host's onComplete (which itself calls reset()) and the
  // hook form a useCallback dependency cycle, and the setTimeout poll chain
  // would capture stale callbacks.
  const cbRef = useRef(options);
  cbRef.current = options;

  const startControllerRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollControllerRef = useRef<AbortController | null>(null);
  // Tracks whether we've already surfaced the configuring overlay for the
  // current attempt. The poll route returns `configuring` for every tick while
  // the background finalisation runs, so without this latch the overlay would
  // reset to phase 0 every interval and look like the progress bar is looping
  // back to the start.
  const configuringShownRef = useRef(false);

  const stop = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollControllerRef.current?.abort();
    pollControllerRef.current = null;
    startControllerRef.current?.abort();
    startControllerRef.current = null;
    configuringShownRef.current = false;
    setPolling(false);
  }, []);

  const reset = useCallback(() => {
    setDeviceCode(null);
    setVerificationUrl(null);
    setPolling(false);
  }, []);

  // Single tick of the upstream-issuance poll. Reschedules itself while the
  // session stays `pending` or `configuring`.
  const poll = useCallback(async function tick(interval: number): Promise<void> {
    pollControllerRef.current?.abort();
    const controller = new AbortController();
    pollControllerRef.current = controller;
    const again = () => {
      pollTimerRef.current = setTimeout(() => { void tick(interval); }, Math.max(interval, 1) * 1000);
    };
    try {
      const response = await fetch("/setup-api/ai-models/clawai/poll", {
        method: "POST",
        cache: "no-store",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const data = await response.json().catch(() => ({})) as { status?: string; error?: string };

      if (data.status === "complete") {
        stop();
        cbRef.current.onBusyChange?.(false);
        cbRef.current.onComplete();
        return;
      }
      if (data.status === "configuring") {
        if (!configuringShownRef.current) {
          configuringShownRef.current = true;
          setDeviceCode(null);
          setVerificationUrl(null);
          setPolling(false);
          cbRef.current.onBusyChange?.(false);
          cbRef.current.onConfiguring?.();
        }
        again();
        return;
      }
      if (data.status === "error" || (!response.ok && response.status === 410)) {
        stop();
        cbRef.current.onBusyChange?.(false);
        setDeviceCode(null);
        cbRef.current.onError(data.error || "ClawBox AI authorisation failed");
        return;
      }
      // Pending (or a transient upstream blip): schedule the next tick.
      again();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Network glitch — back off and retry instead of dropping the user out
      // of the flow.
      again();
    }
  }, [stop]);

  const start = useCallback(async () => {
    cbRef.current.onStart?.();
    cbRef.current.onBusyChange?.(true);
    setDeviceCode(null);
    setVerificationUrl(null);
    stop();

    const controller = new AbortController();
    startControllerRef.current = controller;
    try {
      const response = await fetch("/setup-api/ai-models/clawai/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: cbRef.current.scope ?? "primary",
          tier: cbRef.current.getTier(),
        }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(typeof data.error === "string" ? data.error : "Failed to start ClawBox AI authorisation");
      }
      const data = await response.json() as { user_code?: string; verification_url?: string; interval?: number };
      if (!data.user_code || !data.verification_url) {
        throw new Error("ClawBox AI did not return a device code");
      }
      setDeviceCode(data.user_code);
      setVerificationUrl(data.verification_url);
      setPolling(true);
      cbRef.current.onBusyChange?.(false);
      const interval = typeof data.interval === "number" && data.interval > 0 ? data.interval : 5;
      pollTimerRef.current = setTimeout(() => { void poll(interval); }, interval * 1000);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      cbRef.current.onBusyChange?.(false);
      cbRef.current.onError(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [poll, stop]);

  useEffect(() => () => {
    startControllerRef.current?.abort();
    pollControllerRef.current?.abort();
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
  }, []);

  return { deviceCode, verificationUrl, polling, start, stop, reset };
}
