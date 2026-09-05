// Which edition this ClawBox is, resolved ONCE at MCP startup.
//
// WHY import readEdition() instead of asking the API: the edition is a property
// of the INSTALL, baked into the root-owned /etc/clawbox/edition.env. Asking
// /setup-api/harness/active first meant a slow or unauthenticated API answered
// "openclaw" on a Hermes box — failing OPEN onto the wrong tool set. The file
// is authoritative and free to read, so it decides.
//
// WHY the result decides REGISTRATION and not runtime behaviour: Hermes trips a
// per-server circuit breaker when one tool keeps failing, which takes every
// ClawBox tool offline for the agent. A tool that cannot work here must be
// absent from tools/list, not present-and-erroring.

import { readFileSync, statSync } from "fs";
import { readEdition } from "../../src/lib/edition-source";

export type Ed = "openclaw" | "hermes";

const HARNESS_TIMEOUT_MS = 3_000;

// Same path src/lib/edition-source.ts reads; re-stated (not exported from there)
// only to tell "the lock is absent" apart from "the lock is unreadable".
// Not an edition-lock bypass — see the note on the same constant in
// src/lib/edition-source.ts. What it can influence HERE is the tool set, and the
// env supplying it is the one that launches this server, so anyone able to set it
// already has the clawbox shell that the smaller set withholds.
const EDITION_FILE = process.env.CLAWBOX_EDITION_FILE || "/etc/clawbox/edition.env";

/**
 * True when the lock file EXISTS but this process cannot get an edition out of
 * it (permissions changed, a partial reflash, a truncated write).
 *
 * readEdition() collapses that case into its "openclaw" default, which is the
 * conservative answer for the APP (openclaw is the non-premium SKU) and the
 * wrong direction here: openclaw is the LARGER tool set and the only one
 * carrying bash, write_file, edit_file, grep and glob. "I could not read the
 * lock" must therefore resolve to the SMALLER set, so a transient read failure
 * cannot widen the surface a device was deliberately configured without.
 *
 * An ABSENT file is a different case — dev machines, CI and pre-3.x installs
 * never had one — and keeps the documented env fallback.
 */
function lockUnreadable(): boolean {
  try {
    statSync(EDITION_FILE);
  } catch {
    return false;
  }
  try {
    return !/CLAWBOX_EDITION\s*=/.test(readFileSync(EDITION_FILE, "utf-8"));
  } catch {
    return true;
  }
}

/**
 * The tool set to register.
 *
 * A locked edition ("openclaw" / "hermes") wins outright — that install only
 * has one harness on disk. Only the unlocked premium "dual" edition has a
 * runtime choice, and there `appHarness` — what the device itself said — is the
 * single source of truth; a null falls back to "openclaw", the default harness
 * src/lib/harness.ts also degrades to.
 *
 * ASKS THE DEVICE NOTHING. It takes the answer `resolveAppHarness` already got,
 * so a startup makes ONE probe and the tool set and the app list cannot be
 * built from two different replies — a dual box whose first probe said `hermes`
 * and whose second timed out registered the Hermes tool set beside an app list
 * that hid both dashboards, for the life of that stdio child. Synchronous now,
 * which is what makes a second probe impossible rather than merely unlikely.
 */
export function resolveEdition(appHarness: Ed | null): Ed {
  if (lockUnreadable()) {
    // FAIL CLOSED, whatever the device answered. This is where the two
    // questions differ in DIRECTION: the tool sets are nested, so the smaller
    // one is the safe answer to a doubt — OpenClaw is the larger surface and
    // the only one carrying the shell and file tools, and an unreadable lock
    // must not hand them out. The APP sets are not nested, so the same doubt
    // there answers `null` and hides both (see `resolveAppHarness`).
    console.error(
      "[clawbox-mcp] /etc/clawbox/edition.env exists but no edition could be read from it. "
      + "Registering the SMALLER Hermes tool set: the shell and file tools stay off until the lock is readable.",
    );
    return "hermes";
  }
  const installed = readEdition();
  if (installed === "openclaw" || installed === "hermes") return installed;
  // Dual box whose API was not up — register the default harness's tools rather
  // than an empty or half-wrong set.
  return appHarness ?? "openclaw";
}

/**
 * Which harness's built-in APPS this device shows, or null when that cannot be
 * determined.
 *
 * A SEPARATE QUESTION from `resolveEdition`, and the difference is the whole
 * reason this exists. That one picks a TOOL SET, where the two answers are
 * nested — hermes is openclaw minus the shell and file tools — so an
 * undetermined edition can fail closed onto the smaller one. The app sets are
 * not nested: `openclaw`/`store`/`memory-shard` against `hermes`/
 * `hermes-skills`. Answering "hermes" for an unreadable lock would refuse
 * three apps the box has AND tick off two it may not, which is the same false
 * success the gate exists to stop.
 *
 * So this returns null instead, and every caller hides BOTH harness-only sets
 * — the answer `hiddenAppIdsForHarness(null)` already gives the desktop while
 * its own fetch is in flight.
 *
 * AN UNREADABLE LOCK IS NOT ASKED ABOUT, because on that box the route has no
 * independent answer to give. `/setup-api/harness/active` always answers, but
 * traced out it is the SAME FILE this process just failed to read:
 * `getActiveHarness()` -> `lockedHarness()` -> `isDualUnlocked()` is false
 * because `readEdition()` fell back -> `getEdition()` -> `readEdition()` ->
 * `"openclaw"`, its own default (src/lib/harness.ts:82-127,
 * src/lib/edition-source.ts:65-77). So on an unreadable lock that route can
 * only ever say "openclaw", on a Hermes box as readily as on an OpenClaw one —
 * and taking it as the answer would register the Hermes TOOL SET beside an
 * OpenClaw app list, deny the box its own `hermes-skills` with "there is no
 * such app" (TASK-541's original symptom, verbatim) and tick off `openclaw` and
 * `store` on a box that has neither.
 *
 * Asking is right for `dual`, where the route resolves a real runtime choice
 * from the config store. It is not right here, and the difference is exactly
 * whether the device knows something this process does not.
 *
 * No console line: this is asked by the CLI as well as the MCP, and one
 * invocation of `clawbox app list` registers no tools.
 */
export async function resolveAppHarness(
  apiBase: string,
  authHeader: string | null,
): Promise<Ed | null> {
  if (lockUnreadable()) return null;
  const installed = readEdition();
  if (installed === "openclaw" || installed === "hermes") return installed;
  return askActiveHarness(apiBase, authHeader);
}

/**
 * The harness the DEVICE says is active, or null when it did not say.
 *
 * Null rather than a default, because the two callers want opposite things
 * from a silence: registration needs some tool set, an app gate must not claim
 * a harness it never resolved.
 */
async function askActiveHarness(apiBase: string, authHeader: string | null): Promise<Ed | null> {
  try {
    const res = await fetch(`${apiBase}/setup-api/harness/active`, {
      headers: {
        accept: "application/json",
        ...(authHeader ? { authorization: authHeader } : {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(HARNESS_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as { active?: unknown };
      if (body?.active === "hermes") return "hermes";
      if (body?.active === "openclaw") return "openclaw";
    }
  } catch {
    // The device could not be reached, or answered something this build does
    // not know. Either way nothing was resolved.
  }
  return null;
}

/** The raw install edition, for reporting (can be "dual"). */
export function installEdition(): "openclaw" | "hermes" | "dual" {
  return readEdition();
}
