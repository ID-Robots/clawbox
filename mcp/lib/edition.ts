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
 * runtime choice, and there the device's own /setup-api/harness/active is the
 * single source of truth; a failure there falls back to "openclaw", the default
 * harness src/lib/harness.ts also degrades to.
 */
export async function resolveEdition(apiBase: string, authHeader: string | null): Promise<Ed> {
  if (lockUnreadable()) {
    console.error(
      "[clawbox-mcp] /etc/clawbox/edition.env exists but no edition could be read from it. "
      + "Registering the SMALLER Hermes tool set: the shell and file tools stay off until the lock is readable.",
    );
    return "hermes";
  }
  const installed = readEdition();
  if (installed === "openclaw" || installed === "hermes") return installed;

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
    }
  } catch {
    // Dual box whose API is not up yet — register the default harness's tools
    // rather than an empty or half-wrong set.
  }
  return "openclaw";
}

/** The raw install edition, for reporting (can be "dual"). */
export function installEdition(): "openclaw" | "hermes" | "dual" {
  return readEdition();
}
