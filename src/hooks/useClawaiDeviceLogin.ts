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
 * The machine half of a failed sign-in, beside its sentence: the configure
 * route's `code` and the auth profile it names. A host that knows the code
 * says it in the owner's language and offers the remedy; one that does not
 * shows the sentence.
 */
export interface ClawaiLoginErrorDetail {
  code?: string;
  profileId?: string;
}

/**
 * How long the panel follows a sign-in that is `configuring` before it stops
 * and says so. Past the poll route's own three-minute ceiling — which answers
 * an error the hook shows first — so this only fires when the route cannot
 * answer at all (a server that restarted, a session file that cannot be
 * read): never an endless "Connecting…".
 */
export const CLAWAI_CONFIGURING_CEILING_MS = 4 * 60 * 1000;

/** The code the hook gives its own give-up, so a host can say it in the owner's language. */
export const CLAWAI_CONFIGURING_TIMEOUT_CODE = "clawai_configuring_timeout";

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
  onError: (message: string, detail?: ClawaiLoginErrorDetail) => void;
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
  // When this attempt first answered `configuring` — what the ceiling counts from.
  const configuringSinceRef = useRef<number | null>(null);

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
    configuringSinceRef.current = null;
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
      const since = configuringSinceRef.current;
      if (since !== null && Date.now() - since > CLAWAI_CONFIGURING_CEILING_MS) {
        stop();
        cbRef.current.onBusyChange?.(false);
        cbRef.current.onError(
          "ClawBox AI setup did not finish on this device. Check Settings → Providers, then sign in again.",
          { code: CLAWAI_CONFIGURING_TIMEOUT_CODE },
        );
        return;
      }
      pollTimerRef.current = setTimeout(() => { void tick(interval); }, Math.max(interval, 1) * 1000);
    };
    try {
      const response = await fetch("/setup-api/ai-models/clawai/poll", {
        method: "POST",
        cache: "no-store",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      // `unknown` on `error`, deliberately: the poll route relays a failure
      // raised four hops upstream, and the type here was never a guarantee
      // about what is in the field — only about what this file expected.
      const data = await response.json().catch(() => ({})) as {
        status?: string;
        error?: unknown;
        warning?: unknown;
        code?: unknown;
        profileId?: unknown;
      };

      if (data.status === "complete") {
        stop();
        cbRef.current.onBusyChange?.(false);
        cbRef.current.onComplete(typeof data.warning === "string" && data.warning.trim() ? data.warning : undefined);
        return;
      }
      if (data.status === "configuring") {
        if (configuringSinceRef.current === null) configuringSinceRef.current = Date.now();
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
        const detail: ClawaiLoginErrorDetail = {
          ...(typeof data.code === "string" && data.code ? { code: data.code } : {}),
          ...(typeof data.profileId === "string" && data.profileId ? { profileId: data.profileId } : {}),
        };
        const message = humanizeApiError(data.error, "ClawBox AI authorisation failed");
        if (detail.code || detail.profileId) cbRef.current.onError(message, detail);
        else cbRef.current.onError(message);
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
        const data = await response.json().catch(() => ({})) as { error?: unknown };
        throw new Error(humanizeApiError(data.error, "Failed to start ClawBox AI authorisation"));
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
