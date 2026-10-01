"use client";

import { useEffect, useState } from "react";
import { isUpdateWhatsNew, UPDATE_WHATS_NEW_ENDPOINT, type UpdateWhatsNew } from "@/lib/update-whats-new";

/**
 * Asked again this long after the route could not be reached. The rebuild
 * stops the server for minutes, and this is the screen that stays open across
 * it, so a failure is retried for as long as the page lives — a request that
 * fails at once every 15 s is nothing to a box that is rebooting anyway.
 */
export const RETRY_AFTER_FAILURE_MS = 15_000;
/**
 * Asked again this long after the route answered that it could not read the
 * notes. The checkout may simply not be synced yet, or GitHub not reachable
 * yet; the route holds GitHub off for a minute after a miss by itself.
 */
export const RETRY_AFTER_NONE_MS = 60_000;
/** How many "could not read them" answers are worth asking past. */
export const MAX_NONE_ANSWERS = 5;
/**
 * How many failed asks before giving up: half an hour at the failure interval,
 * past the update screen's own "this is taking too long" point. A server that
 * answers but has no such route (an update onto a release without it) is not
 * asked for ever.
 */
export const MAX_FAILURES = 120;
/** The route's own git and GitHub budgets, plus room. */
export const CLIENT_TIMEOUT_MS = 15_000;

export interface UpdateWhatsNewLoad {
  /** The route's best answer so far, or null while it has given none. */
  answer: UpdateWhatsNew | null;
  /** At least one ask has finished — answered or failed. Until then the panel is not drawn. */
  settled: boolean;
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

/**
 * The /updating screen's "What's new" answer (TASK-1205).
 *
 * Asked once on mount, off the update's own poll — it never delays a status
 * read. An answer read from notes ends the timer. Anything less is asked again
 * on a timer, and a better answer only ever REPLACES a worse one: highlights
 * the screen already has are never swapped for a "could not read them" from a
 * server that came back up without them.
 *
 * `refreshKey` asks again whenever it changes — the screen bumps it each time
 * the box answers again after an outage. The first answer can come before the
 * updater's own fetch has moved the branch ref, when the ref still names the
 * release being REPLACED; the server that comes back from the rebuild reads
 * the synced checkout, so its answer is the one to keep. New highlights
 * replace old ones; "could not read them" still never does.
 */
export function useUpdateWhatsNew(refreshKey: unknown = 0): UpdateWhatsNewLoad {
  const [answer, setAnswer] = useState<UpdateWhatsNew | null>(null);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    let noneAnswers = 0;
    let failures = 0;

    const ask = async () => {
      let answered: UpdateWhatsNew | null = null;
      try {
        const res = await fetch(UPDATE_WHATS_NEW_ENDPOINT, { cache: "no-store", signal: timeoutSignal(CLIENT_TIMEOUT_MS) });
        const data: unknown = res.ok ? await res.json() : null;
        if (isUpdateWhatsNew(data)) answered = data;
      } catch {
        // Expected mid-update: the rebuild stops the server. Ask again later.
      }
      if (stop) return;
      setSettled(true);

      let retryIn: number | null;
      if (answered) {
        const next = answered;
        setAnswer((prev) => (prev?.source === "notes" && next.source !== "notes" ? prev : next));
        retryIn = next.source === "notes" || ++noneAnswers >= MAX_NONE_ANSWERS ? null : RETRY_AFTER_NONE_MS;
      } else {
        retryIn = ++failures >= MAX_FAILURES ? null : RETRY_AFTER_FAILURE_MS;
      }
      if (retryIn !== null) timer = window.setTimeout(() => { void ask(); }, retryIn);
    };

    void ask();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [refreshKey]);

  return { answer, settled };
}
