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

/** Did the DEVICE answer this, or is it the fallback nothing could improve on? */
export function harnessProbeSettled(info: HarnessInfo | null): boolean {
  return info?.activeKnown === true && typeof info.active === "string" && info.active.length > 0;
}

export interface HarnessProbeOptions {
  /** Aborts the in-flight request AND cancels any pending retry. */
  signal?: AbortSignal;
  /** Extra attempts after the first (default 2). */
  retries?: number;
  /**
   * Called for every answer that named a harness, settled or not — so a caller
   * can paint the honest answer at once and let the retry improve it, which is
   * what the desktop does with its wallpaper.
   */
  onAnswer?: (info: HarnessInfo) => void;
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
  const retries = options.retries ?? DEFAULT_RETRIES;
  let last: HarnessInfo | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) return last;
    // `force` from the second attempt on: the client cache would otherwise hand
    // back the very answer we are asking again about.
    const info = await fetchHarness({ signal: options.signal, force: attempt > 0 }).catch(() => null);
    if (options.signal?.aborted) return last ?? info;
    if (info?.active) {
      last = info;
      options.onAnswer?.(info);
      if (harnessProbeSettled(info)) return info;
    }
    if (attempt < retries) await sleep(BACKOFF_MS * (attempt + 1), options.signal);
  }
  return last;
}
