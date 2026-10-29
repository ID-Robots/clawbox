"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClawaiTier } from "@/lib/clawbox-ai-tiers";
import { humanizeApiError } from "@/lib/api-error-message";

// ClawBox AI device-authorisation state machine (RFC 8628 style), lifted out of
// AIModelsStep so the OpenClaw wizard and the Hermes provider panel run the
// SAME flow rather than two copies that can drift. The endpoints
// (/setup-api/ai-models/clawai/start + /poll) are harness-agnostic: start only
// mints a code and writes the session file.

/**
 * How long the kick-off may take. `/clawai/start` gives the portal 15 s and
 * then answers with a device-made code, so a request still open after this is
 * one nothing will answer — and the button it holds says "Connecting…" forever.
 */
export const CLAWAI_START_TIMEOUT_MS = 30_000;

/** One poll tick's bound. The route gives the portal 15 s; a tick past this is retried. */
export const CLAWAI_POLL_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The whole poll's bound, from the code being shown: the code's 15-minute life,
 * the finaliser's 3-minute window, and a margin. Every state the route can be in
 * has ended by then, so a flow still polling is one whose answers are not
 * arriving — it ends in an error the owner can act on, never in a spinner.
 */
export const CLAWAI_POLL_CEILING_MS = 20 * 60_000;

const START_TIMED_OUT = "Failed: ClawBox AI did not answer in time. Check the device's internet connection and try again.";
const POLL_TIMED_OUT = "Failed: the ClawBox AI sign-in did not finish in time. Request a new code and try again.";

class DeadlineError extends Error {}

/**
 * `work` within `ms`, or a DeadlineError — after aborting `controller`, so the
 * request itself stops too. An abort from elsewhere (stop(), unmount) settles
 * it as the AbortError callers already ignore; it does not wait on `work`,
 * which a fetch that ignores its signal would never settle.
 */
function settleWithin<T>(work: Promise<T>, controller: AbortController, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => new DOMException("Aborted", "AbortError");
    if (controller.signal.aborted) {
      reject(aborted());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      controller.signal.removeEventListener("abort", onAbort);
      controller.abort();
      reject(new DeadlineError());
    }, ms);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const settle = () => {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
    };
    work.then(
      (value) => { settle(); resolve(value); },
      (err) => { settle(); reject(err); },
    );
  });
}

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
  /**
   * The save landed. `warning` is what it could NOT do — the configure route's
   * own sentence, carried through the session record because the configure
   * runs off the request that started it — and a host that renders a warning
   * shows that instead of a plain success.
   */
  onComplete: (warning?: string) => void;
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
  // When this attempt's poll gives up (CLAWAI_POLL_CEILING_MS from the code).
  const pollDeadlineRef = useRef(0);

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
    const fail = (message: string) => {
      stop();
      cbRef.current.onBusyChange?.(false);
      setDeviceCode(null);
      setVerificationUrl(null);
      cbRef.current.onError(message);
    };
    const again = () => {
      if (Date.now() >= pollDeadlineRef.current) {
        fail(POLL_TIMED_OUT);
        return;
      }
      pollTimerRef.current = setTimeout(() => { void tick(interval); }, Math.max(interval, 1) * 1000);
    };
    try {
      const { response, data } = await settleWithin((async () => {
        const res = await fetch("/setup-api/ai-models/clawai/poll", {
          method: "POST",
          cache: "no-store",
          signal: controller.signal,
        });
        // `unknown` on `error`, deliberately: the poll route relays a failure
        // raised four hops upstream, and the type here was never a guarantee
        // about what is in the field — only about what this file expected.
        const body = await res.json().catch(() => ({})) as { status?: string; error?: unknown; warning?: unknown };
        return { response: res, data: body };
      })(), controller, CLAWAI_POLL_REQUEST_TIMEOUT_MS);
      if (controller.signal.aborted) return;

      if (data.status === "complete") {
        stop();
        cbRef.current.onBusyChange?.(false);
        cbRef.current.onComplete(typeof data.warning === "string" && data.warning.trim() ? data.warning : undefined);
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
        cbRef.current.onError(humanizeApiError(data.error, "ClawBox AI authorisation failed"));
        return;
      }
      // Pending (or a transient upstream blip): schedule the next tick.
      again();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Network glitch, or a tick nothing answered — back off and retry
      // instead of dropping the user out of the flow, until the ceiling.
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
      // The body is inside the bound too: a response whose body never ends
      // holds the button exactly as a request that never answers does.
      const data = await settleWithin((async () => {
        const response = await fetch("/setup-api/ai-models/clawai/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope: cbRef.current.scope ?? "primary",
            tier: cbRef.current.getTier(),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const failure = await response.json().catch(() => ({})) as { error?: unknown };
          throw new Error(humanizeApiError(failure.error, "Failed to start ClawBox AI authorisation"));
        }
        return await response.json() as { user_code?: string; verification_url?: string; interval?: number };
      })(), controller, CLAWAI_START_TIMEOUT_MS);
      if (controller.signal.aborted) return;
      if (!data.user_code || !data.verification_url) {
        throw new Error("ClawBox AI did not return a device code");
      }
      setDeviceCode(data.user_code);
      setVerificationUrl(data.verification_url);
      setPolling(true);
      cbRef.current.onBusyChange?.(false);
      const interval = typeof data.interval === "number" && data.interval > 0 ? data.interval : 5;
      pollDeadlineRef.current = Date.now() + CLAWAI_POLL_CEILING_MS;
      pollTimerRef.current = setTimeout(() => { void poll(interval); }, interval * 1000);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      cbRef.current.onBusyChange?.(false);
      cbRef.current.onError(err instanceof DeadlineError ? START_TIMED_OUT : `Failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [poll, stop]);

  useEffect(() => () => {
    startControllerRef.current?.abort();
    pollControllerRef.current?.abort();
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
  }, []);

  return { deviceCode, verificationUrl, polling, start, stop, reset };
}
