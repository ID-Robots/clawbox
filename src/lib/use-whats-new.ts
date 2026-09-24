"use client";

import { useCallback, useEffect, useState } from "react";
import { isWhatsNewState, WHATS_NEW_RELEASE, type WhatsNewState } from "@/lib/whats-new";

export const WHATS_NEW_ENDPOINT = "/setup-api/whats-new";

export interface WhatsNewCardState {
  /** The route's last answer, or null until it has given one. */
  state: WhatsNewState | null;
  /** Is the card on screen? */
  visible: boolean;
  /** The owner closed it: gone for good, on every browser. */
  dismiss: () => void;
  /**
   * Gone for this page load only. This is what the desktop's auto-hide calls.
   * It is not recorded, so the card is back on the next load until it is
   * dismissed.
   */
  hide: () => void;
}

/**
 * The "What's new in 4.0" card's state, for the desktop.
 *
 * `refreshKey` asks the route again when it changes. The desktop passes the
 * ClawBox AI tier it already polls, so an owner who upgrades in the portal
 * stops seeing the plan section without reloading the page.
 */
export function useWhatsNew(refreshKey?: unknown): WhatsNewCardState {
  const [state, setState] = useState<WhatsNewState | null>(null);
  // Once hidden, never shown again on this page load. An answer still in
  // flight when the owner dismissed (a refresh that left before the POST
  // landed) updates `state` but cannot put the card back.
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(WHATS_NEW_ENDPOINT, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (!active || !isWhatsNewState(data)) return;
        setState(data);
      })
      .catch(() => { /* no card this time; the next load asks again */ });
    return () => { active = false; };
  }, [refreshKey]);

  const dismiss = useCallback(() => {
    setHidden(true);
    // Outside any state updater: React may run an updater twice, and this POST
    // must be sent once per click.
    fetch(WHATS_NEW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ release: WHATS_NEW_RELEASE }),
    }).catch(() => { /* not recorded: the card comes back on the next load */ });
  }, []);

  const hide = useCallback(() => setHidden(true), []);

  return { state, visible: !hidden && state?.show === true, dismiss, hide };
}
