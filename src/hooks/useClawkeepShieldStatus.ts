"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  deriveProtection,
  isBackupRunning,
  type Protection,
  type ProtectionInput,
} from "@/lib/clawkeep-protection";

/** How often the desktop asks the box how its backup is doing. Fast, because
 *  the shelf's progress pulse has to start and stop within a few seconds of a
 *  backup beginning or finishing. */
const POLL_MS = 5_000;

/** How often the verdict is re-judged against the clock, with or without a new
 *  answer. A minute is well inside the smallest window the shield uses (36 h)
 *  and cheap: an unchanged verdict re-uses the previous object, so an idle
 *  desktop does not re-render. */
const AGE_MS = 60_000;

export interface ClawkeepShieldStatus {
  /** The shared protection verdict. Null until the first answer arrives, and
   *  for a box that has never been paired — that one is an invitation, not a
   *  judgement. */
  protection: Protection | null;
  unconfigured: boolean;
  busy: boolean;
  restoring: boolean;
}

/**
 * What the desktop shelf's ClawKeep shield knows.
 *
 * The judgement itself is `deriveProtection` — the same one the ClawKeep card
 * and the `backup_status` tool draw, so the surfaces cannot disagree about
 * whether the box is protected. What lives here is *when* it is asked.
 *
 * It is asked on two clocks, and the second one is the point. A verdict that
 * only moves when a response arrives is a verdict that stops ageing the moment
 * the box stops answering — and on the boxes where that matters, the answer it
 * freezes on is green. So the facts that arrived are kept, and re-judged on a
 * tick of their own; a failed poll still leaves the last state alone, so the
 * shield does not flicker on a network blip, but it can no longer stop time.
 * The card ages on its own tick for exactly the same reason.
 *
 * The facts are never invented: nothing is re-derived until at least one
 * successful answer has been seen, and the tick re-judges only what that answer
 * actually said.
 */
export function useClawkeepShieldStatus(): ClawkeepShieldStatus {
  const [protection, setProtection] = useState<Protection | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  // The last facts that arrived, so the verdict can keep ageing without new ones.
  const facts = useRef<ProtectionInput | null>(null);

  const publish = useCallback((input: ProtectionInput, nowMs: number) => {
    const next = deriveProtection(input, nowMs);
    setProtection((prev) => (
      prev && prev.state === next.state && prev.reason === next.reason ? prev : next
    ));
    // A "running" heartbeat older than the cap `runBackup()` enforces is a run
    // that has been SIGKILLed, not progress — the same rule the card uses.
    // Without it the shelf pulses green for ever and the verdict never reaches it.
    setBusy(isBackupRunning(input, nowMs));
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (facts.current) publish(facts.current, Date.now());
    }, AGE_MS);
    return () => window.clearInterval(id);
  }, [publish]);

  useEffect(() => {
    let aborted = false;
    let inFlight = false;
    const check = async () => {
      // Skip ticks while a previous fetch is still outstanding so a slow
      // device doesn't pile up overlapping requests.
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch("/setup-api/clawkeep", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json() as ProtectionInput & {
          paired?: boolean;
          restoring?: boolean;
        };
        if (aborted) return;
        // A box that was never paired has no backup that could be "overdue";
        // it gets the calm not-set-up-yet shield, not the red alert. Only an
        // explicit `paired: false` counts — a response missing the field keeps
        // the old alert fallback rather than silencing a real overdue backup.
        const notPaired = data.paired === false;
        const now = Date.now();
        const input: ProtectionInput = {
          lastBackupAtMs: data.lastBackupAtMs ?? 0,
          lastHeartbeatAtMs: data.lastHeartbeatAtMs,
          lastHeartbeatStatus: data.lastHeartbeatStatus,
          schedule: data.schedule,
          scheduleArmedAtMs: data.scheduleArmedAtMs,
          encryptionConfigured: data.encryptionConfigured,
        };
        facts.current = notPaired ? null : input;
        setUnconfigured(notPaired);
        // The whole verdict travels, not a pair of booleans: the shelf paints a
        // drifted box amber and a never-protected one red, and it has to say
        // WHICH out loud — colour alone is not an announcement. An unpaired box
        // publishes no verdict at all: `paired: false` is the opt-in that has
        // not happened, and it earns the calm setup shield rather than an alarm
        // about a backup nobody asked for (TASK-510). Its progress pulse still
        // answers, because a first backup can be running on it.
        if (notPaired) {
          setProtection(null);
          setBusy(isBackupRunning(input, now));
        } else {
          publish(input, now);
        }
        setRestoring(!!data.restoring);
      } catch {
        // Leave last-known state alone on transient failures so the shield
        // doesn't flicker on a brief network blip. The age tick above is what
        // stops that becoming a verdict frozen in time.
      } finally {
        inFlight = false;
      }
    };
    void check();
    const id = window.setInterval(() => { void check(); }, POLL_MS);
    return () => {
      aborted = true;
      window.clearInterval(id);
    };
  }, [publish]);

  return { protection, unconfigured, busy, restoring };
}
