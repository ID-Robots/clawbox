import { fetchHarness, type HarnessInfo } from "@/lib/client-harness";

/**
 * "Which harness is this box?", asked the way BOTH surfaces have to ask it.
 *
 * The answer can be temporarily unknowable rather than wrong: `install.sh`
 * truncates and rewrites the root-owned edition lock on every update, and a page
 * that mounts inside that window is told "openclaw, and that was a guess"
 * (`activeKnown: false`). A single probe makes that permanent for the life of
 * the tab — the probe-once class — which on `/app/<id>` meant the OpenClaw App
 * Store rendered on a Hermes box and the box's own brand never appeared.
 *
 * The desktop already backed off and asked again; the standalone window did not.
 * This is that rule, in one place, so the two cannot drift again.
 *
 * NOT a poll: a settled answer ends it, and so does running out of attempts. An
 * unsettled answer is still returned — it is the honest one for now, and the
 * caller decides what to show for it.
 */

/** Between attempts: 500 ms, then 1 s. Long enough to outlast a file rewrite. */
const BACKOFF_MS = 500;

/** Extra asks after the first. The desktop's number, now everyone's. */
const DEFAULT_RETRIES = 2;

/**
 * Did the DEVICE answer this, or is it the fallback nothing could improve on?
 *
 * The same test `brandingHarness` makes (`src/lib/builtin-wallpapers.ts`), and
 * deliberately as narrow: `activeKnown` alone would settle on a harness name
 * this build does not know, where the desktop's old loop asked again.
 */
export function harnessProbeSettled(info: HarnessInfo | null): boolean {
  if (info?.activeKnown !== true) return false;
  return info.active === "openclaw" || info.active === "hermes";
}

export interface HarnessProbeOptions {
  /** Aborts the in-flight request AND cancels any pending retry. */
  signal?: AbortSignal;
  /**
   * Called after EVERY attempt with what it got — an answer that named a
   * harness, or `null` when nothing answered at all.
   *
   * Both matter, and the two surfaces want opposite things from the null: the
   * desktop stays unresolved (which hides both harnesses' apps — safe either
   * way), while `/app/<id>` shows its own "unknown" at once rather than a
   * spinner for the whole retry budget. Waiting for the settled answer to tell
   * either of them anything would have made a mid-update mount sit on
   * "Loading…" for a second and a half.
   */
  onAnswer?: (info: HarnessInfo | null) => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function resolveHarnessProbe(options: HarnessProbeOptions = {}): Promise<HarnessInfo | null> {
  let last: HarnessInfo | null = null;
  for (let attempt = 0; attempt <= DEFAULT_RETRIES; attempt++) {
    if (options.signal?.aborted) return last;
    // `force` from the second attempt on: the client cache would otherwise hand
    // back the very answer we are asking again about. `fetchHarness` answers
    // null rather than rejecting, so there is nothing to catch here.
    const info = await fetchHarness({ signal: options.signal, force: attempt > 0 });
    if (options.signal?.aborted) return last ?? info;
    const answered = info?.active ? info : null;
    if (answered) last = answered;
    options.onAnswer?.(answered);
    if (harnessProbeSettled(answered)) return answered;
    if (attempt < DEFAULT_RETRIES) await sleep(BACKOFF_MS * (attempt + 1), options.signal);
  }
  return last;
}
