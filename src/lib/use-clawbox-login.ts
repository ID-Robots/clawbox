"use client";

import { useEffect, useState } from "react";
import {
  normalizeAllowedModelIds,
  normalizeClawboxAiPlanTier,
  normalizeClawboxAiTier,
  type ClawboxAiPlanTier,
} from "@/lib/clawbox-ai-models";
import { notifyClawaiPlanChanged, onProvidersChanged } from "@/lib/ui-events";
import { monotonicNow } from "@/lib/visible-interval";

// Lightweight client hook for "is the device signed in to a ClawBox AI
// account, and what does that account entitle?". Backed by
// /setup-api/ai-models/status.
//
// `loggedIn`, `plan` and `tier` reflect the user's *account-level* state —
// i.e. the PLAN the stored claw_ token's account pays for, regardless of
// which provider is driving the current chat. A Max subscriber chatting via
// OpenAI is still loggedIn=true with tier="pro" so ClawKeep + Remote Desktop
// stay unlocked. The chat-header *badge* uses a separate endpoint field
// (`clawaiTier`) that reflects the active chat provider — that goes blank
// when chatting via OpenAI, which is the right behaviour for the badge.
//
// The plan comes from the route's `clawaiPlan` (the portal's plan verdict),
// NEVER from its model tiers: a Free sign-in stamps the box's model tier
// "flash", the same as the Pro plan, and reading that stamp as the plan is
// what showed Free accounts the "Welcome to ClawBox Pro" celebration.
//
// Free users (tier === null) are still considered logged in — they have a
// paired token, just not a paid plan. Callers that need to gate on a paid
// plan should check `tier !== null` themselves.
//
// Polls every 30s by default so the gate flips quickly after the user
// signs in on the portal in another tab. Callers that need faster
// updates can pass a custom intervalMs (e.g. the ClawKeep overlay
// polls every 5s while the modal is open). However many hooks are
// mounted, the box is asked by ONE poll at the shortest interval among
// them — see `poll` below.

export type ClawboxAiTier = "flash" | "pro" | string;

export interface ClawboxLoginState {
  loggedIn: boolean;
  /**
   * The PAID plan the account is on — `"flash"` is the plan marketed as Pro,
   * `"pro"` the one marketed as Max (the names are off by one) — or null for
   * Free, for no account, and for a plan that is not known yet. Fails closed:
   * nothing paid is unlocked on a plan nobody has confirmed.
   */
  tier: ClawboxAiTier | null;
  /**
   * The same plan with "Free" and "not known" kept apart: `"free"`, `"flash"`
   * (Pro), `"pro"` (Max), or null when the portal has not answered for this
   * account and no answer is on record. For callers that announce a CHANGE of
   * plan, to whom "we cannot tell" must be no change at all.
   */
  plan: ClawboxAiPlanTier | null;
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
  // The PLAN ("free" / "flash" = Pro / "pro" = Max, null = not known). The
  // two tiers above are MODEL defaults and only stand in for the plan when
  // this is absent — a pre-rollout server.
  clawaiPlan?: string | null;
  // The portal's entitlement list for the paired token. Absent on a
  // pre-rollout server, which reads as "not answered", not as "empty".
  clawaiAllowedModels?: string[] | null;
  // True when any clawai profile is configured. Distinguishes
  // "no ClawBox AI account" (false) from "Free user paired"
  // (true, clawaiAccountTier=null).
  clawaiConfigured?: boolean;
  // Set on the one answer whose poll recorded a CHANGED plan on the box.
  clawaiPlanChanged?: boolean;
}

const DEFAULT_INTERVAL_MS = 30_000;
const STATUS_URL = "/setup-api/ai-models/status";
/**
 * How old an ask still in flight may be for a hook mounting now to wait for
 * its answer rather than ask again. Only hooks that mount TOGETHER join one
 * ask — the page and TierUpgradeCelebration, in the same commit — which is the
 * duplicate the shared mount-ask exists to save. Anything later asks afresh,
 * as every hook did before the poll was shared: the route is slowest right
 * after a ClawBox AI sign-in or a plan change (openclaw.json rewritten, the
 * gateway restarting), and an ask started seconds before such a moment
 * answered a component that mounted after it — the Coding Agent's paid-plan
 * gate, the Providers pitch card — with the old tier until the next poll, up
 * to 30 s later. Timed on `monotonicNow()`: the box's wall clock jumps at NTP
 * sync, and a step back would have kept a stuck ask joinable for its length.
 */
const JOIN_IN_FLIGHT_MS = 250;

/** Same ids in the same order — or both unanswered. */
function sameIds(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

/** One answer of the status route: the facts read off a 2xx body, or "I don't know right now". */
type Answer =
  | {
      ok: true;
      loggedIn: boolean;
      tier: ClawboxAiTier | null;
      plan: ClawboxAiPlanTier | null;
      allowedModels: string[] | null;
    }
  | { ok: false };

interface Subscriber {
  intervalMs: number;
  deliver: (answer: Answer) => void;
  /**
   * The first ask this hook takes an answer from: the one it joined, or the
   * one started for it. An older ask still out when it mounted can land first,
   * and its answer is from before this hook existed — handed to it, a gate
   * would flash the tier the owner just left.
   */
  fromSeq?: number;
}

/**
 * ONE poll of the status route for every mounted `useClawboxLogin()`.
 *
 * Every hook used to run its own 30 s chain, and the owner's idle desktop
 * always mounts two (the page's, and TierUpgradeCelebration's) — Settings, the
 * full-page chat and the paid-gate wizards add one each — so the box answered
 * the same question two to four times a period, in bursts a millisecond
 * apart, at the most expensive handler the desktop polls (openclaw.json, the
 * config store, the portal-tier logic).
 *
 * What each hook SEES is unchanged, which is why this shares the asking and
 * nothing else:
 * - every mount still starts in `loading` and is answered by an ask made for
 *   it — a fresh one, or one started together with it (`JOIN_IN_FLIGHT_MS`) —
 *   never by an answer some other hook got earlier, nor by an older ask that
 *   happens to land after it mounted (`Subscriber.fromSeq`);
 * - every hook still reduces each answer over ITS OWN previous state, so a
 *   failed poll preserves what that hook had, exactly as before;
 * - the cadence is the SHORTEST interval any mounted hook asked for, so no
 *   hook is answered less often than its own chain answered it (a 30 s caller
 *   beside a 5 s paid gate is simply answered every 5 s);
 * - the last hook to leave stops the timer and disowns whatever is in flight,
 *   and the next one to mount asks afresh.
 *
 * One addition, the same rule the chat's own polls keep
 * (`installPendingRefresh`): a tick that falls due while the page is HIDDEN is
 * not asked, and is asked the moment the page is visible again. A background
 * tab — a phone, a laptop on the LAN — stops costing the box anything, and
 * what the owner finds on return is at least as fresh as before: a trip away
 * shorter than the interval asks nothing extra, a longer one asks at once.
 * That holds on the box's own screen too, which CAN be hidden — the kiosk's
 * desktop tab while the owner is on another of its tabs, a minimised monitor
 * session window — and needs no exemption: what this feeds (the shield, the
 * paid gates, the tier badge) is state drawn on the desktop itself, re-read the
 * moment it is shown again, and nothing here acts on the screen meanwhile.
 *
 * And one signal: "the providers changed" (`onProvidersChanged`), which every
 * configure success emits — the ClawBox AI sign-in among them — and Settings'
 * model switch too. It is answered with a fresh ask at once. The account can
 * have changed under it, and without this every surface went on showing the
 * previous account's plan until the next tick, up to a full interval later.
 */
const poll = {
  subscribers: new Set<Subscriber>(),
  timer: null as ReturnType<typeof setTimeout> | null,
  /** Bumped when the last hook leaves: an answer to an ask from before is nobody's. */
  generation: 0,
  /** Asks started, and the newest one whose answer was handed out. */
  asked: 0,
  delivered: 0,
  /** The ask on its way, which a hook mounting now waits for rather than repeat. */
  inFlight: null as { seq: number; startedAt: number } | null,
  /** A tick fell due while the page was hidden; it is asked on the visible edge. */
  missed: false,
  /** Stops listening for the provider signal; held while any hook is mounted. */
  stopSignal: null as (() => void) | null,
  /** The last plan an answer named, to tell a change another page recorded. */
  lastPlan: null as ClawboxAiPlanTier | null,
};

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function shortestInterval(): number {
  let min = Infinity;
  for (const s of poll.subscribers) min = Math.min(min, s.intervalMs);
  return min;
}

function readAnswer(data: AiStatusResponse): Answer {
  const planAnswered = data.clawaiPlan !== undefined;
  const plan = planAnswered ? normalizeClawboxAiPlanTier(data.clawaiPlan) : null;
  return {
    ok: true,
    // The plan's paid tier: "free" and "not known" are both null here.
    // A pre-rollout /status emits no `clawaiPlan`; there the account tier,
    // then the badge tier, is the only answer there is (zero-downtime
    // rollout — old client + new server, or vice versa, still resolves a
    // sensible value), and `plan` stays "not known" so nothing is announced
    // off a model tier.
    tier: planAnswered
      ? normalizeClawboxAiTier(plan)
      : (data.clawaiAccountTier ?? data.clawaiTier ?? null),
    plan,
    // `loggedIn` means "device has a clawai profile configured"
    // independent of which provider is currently active for chat.
    // Older responses without `clawaiConfigured` fall back to the
    // pre-rollout `provider === "clawai"` heuristic.
    loggedIn: data.clawaiConfigured ?? (data.provider === "clawai"),
    // One normaliser, shared with the server that produced the field, so
    // the two cannot disagree about what an empty list means.
    allowedModels: normalizeAllowedModelIds(data.clawaiAllowedModels),
  };
}

async function ask(): Promise<void> {
  const generation = poll.generation;
  const seq = ++poll.asked;
  poll.inFlight = { seq, startedAt: monotonicNow() };
  poll.missed = false;
  let answer: Answer;
  let planChangedHere = false;
  try {
    const res = await fetch(STATUS_URL, { cache: "no-store" });
    const data = res.ok ? ((await res.json()) as AiStatusResponse) : null;
    answer = data ? readAnswer(data) : { ok: false };
    planChangedHere = data?.clawaiPlanChanged === true;
  } catch {
    answer = { ok: false };
  }
  // Every hook left while this was out: nobody is listening, and the timer
  // was stopped with them.
  if (generation !== poll.generation) return;
  if (poll.inFlight?.seq === seq) poll.inFlight = null;
  // An older ask that lands after a newer one has been handed out is not news.
  if (seq < poll.delivered) return;
  poll.delivered = seq;
  for (const s of [...poll.subscribers]) {
    if (s.fromSeq === undefined || seq >= s.fromSeq) s.deliver(answer);
  }
  // The plan moved: what follows it re-reads now (Settings → Voice). Either
  // this poll recorded the change, or a known plan differs from the last one
  // seen here — another page's poll recorded it.
  if (answer.ok) {
    const moved = poll.lastPlan !== null && answer.plan !== null && answer.plan !== poll.lastPlan;
    if (answer.plan !== null) poll.lastPlan = answer.plan;
    if (planChangedHere || moved) notifyClawaiPlanChanged();
  }
  // Only the newest ask arms the next one, so two asks out at once (a hook
  // that mounted beside a stuck one) still leave ONE timer behind.
  if (seq === poll.asked) arm();
}

function arm(): void {
  if (poll.timer) clearTimeout(poll.timer);
  poll.timer = null;
  if (poll.subscribers.size === 0) return;
  poll.timer = setTimeout(() => {
    poll.timer = null;
    if (pageHidden()) {
      poll.missed = true;
      return;
    }
    void ask();
  }, shortestInterval());
}

/** Only the visible EDGE, and only for a tick that fell due while away. */
function onVisibilityChange(): void {
  if (pageHidden() || !poll.missed || poll.subscribers.size === 0) return;
  void ask();
}

/**
 * The providers changed: ask afresh now rather than on the next tick. Never
 * joins an ask already out — that one may have been answered from before the
 * change. Hidden, it waits for the visible edge like a tick would.
 */
function onProvidersSignal(): void {
  if (poll.subscribers.size === 0) return;
  if (pageHidden()) {
    poll.missed = true;
    return;
  }
  if (poll.timer) clearTimeout(poll.timer);
  poll.timer = null;
  void ask();
}

/**
 * Ask the plan now rather than at the next tick — for a surface that has just
 * opened and depends on it (Settings → Voice). A no-op while no hook polls.
 */
export function refreshClawboxPlanNow(): void {
  onProvidersSignal();
}

function subscribe(sub: Subscriber): () => void {
  if (poll.subscribers.size === 0) {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);
    poll.stopSignal = onProvidersChanged(onProvidersSignal);
  }
  poll.subscribers.add(sub);
  // A hook that mounts is answered by an ask made for it, exactly as when
  // each hook asked for itself: one started together with it, or a fresh one
  // now — which also brings the shared cadence down to this hook's interval.
  const joinable = poll.inFlight !== null && monotonicNow() - poll.inFlight.startedAt < JOIN_IN_FLIGHT_MS;
  if (joinable && poll.inFlight) {
    sub.fromSeq = poll.inFlight.seq;
  } else {
    if (poll.timer) clearTimeout(poll.timer);
    poll.timer = null;
    // `ask()` numbers the ask before its first await.
    sub.fromSeq = poll.asked + 1;
    void ask();
  }
  return () => {
    poll.subscribers.delete(sub);
    if (poll.subscribers.size > 0) return;
    if (poll.timer) clearTimeout(poll.timer);
    poll.timer = null;
    poll.inFlight = null;
    poll.missed = false;
    poll.lastPlan = null;
    poll.generation += 1;
    poll.stopSignal?.();
    poll.stopSignal = null;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

/**
 * `enabled: false` asks nothing and stays `loading` — the desktop passes it for
 * a signed-in ClawBox user who is not the owner (TASK-1256), whose session the
 * route refuses with 403: ClawBox AI is the owner's account.
 */
export function useClawboxLogin(intervalMs: number = DEFAULT_INTERVAL_MS, enabled: boolean = true): ClawboxLoginState {
  const [state, setState] = useState<ClawboxLoginState>({
    loggedIn: false,
    tier: null,
    plan: null,
    allowedModels: null,
    loading: true,
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    // Transient-failure handler: preserve the last-known loggedIn/tier so
    // a momentary fetch failure (gateway WS drop, portal timeout, etc.)
    // doesn't flip the state to "free" and re-fire the downgrade modal
    // on every disconnect–reconnect cycle. The server-side /status route
    // already caches portal responses with proper TTLs, so a 2xx body is
    // the authoritative signal — anything else is "I don't know right
    // now", not "you've been downgraded".
    const preserveOnTransient = () => {
      // Return the same ref when nothing logical has changed so React bails
      // out and downstream consumers don't re-render on every failed poll.
      setState((prev) => (
        prev.loading
          ? {
              loggedIn: prev.loggedIn,
              tier: prev.tier,
              plan: prev.plan,
              allowedModels: prev.allowedModels,
              loading: false,
            }
          : prev
      ));
    };

    const unsubscribe = subscribe({
      intervalMs,
      deliver: (answer) => {
        if (cancelled) return;
        if (!answer.ok) {
          preserveOnTransient();
          return;
        }
        const { loggedIn, tier, plan, allowedModels } = answer;
        // Keep the previous array when the poll brought the same ids back.
        // A fresh array every 30 s would be a new identity for every consumer
        // that memoises on it — see the same-ref rule in preserveOnTransient.
        setState((prev) => (
          !prev.loading
            && prev.loggedIn === loggedIn
            && prev.tier === tier
            && prev.plan === plan
            && sameIds(prev.allowedModels, allowedModels)
            ? prev
            : { loggedIn, tier, plan, allowedModels, loading: false }
        ));
      },
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [intervalMs, enabled]);

  return state;
}
