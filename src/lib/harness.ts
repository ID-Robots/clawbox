// Dual-harness router. ClawBox can drive its agent through OpenClaw (the
// default gateway) or Hermes (Nous Research), sharing one identity via the
// canonical ~/.clawbox/agent-identity bridge (see scripts/setup-shared-identity.sh).
// The user picks the active harness; providers/OAuth stay separate per harness.
//
// This module is the single source of truth for "which harness is active" and
// "where each harness's local server lives" — chat/gateway routing and the
// Settings picker both read it.

import fs from "fs";
import path from "path";
import { get, set } from "@/lib/config-store";

export type Harness = "openclaw" | "hermes";

// Where the Hermes CLI lives — the single source of truth (the chat route
// imports this rather than re-deriving it).
export const HERMES_BIN =
  process.env.HERMES_BIN || path.join(process.env.HOME || "/home/clawbox", ".local", "bin", "hermes");

export const HARNESS_CONFIG_KEY = "active_harness";
export const DEFAULT_HARNESS: Harness = "openclaw";

export interface HarnessInfo {
  id: Harness;
  label: string;
  /** Loopback base URL of the harness's local server/gateway. */
  baseUrl: string;
}

export const HARNESSES: Record<Harness, HarnessInfo> = {
  openclaw: {
    id: "openclaw",
    label: "OpenClaw",
    baseUrl: `http://127.0.0.1:${process.env.GATEWAY_PORT || "18789"}`,
  },
  hermes: {
    id: "hermes",
    label: "Hermes",
    // `hermes serve` defaults to 127.0.0.1:9119.
    baseUrl: `http://127.0.0.1:${process.env.HERMES_PORT || "9119"}`,
  },
};

export function isHarness(value: unknown): value is Harness {
  return value === "openclaw" || value === "hermes";
}

export async function getActiveHarness(): Promise<Harness> {
  try {
    const value = await get(HARNESS_CONFIG_KEY);
    return isHarness(value) ? value : DEFAULT_HARNESS;
  } catch {
    return DEFAULT_HARNESS;
  }
}

export async function setActiveHarness(harness: Harness): Promise<void> {
  await set(HARNESS_CONFIG_KEY, harness);
}

/**
 * Liveness probe: is the harness's local server answering at all? Any HTTP
 * response (even 401/404) proves the process is up; only a connection failure
 * or timeout counts as down. Loopback-only, short timeout so a down harness
 * doesn't stall the status route.
 */
export async function harnessHealthy(harness: Harness): Promise<boolean> {
  // Prefer a live server probe: any HTTP response means the process is up.
  try {
    const res = await fetch(`${HARNESSES[harness].baseUrl}/`, {
      signal: AbortSignal.timeout(2500),
    });
    // Drain the body we don't read so undici frees the pooled socket now.
    res.body?.cancel();
    return true;
  } catch {
    // fall through
  }
  // Hermes chat uses the `hermes -z` CLI, not the serve endpoint, so it's
  // usable whenever the binary is installed — the serve probe above is just a
  // bonus signal, not a requirement.
  if (harness === "hermes") {
    try {
      return fs.existsSync(HERMES_BIN);
    } catch {
      return false;
    }
  }
  return false;
}
