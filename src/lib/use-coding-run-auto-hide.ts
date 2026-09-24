"use client";

import { useCallback, useMemo, useState } from "react";
import type { CodingRunStatus } from "@/lib/coding-agent-status";
import { useAutoHide } from "@/lib/use-auto-hide";

/**
 * How long a chat run card stays after its run finishes cleanly.
 *
 * The owner asked for less clutter in the chat: a card whose run ended well
 * has nothing left to ask of anyone, so it stays long enough to be seen
 * turning green and then goes on its own. Nothing is lost when it goes — the
 * run record is untouched, the chat's 🤖 chip brings the card back, and the
 * Coding Agent app keeps the run's history.
 *
 * globals.css (`.coding-agent-autohide`) fades the card out over the last
 * 240 ms of this, so its delay and duration add up to this number.
 */
export const CODING_RUN_AUTO_HIDE_MS = 5_000;

const NONE: ReadonlySet<string> = new Set();

function without(set: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> {
  if (!ids.some((id) => set.has(id))) return set;
  const next = new Set(set);
  for (const id of ids) next.delete(id);
  return next;
}

function including(set: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> {
  if (ids.every((id) => set.has(id))) return set;
  const next = new Set(set);
  for (const id of ids) next.add(id);
  return next;
}

type RunState = { id: string; status: CodingRunStatus };

function sameStatuses(a: readonly RunState[], b: readonly RunState[]): boolean {
  return a === b || (a.length === b.length && a.every((run, i) => run.id === b[i].id && run.status === b[i].status));
}

/**
 * Which chat run cards are counting down to leaving, and which have left.
 *
 * ONLY A RUN SEEN REACHING `completed`. The clock starts when a run this hook
 * has already seen in some other status turns up `completed`. A run that is
 * `completed` the first time it is seen gets no clock: that is a run that
 * ended just before the chat opened, and use-coding-agent-activity.ts adopts
 * it precisely so the owner can read about it. Every other status — running,
 * paused, failed, stopped, gave up, draft — either is still going or wants
 * the owner, so it never counts down.
 *
 * A run that stops being `completed` (resumed, say) loses its clock and comes
 * back if it had already gone; if it finishes again it gets a fresh five
 * seconds. Each run has its own clock (useAutoHide), and every clock is
 * cleared on unmount. A run the activity hook lets go of is forgotten here
 * too, so closing the chat — which empties that hook — clears the lot.
 *
 * This hides CARDS, not runs: `restore()` brings back every card that went on
 * its own, and they do not count down again.
 */
export function useCodingRunAutoHide(runs: readonly RunState[]): {
  /** Runs whose card is still shown but will leave when its clock runs out. */
  finishing: ReadonlySet<string>;
  /** Runs whose card has left on its own. */
  hidden: ReadonlySet<string>;
  /** Bring back every card that left on its own. */
  restore: () => void;
} {
  const [finishing, setFinishing] = useState(NONE);
  const [hidden, setHidden] = useState(NONE);
  // The runs as they were the last time a status changed — what makes a
  // `completed` a transition rather than a first sight. Compared while
  // rendering, the way React documents adjusting state to a changed prop,
  // rather than in an effect: the card that just turned green starts its
  // countdown in that same render, with no second pass to catch up. By
  // CONTENT, not identity, so a caller that builds a new array every render
  // cannot turn this into a render loop.
  const [last, setLast] = useState(runs);
  if (!sameStatuses(last, runs)) {
    const before = new Map(last.map((run) => [run.id, run.status]));
    const finished: string[] = [];
    const cleared: string[] = [];
    const present = new Set<string>();
    for (const { id, status } of runs) {
      present.add(id);
      const was = before.get(id);
      if (was === undefined || was === status) continue;
      if (status === "completed") finished.push(id);
      else if (was === "completed") cleared.push(id);
    }
    for (const [id, was] of before) {
      if (!present.has(id) && was === "completed") cleared.push(id);
    }
    setLast(runs);
    if (finished.length > 0 || cleared.length > 0) {
      setFinishing((prev) => including(without(prev, cleared), finished));
    }
    if (cleared.length > 0) setHidden((prev) => without(prev, cleared));
  }

  const counting = useMemo(() => [...finishing], [finishing]);
  const expire = useCallback((id: string) => {
    setFinishing((prev) => without(prev, [id]));
    setHidden((prev) => including(prev, [id]));
  }, []);
  useAutoHide(counting, expire, CODING_RUN_AUTO_HIDE_MS);

  const restore = useCallback(() => setHidden((prev) => (prev.size === 0 ? prev : NONE)), []);

  return { finishing, hidden, restore };
}
