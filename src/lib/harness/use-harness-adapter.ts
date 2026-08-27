"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { onProvidersChanged } from "@/lib/ui-events";
import { fetchHarness } from "@/lib/client-harness";
import { capabilitiesFor, UNKNOWN_FACTS, type HarnessFacts } from "./capabilities";
import { HermesAdapter, type HermesTurnContext } from "./hermes-adapter";
import { OpenClawGatewayAdapter, type GatewayLink } from "./openclaw-gateway-adapter";
import type { HarnessAdapter, HarnessCapabilities, HarnessId } from "./transport";

/**
 * Builds and owns the one adapter the chat talks to.
 *
 * Two jobs, and only two:
 *
 * 1. resolve which harness is active and what this box can do, then
 * 2. hand back ONE adapter with a STABLE identity for as long as those answers
 *    hold.
 *
 * (2) is load-bearing. The chat component threads the adapter through roughly
 * forty `useCallback` dependency arrays; an adapter rebuilt on each render
 * would re-fire every one of them and, through them, re-open the gateway
 * socket on a loop. Memoising on the resolved facts is what makes swapping
 * `wsRequest` for `adapter` a rename rather than a re-architecture.
 */

/**
 * What the component lends the transport.
 *
 * MUST be stable — memoise it, and let its methods read whatever moves through
 * refs, the way the chat's own callbacks already do. This is not a style
 * preference: the adapter is rebuilt whenever this changes, and the chat
 * threads that adapter through roughly forty dependency arrays, so an object
 * re-created each render would re-fire every one of them and re-open the
 * gateway socket on a loop.
 */
export interface HarnessWiring {
  /** The gateway socket, still owned by the component. */
  gateway: GatewayLink;
  /** What a Hermes turn needs from the chat header, read at send time. */
  hermesContext: () => HermesTurnContext;
}

export interface UseHarnessAdapterResult {
  adapter: HarnessAdapter;
  capabilities: HarnessCapabilities;
  harnessId: HarnessId;
  /**
   * False until the box has said which harness it runs. Connecting before this
   * is what would open an OpenClaw socket on a Hermes device.
   */
  resolved: boolean;
}

/**
 * How many times a still-pending answer is chased before the page gives up.
 *
 * Capped rather than repeated, because the point of the server's backoff is to
 * stop a broken `hermes` costing a Python interpreter per request — a browser
 * that re-asked on a loop would reintroduce exactly that from the other side.
 * Two covers a box that was merely busy, which is the case this exists for; a
 * box still silent after that is broken, and the customer keeps the honest
 * hidden control until they reload or change something.
 */
const MAX_PENDING_RETRIES = 2;

/**
 * A little past the server's own backoff, never bang on it.
 *
 * The server publishes the delay it intends to hold a failed read for, and an
 * exactly-on-time re-ask would land while that entry is still live and be
 * served the same placeholder — spending a round trip to learn nothing.
 */
const RETRY_MARGIN_MS = 2_000;

/** Only reached if a box claims `factsPending` without naming a delay. */
const DEFAULT_RETRY_AFTER_MS = 60_000;

interface ProbedFacts {
  facts: HarnessFacts;
  /**
   * At least one fact came from a backoff entry rather than an answer, so the
   * `false` in it is a placeholder the box will replace by itself.
   */
  pending: boolean;
  /** How long the server says it will hold that placeholder for. */
  retryAfterMs: number;
}

async function fetchFacts(signal?: AbortSignal): Promise<ProbedFacts | null> {
  try {
    const res = await fetch("/setup-api/chat/capabilities", { cache: "no-store", signal });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      facts?: Partial<HarnessFacts>;
      factsPending?: unknown;
      factsRetryAfterMs?: unknown;
    };
    return {
      facts: {
        hasClawaiToken: data.facts?.hasClawaiToken === true,
        hermesSupportsImages: data.facts?.hermesSupportsImages === true,
        hermesHasVisionRoute: data.facts?.hermesHasVisionRoute === true,
        hermesStreamsTurns: data.facts?.hermesStreamsTurns === true,
        hasClawaiImageRoute: data.facts?.hasClawaiImageRoute === true,
        hermesAgentDrawsImages: data.facts?.hermesAgentDrawsImages === true,
      },
      // A box too old to send the field is not pending, it is simply not
      // saying — which is the pre-existing behaviour, unchanged.
      pending: data.factsPending === true,
      retryAfterMs:
        typeof data.factsRetryAfterMs === "number" && data.factsRetryAfterMs > 0
          ? data.factsRetryAfterMs
          : DEFAULT_RETRY_AFTER_MS,
    };
  } catch {
    // A box that cannot answer keeps the cautious defaults: a hidden control
    // is recoverable, one that promises something the box cannot do is not.
    return null;
  }
}

export function useHarnessAdapter(wiring: HarnessWiring): UseHarnessAdapterResult {
  const [harnessId, setHarnessId] = useState<HarnessId>("openclaw");
  const [facts, setFacts] = useState<HarnessFacts>(UNKNOWN_FACTS);
  const [resolved, setResolved] = useState(false);
  /**
   * The one scheduled re-ask, or null when nothing is outstanding.
   *
   * A fresh object each time it is set, so the effect below re-arms on every
   * pending answer. `attempt` rides in the state rather than in a ref so the
   * cap cannot be lost to a re-render, and so the effect's dependency is the
   * whole decision rather than half of it.
   */
  const [factsRetry, setFactsRetry] = useState<{ delayMs: number; attempt: number } | null>(null);

  /**
   * Apply a fetched answer, and decide whether to come back for a better one.
   *
   * `attempt` is how many chased re-asks already produced THIS answer, so a
   * provider change — a fresh cause, and one the customer is watching — starts
   * the count over at zero, while a chased retry carries it forward.
   */
  const applyFacts = useCallback((probed: ProbedFacts | null, attempt: number) => {
    if (!probed) return;
    setFacts((prev) => (sameFacts(prev, probed.facts) ? prev : probed.facts));
    setFactsRetry(
      probed.pending && attempt < MAX_PENDING_RETRIES
        ? { delayMs: probed.retryAfterMs, attempt: attempt + 1 }
        : null,
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const [harness, probed] = await Promise.all([
        fetchHarness({ signal: controller.signal }).catch(() => null),
        fetchFacts(controller.signal),
      ]);
      if (controller.signal.aborted) return;
      if (harness?.active === "hermes") setHarnessId("hermes");
      applyFacts(probed, 0);
      setResolved(true);
    })();
    return () => controller.abort();
  }, [applyFacts]);

  // A capability computed from a credential goes stale the moment the customer
  // links ClawBox AI in Settings — without this the microphone would stay
  // hidden until the page was reloaded, on a box that can now transcribe.
  const reprobe = useCallback(() => {
    void (async () => {
      applyFacts(await fetchFacts(), 0);
    })();
  }, [applyFacts]);
  // One subscription over every name that means "providers changed", so a
  // capability computed from a credential cannot stay stale merely because the
  // component that connected the provider spoke the other harness's dialect.
  useEffect(() => onProvidersChanged(reprobe), [reprobe]);

  /**
   * Come back for a fact the box admitted was still a placeholder.
   *
   * THE SECOND CACHE over the same fact is this page. The server stopped
   * remembering a failed probe as a negative answer so that a box which was
   * merely busy "gets its attach button back inside a minute rather than at the
   * next restart" — but these facts are fetched once, on mount, and the only
   * other trigger is an explicit provider change, which fires on no timer. A
   * response that SUCCEEDS while the server-side probe is in backoff carries a
   * perfectly legitimate-looking `false`, indistinguishable from a real
   * negative, so the recovery the server performed a minute later never reached
   * the customer: the composer's attach button stayed hidden for the whole page
   * session, until a reload or a Settings change.
   *
   * Bounded at both ends. It waits out the delay the server itself published,
   * so it cannot poll a busy Jetson; and it stops after `MAX_PENDING_RETRIES`,
   * so a genuinely broken box is not asked for the life of the tab — that is
   * the very cost the server-side backoff exists to avoid, and it would be an
   * empty fix to reintroduce it from the browser.
   */
  useEffect(() => {
    if (!factsRetry) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        const probed = await fetchFacts(controller.signal);
        if (controller.signal.aborted) return;
        if (!probed) {
          // A re-ask that did not answer is not an answer either. Abandoning
          // the chase here would reinstate the very bug this effect removes —
          // the placeholder `false` kept for the whole page session because one
          // round trip happened to land during a restart or a blip. Rescheduled
          // under the SAME cap, and with the delay the server last published,
          // so a box that cannot answer at all still stops after two.
          //
          // Handled here rather than in `applyFacts` on purpose: this is the
          // only caller that is already chasing something. The mount fetch and
          // the provider-change reprobe both treat a failed request as "keep
          // the cautious defaults and wait", which is unchanged.
          setFactsRetry(
            factsRetry.attempt < MAX_PENDING_RETRIES
              ? { delayMs: factsRetry.delayMs, attempt: factsRetry.attempt + 1 }
              : null,
          );
          return;
        }
        applyFacts(probed, factsRetry.attempt);
      })();
    }, factsRetry.delayMs + RETRY_MARGIN_MS);
    return () => {
      // Both halves matter: the timer may not have fired yet, and if it has,
      // the fetch it started is a setState aimed at a tree that is going away.
      clearTimeout(timer);
      controller.abort();
    };
  }, [factsRetry, applyFacts]);

  const capabilities = useMemo(() => capabilitiesFor(harnessId, facts), [harnessId, facts]);

  const adapter = useMemo<HarnessAdapter>(
    () =>
      harnessId === "hermes"
        ? new HermesAdapter(capabilities, wiring.hermesContext)
        : new OpenClawGatewayAdapter(capabilities, wiring.gateway),
    [harnessId, capabilities, wiring],
  );

  return { adapter, capabilities, harnessId, resolved };
}

/**
 * Every fact, compared. A missing one here is not a slower update, it is a
 * PERMANENTLY stale capability: `reprobe` keeps the previous object whenever
 * this answers true, so a fact left out can never be applied. `streamsTurns`
 * was the one that mattered — the dashboard service starting or stopping is
 * exactly what the probe is there to notice, and the new answer was dropped.
 *
 * Keyed off the object rather than written out field by field, so a fact added
 * later is compared without anyone having to remember this function exists.
 */
function sameFacts(a: HarnessFacts, b: HarnessFacts): boolean {
  const keys = Object.keys({ ...a, ...b }) as (keyof HarnessFacts)[];
  return keys.every((key) => a[key] === b[key]);
}
