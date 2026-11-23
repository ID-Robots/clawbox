// When the desktop's Telegram pairing poll asks the box.
//
// A new access request reaches the owner's screen only through this poll, so
// it asks every few seconds — but only where a request can appear. A box with
// no bot answers a confident `configured: false` and an empty list, every time,
// so it keeps the old 20 s: the fast beat would spend 17 extra requests a
// minute per open desktop on an answer that can never hold a request.
//
// One interval at the FAST beat that SKIPS beats while slow, rather than an
// interval re-created at a second delay: the hidden-tab rule lives in
// `setVisibleInterval`, which owns the one interval. Kept out of React state,
// so a switch of cadence re-renders nothing.

import { monotonicNow } from "./monotonic-clock";

export interface PairingPollCadence {
  /**
   * Whether this beat asks the box; a yes is recorded as the ask. Every beat
   * asks while fast. While slow, a beat asks once `slowMs` has passed since the
   * last ask, on the interval's own beat and with half a beat to spare, as
   * `setVisibleInterval` judges a hidden run.
   */
  shouldAsk(): boolean;
  /**
   * What an OK answer of the route said. Fast while it says a bot is
   * configured, or that the credential could not be read (`unknown`: the page
   * still draws that store's requests); slow only for a confident
   * `configured: false`. A failed ask passes nothing, and an answer that says
   * neither keeps the cadence: a restart or a 500 must not slow a box with a bot.
   */
  answered(answer: unknown): void;
}

export function pairingPollCadence(beatMs: number, slowMs: number): PairingPollCadence {
  // Fast until the first OK answer says otherwise: the first ask runs at mount
  // and answers within a beat on a box with no bot.
  let fast = true;
  let lastAsk = Number.NEGATIVE_INFINITY;
  const slowWait = Math.ceil(slowMs / beatMs) * beatMs - beatMs / 2;
  return {
    shouldAsk() {
      const now = monotonicNow();
      if (!fast && now - lastAsk < slowWait) return false;
      lastAsk = now;
      return true;
    },
    answered(answer) {
      if (typeof answer !== "object" || answer === null) return;
      const { configured, unknown } = answer as { configured?: unknown; unknown?: unknown };
      if (configured === true || unknown === true) fast = true;
      else if (configured === false) fast = false;
    },
  };
}
