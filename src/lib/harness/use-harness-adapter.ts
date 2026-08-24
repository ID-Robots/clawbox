"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CHAT_MODEL_STATE_EVENT } from "@/lib/ui-events";
import { fetchHarness } from "@/lib/client-harness";
import { HERMES_MODEL_STATE_EVENT } from "@/hooks/useHermesModelOptions";
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

async function fetchFacts(signal?: AbortSignal): Promise<HarnessFacts | null> {
  try {
    const res = await fetch("/setup-api/chat/capabilities", { cache: "no-store", signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { facts?: Partial<HarnessFacts> };
    return {
      hasClawaiToken: data.facts?.hasClawaiToken === true,
      hermesSupportsImages: data.facts?.hermesSupportsImages === true,
      hermesHasVisionRoute: data.facts?.hermesHasVisionRoute === true,
      hermesStreamsTurns: data.facts?.hermesStreamsTurns === true,
      hasClawaiImageRoute: data.facts?.hasClawaiImageRoute === true,
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

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const [harness, probed] = await Promise.all([
        fetchHarness({ signal: controller.signal }).catch(() => null),
        fetchFacts(controller.signal),
      ]);
      if (controller.signal.aborted) return;
      if (harness?.active === "hermes") setHarnessId("hermes");
      if (probed) setFacts(probed);
      setResolved(true);
    })();
    return () => controller.abort();
  }, []);

  // A capability computed from a credential goes stale the moment the customer
  // links ClawBox AI in Settings — without this the microphone would stay
  // hidden until the page was reloaded, on a box that can now transcribe.
  const reprobe = useCallback(() => {
    void (async () => {
      const probed = await fetchFacts();
      if (probed) setFacts((prev) => (sameFacts(prev, probed) ? prev : probed));
    })();
  }, []);
  useEffect(() => {
    window.addEventListener(HERMES_MODEL_STATE_EVENT, reprobe);
    window.addEventListener(CHAT_MODEL_STATE_EVENT, reprobe);
    return () => {
      window.removeEventListener(HERMES_MODEL_STATE_EVENT, reprobe);
      window.removeEventListener(CHAT_MODEL_STATE_EVENT, reprobe);
    };
  }, [reprobe]);

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
