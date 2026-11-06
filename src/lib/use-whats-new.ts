"use client";

import { useCallback, useEffect, useState } from "react";
import { isWhatsNewState, WHATS_NEW_RELEASE, type WhatsNewState } from "@/lib/whats-new";

export const WHATS_NEW_ENDPOINT = "/setup-api/whats-new";

/**
 * How long the desktop waits for the route before it stops holding its notice
 * cards for the card. A route that never answers must not keep them away for
 * good; if its answer lands later, the card still comes up, and the desktop
 * puts the notices away again while it is up.
 */
export const WHATS_NEW_SETTLE_MS = 8_000;

export interface WhatsNewCardState {
  /** The route's last answer, or null until it has given one. */
  state: WhatsNewState | null;
  /** Is the card on screen? */
  visible: boolean;
  /**
   * Has the route answered — or failed, or taken longer than
   * {@link WHATS_NEW_SETTLE_MS} — so the card's fate for this page load is
   * known? True at once when the hook is disabled. The desktop holds its
   * notice cards until then, so the ClawBox AI offer is never drawn a moment
   * before the card comes up over it.
   */
  settled: boolean;
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
 * The "What's new in 4.3" card's state, for the desktop.
 *
 * `refreshKey` asks the route again when it changes. The desktop passes the
 * ClawBox AI tier it already polls, so an owner who upgrades in the portal
 * stops seeing the plan section without reloading the page.
 *
 * `enabled: false` asks nothing and shows nothing — a non-owner's desktop
 * (TASK-1256): the card is the owner's, and the route refuses anyone else.
 */
export function useWhatsNew(refreshKey?: unknown, enabled: boolean = true): WhatsNewCardState {
  const [state, setState] = useState<WhatsNewState | null>(null);
  // Once hidden, never shown again on this page load. An answer still in
  // flight when the owner dismissed (a refresh that left before the POST
  // landed) updates `state` but cannot put the card back.
  const [hidden, setHidden] = useState(false);
  // Once the first answer is in, it stays in: a refresh on a tier change does
  // not put the desktop's notices on hold again.
  const [answered, setAnswered] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const giveUp = setTimeout(() => setAnswered(true), WHATS_NEW_SETTLE_MS);
    fetch(WHATS_NEW_ENDPOINT, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (!active || !isWhatsNewState(data)) return;
        setState(data);
      })
      .catch(() => { /* no card this time; the next load asks again */ })
      .finally(() => {
        clearTimeout(giveUp);
        if (active) setAnswered(true);
      });
    return () => { active = false; clearTimeout(giveUp); };
  }, [refreshKey, enabled]);

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

  return { state, visible: !hidden && state?.show === true, settled: !enabled || answered, dismiss, hide };
}
