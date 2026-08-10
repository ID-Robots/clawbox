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

import { readEdition } from "../../src/lib/edition-source";

export type Ed = "openclaw" | "hermes";

const HARNESS_TIMEOUT_MS = 3_000;

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
