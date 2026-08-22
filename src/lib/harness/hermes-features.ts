import { runHermesCli } from "@/lib/hermes-cli";

/**
 * What the INSTALLED `hermes` can do — asked, not assumed. SERVER ONLY.
 *
 * The Hermes agent is a git checkout of an upstream project that moves daily,
 * and this box's copy is whatever the last update pulled. Everything the chat
 * surface offers on top of it therefore has to be a probed fact rather than a
 * compile-time constant: a compiled-in `true` would put an attach button on a
 * box whose `hermes` ignores the flag, so the file would stage, the turn would
 * run, and the model would answer about a picture it never saw. A wrong `false`
 * only hides a working button; a wrong `true` silently loses the user's data.
 * So this fails CLOSED.
 */

/** Probing costs a Python interpreter start. Long enough for a busy Jetson. */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Once per process, never per request.
 *
 * `hermes chat --help` starts a Python interpreter, which on this hardware is
 * seconds, not milliseconds — running it per request would put that on every
 * chat open. The cache is the in-flight PROMISE, not the resolved value, so
 * concurrent callers during boot share one probe instead of racing several.
 *
 * A process restart re-probes, which is exactly the granularity that matters:
 * an update replaces the checkout and restarts the web server, so the answer
 * cannot outlive the binary it describes.
 */
let probe: Promise<boolean> | null = null;

/**
 * Does this `hermes` take an image on a chat turn?
 *
 * Verified against the live checkout (`~/.hermes/hermes-agent` @ 1091472,
 * 2026-08-22): `hermes chat --help` lists
 *
 *   --image IMAGE   Optional local image path to attach to a single query
 *
 * The help text is the right thing to read rather than a version number: a
 * version says which commit is checked out, and only a flag list says what that
 * commit accepts. Matched on the flag as it appears in the options list, so a
 * mention in prose elsewhere in the help cannot answer yes on its own.
 */
export async function hermesSupportsImages(): Promise<boolean> {
  probe ??= (async () => {
    try {
      const result = await runHermesCli(["chat", "--help"], { timeoutMs: PROBE_TIMEOUT_MS });
      if (result.code !== 0) return false;
      return /^\s*--image\b/m.test(`${result.stdout}\n${result.stderr}`);
    } catch {
      // Not installed, timed out, or the checkout is broken. All of them mean
      // the same thing to the composer: do not offer to attach a picture.
      return false;
    }
  })();
  return probe;
}

/** Test seam: forget the probe so the next call runs it again. */
export function resetHermesFeatureProbe(): void {
  probe = null;
}
