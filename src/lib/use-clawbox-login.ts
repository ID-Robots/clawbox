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
  /**
   * Model ids the portal says this account may run, or null when the question
   * has not been answered (no token, portal unreachable, poll failed, older
   * portal build). Null is NOT "nothing is allowed" — see
   * `portalDeniesClawboxAiModel`, the only reader permitted to turn this into
   * a refusal.
   */
  allowedModels: string[] | null;
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
  // The portal's entitlement list for the paired token. Absent on a
  // pre-rollout server, which reads as "not answered", not as "empty".
  clawaiAllowedModels?: string[] | null;
  // True when any clawai profile is configured. Distinguishes
  // "no ClawBox AI account" (false) from "Free user paired"
  // (true, clawaiAccountTier=null).
  clawaiConfigured?: boolean;
}

const DEFAULT_INTERVAL_MS = 30_000;

/** Same ids in the same order — or both unanswered. */
function sameIds(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

export function useClawboxLogin(intervalMs: number = DEFAULT_INTERVAL_MS): ClawboxLoginState {
  const [state, setState] = useState<ClawboxLoginState>({
    loggedIn: false,
    tier: null,
    allowedModels: null,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Transient-failure handler: preserve the last-known loggedIn/tier so
    // a momentary fetch failure (gateway WS drop, portal timeout, etc.)
    // doesn't flip the state to "free" and re-fire the downgrade modal
    // on every disconnect–reconnect cycle. The server-side /status route
    // already caches portal responses with proper TTLs, so a 2xx body is
    // the authoritative signal — anything else is "I don't know right
    // now", not "you've been downgraded".
    const preserveOnTransient = () => {
      if (cancelled) return;
      // Return the same ref when nothing logical has changed so React bails
      // out and downstream consumers don't re-render on every failed poll.
      setState((prev) => (
        prev.loading
          ? {
              loggedIn: prev.loggedIn,
              tier: prev.tier,
              allowedModels: prev.allowedModels,
              loading: false,
            }
          : prev
      ));
    };

    const tick = async () => {
      try {
        const res = await fetch("/setup-api/ai-models/status", { cache: "no-store" });
        if (!res.ok) {
          preserveOnTransient();
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
        // Anything that is not a non-empty list of strings is "not answered".
        const parsed = Array.isArray(data.clawaiAllowedModels)
          ? data.clawaiAllowedModels.filter((id): id is string => typeof id === "string")
          : [];
        const allowedModels = parsed.length > 0 ? parsed : null;
        // Keep the previous array when the poll brought the same ids back.
        // A fresh array every 30 s would be a new identity for every consumer
        // that memoises on it — see the same-ref rule in preserveOnTransient.
        setState((prev) => (
          !prev.loading
            && prev.loggedIn === loggedIn
            && prev.tier === tier
            && sameIds(prev.allowedModels, allowedModels)
            ? prev
            : { loggedIn, tier, allowedModels, loading: false }
        ));
      } catch {
        preserveOnTransient();
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
