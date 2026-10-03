"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  deriveProtection,
  isBackupRunning,
  type Protection,
  type ProtectionInput,
} from "@/lib/clawkeep-protection";
import { monotonicNow } from "@/lib/visible-interval";

/** How often the desktop asks the box how its backup is doing. Fast, because
 *  the shelf's progress pulse has to start and stop within a few seconds of a
 *  backup beginning or finishing. */
const POLL_MS = 5_000;

/** How often the verdict is re-judged against the clock, with or without a new
 *  answer. A minute is well inside the smallest window the shield uses (36 h)
 *  and cheap: an unchanged verdict re-uses the previous object, so an idle
 *  desktop does not re-render. */
const AGE_MS = 60_000;

/**
 * A /setup-api/clawkeep answer, readable by every caller it is handed to. The
 * body is read ONCE, by the request; `json()` hands each reader the same parsed
 * value (or the same parse error), so a caller written against a fetch
 * Response — `jsonOrError` — reads it exactly as it read its own.
 */
export interface ClawkeepStatusResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}

/** What one request came back with: a response, or the error fetch threw. */
export type ClawkeepStatusAnswer =
  | { response: ClawkeepStatusResponse; error?: undefined }
  | { response?: undefined; error: unknown };

/** An answer and its place in the order the requests were STARTED. */
export interface ClawkeepStatusResult {
  answer: ClawkeepStatusAnswer;
  /** Higher is newer. A caller holding a newer answer ignores an older one. */
  seq: number;
}

/**
 * A timer's request that is still out after this long is no longer joined: a
 * new one is started beside it. Below this the box is merely slow (one request
 * at a time, as each poll's own in-flight guard always kept it); above it a
 * request that never settles would otherwise hold every caller in the page.
 * Timed on `monotonicNow()`, not the wall clock: the box has no RTC and its
 * clock steps at NTP sync, and a step back kept a stuck request joinable — the
 * shield and the ClawKeep window both waiting on it — for the step's length.
 */
const JOIN_MAX_MS = 15_000;

/**
 * The ONE place this page asks GET /setup-api/clawkeep.
 *
 * The shelf's shield and the ClawKeep window both want the box's backup state:
 * the shield every 5 s, the window every 10 s (3 s while a backup runs). Each
 * used to run its own poll, so with the window open the box answered both —
 * the same route, the same nine file reads, twice. They now share the
 * requests: every answer the window asks for also reaches the shield, which
 * then has no reason to ask for itself until 5 s have passed without one
 * (`useClawkeepShieldStatus`), and a tick that falls due while a request is
 * already out joins it instead of starting a second.
 *
 * Each caller keeps its own clock and its own reading of an answer. The window
 * takes only the answers it asked for — at its own cadence, so a failure it
 * shows is cleared by its own next look exactly as before — and the shield,
 * which never shows a failure, takes every usable answer, so it is only ever
 * as fresh or fresher than it was. Nothing is cached: a request is never
 * answered from an earlier one.
 */
const statusWatchers = new Set<(result: ClawkeepStatusResult) => void>();
let statusIssued = 0;
let statusPublished = 0;
let statusOut: { promise: Promise<ClawkeepStatusResult>; startedAt: number } | null = null;

function startStatusRequest(): Promise<ClawkeepStatusResult> {
  const seq = ++statusIssued;
  const promise = (async (): Promise<ClawkeepStatusResult> => {
    let answer: ClawkeepStatusAnswer;
    try {
      const res = await fetch("/setup-api/clawkeep", { cache: "no-store" });
      let body: unknown;
      let bodyError: unknown;
      let parsed = false;
      try {
        body = await res.json();
        parsed = true;
      } catch (err) {
        bodyError = err;
      }
      answer = {
        response: {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText ?? "",
          json: () => (parsed ? Promise.resolve(body) : Promise.reject(bodyError)),
        },
      };
    } catch (error) {
      answer = { error };
    }
    const result = { answer, seq };
    // Only forward in time: an answer that lands after a newer one has been
    // handed out says less than what every watcher already has.
    if (seq > statusPublished) {
      statusPublished = seq;
      for (const watch of [...statusWatchers]) {
        try {
          watch(result);
        } catch {
          // One reader's fault is not another's answer, nor the caller's.
        }
      }
    }
    return result;
  })();
  statusOut = { promise, startedAt: monotonicNow() };
  void promise.finally(() => {
    if (statusOut?.promise === promise) statusOut = null;
  });
  return promise;
}

/**
 * A timer's look: joins a request that is already out (and not stuck), or
 * starts one. What a ticking poll did with its own in-flight guard, page-wide.
 */
export function pollClawkeepStatus(): Promise<ClawkeepStatusResult> {
  const out = statusOut;
  if (out && monotonicNow() - out.startedAt < JOIN_MAX_MS) return out.promise;
  return startStatusRequest();
}

/**
 * A look that must start NOW — after an action, the box's state has to be
 * read from a request sent after it, so this never joins one already out.
 */
export function refreshClawkeepStatus(): Promise<ClawkeepStatusResult> {
  return startStatusRequest();
}

/** Every answer from here on, whoever asked. Answers the unsubscribe. */
function watchClawkeepStatus(watch: (result: ClawkeepStatusResult) => void): () => void {
  statusWatchers.add(watch);
  return () => { statusWatchers.delete(watch); };
}

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
 *
 * `enabled: false` asks nothing (a non-owner's desktop, TASK-1256: the backup
 * is the owner's, and the route refuses anyone else with 403).
 *
 * The 5 s ask waits while the page is HIDDEN — a phone or a laptop tab in the
 * background — the rule the chat's own polls keep (`installPendingRefresh`):
 * the shelf it feeds cannot be seen, and a tick that falls due then is asked
 * the moment the page is visible again, so the shield the owner comes back to
 * is at least as fresh as before. The age tick keeps running regardless (it
 * asks the box nothing). The box's own screen gets no exemption, though it can
 * be hidden too — the kiosk's desktop tab while the owner is on another of its
 * tabs, a minimised monitor session window: the shelf is not on screen then
 * either, and it is asked again the moment it is.
 *
 * Its requests are the page's (`pollClawkeepStatus`), shared with the ClawKeep
 * window: an answer the window asked for counts as the shield's look, so the
 * 5 s is "5 s without an answer", and alone on the page that is every 5 s.
 */
export function useClawkeepShieldStatus(enabled: boolean = true): ClawkeepShieldStatus {
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
    if (!enabled) return;
    let aborted = false;
    /** A tick fell due while the page was hidden; it is asked on the visible edge. */
    let missed = false;
    let timer: number | undefined;
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    // A timeout re-armed by every usable answer, not a fixed interval: an
    // answer the ClawKeep window asked for is as good as one asked for here,
    // so with the window open (10 s, or 3 s while a backup runs) the shield
    // takes the window's answers and asks for itself only once 5 s have gone
    // by without one. Alone on the page it asks every 5 s, as it always did.
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(tick, POLL_MS);
    };
    const ask = () => {
      missed = false;
      // The next look in 5 s whatever this one brings; a request already out
      // (this page's, from any caller) is joined rather than doubled, so a
      // slow device does not pile up overlapping requests.
      arm();
      void pollClawkeepStatus();
    };
    const tick = () => {
      if (hidden()) {
        // Nothing more until the visible edge.
        missed = true;
        return;
      }
      ask();
    };
    const take = async ({ answer }: ClawkeepStatusResult) => {
      const res = answer.response;
      // Leave last-known state alone on failures — a refusal, a page that is
      // not JSON, a network blip — so the shield doesn't flicker. The age tick
      // above is what stops that becoming a verdict frozen in time.
      if (!res?.ok) return;
      // Partial: this is an untrusted response, and asserting more about it
      // than the wire guarantees is how a missing field becomes a verdict.
      let data: Partial<ProtectionInput> & { paired?: boolean; restoring?: boolean };
      try {
        data = await res.json() as typeof data;
      } catch {
        return;
      }
      if (aborted || !data || typeof data !== "object") return;
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
      // Fresh facts, whoever asked for them: the next look is 5 s from these.
      arm();
    };
    const unwatch = watchClawkeepStatus((result) => { void take(result); });
    // Only the visible EDGE, and only for a tick that fell due while away.
    const onVisibility = () => {
      if (!hidden() && missed) ask();
    };
    ask();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      aborted = true;
      unwatch();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [publish, enabled]);

  return { protection, unconfigured, busy, restoring };
}
