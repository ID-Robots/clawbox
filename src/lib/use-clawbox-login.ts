"use client";

import { useEffect, useState } from "react";

// Lightweight client hook for "is the device logged in to a ClawBox AI
// account?". Backed by the existing /setup-api/ai-models/status endpoint
// (already a primary truth source for the active provider + tier).
//
// "Logged in" here means: the active provider is ClawBox AI AND a tier was
// resolved. The endpoint returns clawaiTier === null whenever the active
// provider isn't clawai, so this collapses both "no token" and "different
// provider entirely" into a single `loggedIn === false`.
//
// Polls every 30s by default so the gate flips quickly after the user
// signs in on the portal in another tab. Callers that need faster updates
// can pass a custom intervalMs (e.g. the ClawKeep overlay polls every 5s
// while the modal is open).

export type ClawboxAiTier = "flash" | "pro" | string;

export interface ClawboxLoginState {
  loggedIn: boolean;
  tier: ClawboxAiTier | null;
  loading: boolean;
}

interface AiStatusResponse {
  connected?: boolean;
  provider?: string | null;
  clawaiTier?: ClawboxAiTier | null;
}

const DEFAULT_INTERVAL_MS = 30_000;

export function useClawboxLogin(intervalMs: number = DEFAULT_INTERVAL_MS): ClawboxLoginState {
  const [state, setState] = useState<ClawboxLoginState>({
    loggedIn: false,
    tier: null,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await fetch("/setup-api/ai-models/status", { cache: "no-store" });
        if (!res.ok) {
          // A non-2xx response means the device can't currently confirm the
          // session — clear stale loggedIn/tier so callers don't keep gating
          // open after a previously-good poll.
          if (!cancelled) setState({ loggedIn: false, tier: null, loading: false });
          return;
        }
        const data = (await res.json()) as AiStatusResponse;
        if (cancelled) return;
        const tier = data.clawaiTier ?? null;
        setState({
          loggedIn: data.provider === "clawai" && tier !== null,
          tier,
          loading: false,
        });
      } catch {
        // Network failure → fall closed, same reasoning as the !res.ok branch.
        if (!cancelled) setState({ loggedIn: false, tier: null, loading: false });
      } finally {
        if (!cancelled) {
          timer = setTimeout(tick, intervalMs);
        }
      }
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs]);

  return state;
}
