"use client";

import { useEffect, useState } from "react";

// Lightweight client hook for "is the device signed in to a ClawBox AI
// account, and what does that account entitle?". Backed by
// /setup-api/ai-models/status.
//
// `loggedIn` and `tier` reflect the user's *account-level* state — i.e.
// the tier on the stored claw_ token regardless of which provider is
// driving the current chat. A Max subscriber chatting via OpenAI is
// still loggedIn=true with tier="pro" so ClawKeep + Remote Desktop
// stay unlocked. The chat-header *badge* uses a separate endpoint
// field (`clawaiTier`) that reflects the active chat provider — that
// goes blank when chatting via OpenAI, which is the right behaviour
// for the badge.
//
// Free users (tier === null after auto-tier device-pair) are still
// considered logged in — they have a paired token, just not a paid
// badge. Callers that need to gate on a paid plan should check
// `tier !== null` themselves.
//
// Polls every 30s by default so the gate flips quickly after the user
// signs in on the portal in another tab. Callers that need faster
// updates can pass a custom intervalMs (e.g. the ClawKeep overlay
// polls every 5s while the modal is open).

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
  // Account-level tier — reflects the stored claw_ token's portal
  // entitlement regardless of which provider is currently active
  // for chat. Falls back to `clawaiTier` when missing so older
  // callers (and pre-rollout responses) keep working.
  clawaiAccountTier?: ClawboxAiTier | null;
  // True when any clawai profile is configured. Distinguishes
  // "no ClawBox AI account" (false) from "Free user paired"
  // (true, clawaiAccountTier=null).
  clawaiConfigured?: boolean;
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
        // Account-level tier first; fall back to the badge tier for
        // older /status responses that didn't yet emit
        // `clawaiAccountTier` (zero-downtime rollout — old client +
        // new server, or vice versa, still resolves a sensible value).
        const tier = data.clawaiAccountTier ?? data.clawaiTier ?? null;
        // `loggedIn` means "device has a clawai profile configured"
        // independent of which provider is currently active for chat.
        // Older responses without `clawaiConfigured` fall back to the
        // pre-rollout `provider === "clawai"` heuristic.
        const loggedIn = data.clawaiConfigured ?? (data.provider === "clawai");
        setState({
          loggedIn,
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
