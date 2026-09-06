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
import { getKnown, swap } from "@/lib/config-store";
import { envPort } from "@/lib/port-probe";
import { verifyDualLicense } from "@/lib/edition-license";
import { readEdition, readEditionSource, type EditionSource } from "@/lib/edition-source";

export type Harness = "openclaw" | "hermes";

// Where the Hermes CLI lives — the single source of truth (the chat route
// imports this rather than re-deriving it).
export const HERMES_BIN =
  process.env.HERMES_BIN || path.join(process.env.HOME || "/home/clawbox", ".local", "bin", "hermes");

export const HARNESS_CONFIG_KEY = "active_harness";
export const DEFAULT_HARNESS: Harness = "openclaw";

// ── Edition lock ─────────────────────────────────────────────────────────────
//
// A ClawBox image ships as one of three editions, baked at install time into a
// root-owned systemd EnvironmentFile (NOT the user-writable config.json), so a
// customer can't flip it:
//   - "openclaw" | "hermes": single-harness. The device runs exactly that agent,
//     the Settings switcher is hidden, and /harness/select is refused. The other
//     harness's runtime isn't even installed, so there is nothing to switch to.
//   - "dual": both harnesses installed + the runtime switcher enabled. This is a
//     PREMIUM feature: it only actually unlocks with a valid signed license (see
//     verifyDualLicense) — a customer can't enable dual just by setting the env,
//     because the switcher stays disabled until a license we signed verifies.
export type Edition = Harness | "dual";

/** The build/install edition. Defaults to the native product edition,
 *  "openclaw" (single, locked) — "dual" is premium and must be selected AND
 *  licensed; "hermes" is its own SKU.
 *
 *  Delegates to readEdition(), which reads the ROOT-OWNED
 *  /etc/clawbox/edition.env and only falls back to process.env when that file
 *  doesn't exist (dev boxes, CI). Reading the env directly was not a lock:
 *  clawbox-setup.service loads the clawbox-writable
 *  /home/clawbox/clawbox/.env, and systemd lets EnvironmentFile= override
 *  Environment=, so a customer with shell could set CLAWBOX_EDITION=dual and
 *  restart the service. */
export function getEdition(): Edition {
  return readEdition();
}

/** {@link getEdition}, plus whether anything on this device actually said so. */
export function getEditionSource(): EditionSource {
  return readEditionSource();
}

/**
 * True when the dual/switcher feature is active: edition "dual" AND a valid
 * license we signed.
 *
 * Fails CLOSED. The previous form was
 * `isDualLicenseEnforced() ? verifyDualLicense() : true`, i.e. "no verification
 * key ⇒ unlocked" — so anything that emptied the key (it used to be
 * env-overridable) handed out the premium SKU for free. A missing or unusable
 * trust anchor means we cannot verify a licence, which is a reason to stay
 * locked, never to open up. verifyDualLicense() already returns false when no
 * key is configured, so this is the whole check.
 */
export function isDualUnlocked(): boolean {
  if (getEdition() !== "dual") return false;
  return verifyDualLicense();
}

/** True when the device is pinned to a single harness (switcher disabled) —
 *  either a single-harness edition, or "dual" without a valid license. */
export function isSingleHarnessEdition(): boolean {
  return !isDualUnlocked();
}

/** The harness this device is locked to, or null when the switcher is unlocked.
 *  A single edition locks to itself; "dual" without a license degrades to the
 *  default harness rather than exposing a switcher. */
export function lockedHarness(): Harness | null {
  if (isDualUnlocked()) return null;
  const e = getEdition();
  return e === "hermes" ? "hermes" : e === "openclaw" ? "openclaw" : DEFAULT_HARNESS;
}

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
    baseUrl: `http://127.0.0.1:${envPort(process.env.GATEWAY_PORT, 18789)}`,
  },
  hermes: {
    id: "hermes",
    label: "Hermes",
    // `hermes serve` defaults to 127.0.0.1:9119. Validated, like the gateway's
    // baseUrl above and hermes-dashboard-auth's DASHBOARD_PORT: `|| "9119"` on
    // the raw string catches "" and unset, but a malformed or out-of-range
    // HERMES_PORT would sail through into a baseUrl that fails every call
    // rather than falling back to the default the line promises.
    baseUrl: `http://127.0.0.1:${envPort(process.env.HERMES_PORT, 9119)}`,
  },
};

export function isHarness(value: unknown): value is Harness {
  return value === "openclaw" || value === "hermes";
}

/** {@link getActiveHarness}, plus whether the device actually RESOLVED it. */
export interface ActiveHarnessSource {
  active: Harness;
  /**
   * True when `active` is this module's `DEFAULT_HARNESS` because nothing on
   * the device could answer — NOT because the device answered "openclaw".
   *
   * The two ways that happens are the two reads behind the value. An edition
   * nobody named makes `lockedHarness()` itself a guess: it reads
   * `getEdition()`, which is `readEditionSource()`'s own "openclaw" default
   * there, so on a Hermes box with an unreadable lock this function can only
   * say "openclaw". And on the one SKU the edition deliberately leaves open —
   * an unlocked, licensed `dual` — the answer comes from `data/config.json`,
   * which a `sudo` script can leave root-owned; the forgiving reader answers
   * `undefined` to that exactly as it does to a box that has never switched.
   *
   * An ABSENT key is not a doubt: a `dual` box nobody has switched genuinely
   * runs the default harness, which is why this asks `getKnown` rather than
   * treating "no value" as "could not look". A stored value that is not a
   * harness is the same case — `setActiveHarness` only ever writes a real one.
   *
   * Callers that BRAND the device read this; callers that merely route to a
   * harness take `active` and are right either way.
   */
  defaulted: boolean;
}

export async function getActiveHarnessSource(): Promise<ActiveHarnessSource> {
  if (readEditionSource().defaulted) return { active: DEFAULT_HARNESS, defaulted: true };
  // A locked (single-harness / unlicensed-dual) device ignores the stored value
  // entirely — the edition is the source of truth, so editing config.json can't
  // change which agent runs.
  const locked = lockedHarness();
  if (locked) return { active: locked, defaulted: false };
  const { value, known } = await getKnown(HARNESS_CONFIG_KEY);
  if (!known) return { active: DEFAULT_HARNESS, defaulted: true };
  return { active: isHarness(value) ? value : DEFAULT_HARNESS, defaulted: false };
}

export async function getActiveHarness(): Promise<Harness> {
  return (await getActiveHarnessSource()).active;
}

/**
 * Make `harness` the active one, and answer with THE ONE IT REPLACED.
 *
 * The predecessor comes back from the write rather than from a read the caller
 * made earlier, because the caller's question — did this actually change
 * anything — can only be answered by the write itself. `/setup-api/harness/select`
 * used to read it before an identity sync with a 60 s budget, so two switches in
 * opposite directions both saw the same predecessor: the second persisted its
 * harness and then concluded nothing had moved, leaving the box on one harness
 * with the agent's whole tool list built for the other.
 */
export async function setActiveHarness(harness: Harness): Promise<Harness> {
  // Refuse to persist a switch on a locked device (defense-in-depth — the
  // /harness/select route also rejects, and the UI hides the switcher).
  if (isSingleHarnessEdition()) {
    throw new Error("Harness switching is disabled on this edition");
  }
  const previous = await swap(HARNESS_CONFIG_KEY, harness);
  // A store that has never held one, or holds something that is not a harness,
  // reads as the default — the same answer `getActiveHarness` gives it. Not
  // locked: `isSingleHarnessEdition()` above is the same test `lockedHarness()`
  // makes, so the edition cannot be overriding the stored value here.
  return isHarness(previous) ? previous : DEFAULT_HARNESS;
}

/**
 * Liveness probe: is the harness's local server answering at all? Any HTTP
 * response (even 401/404) proves the process is up; only a connection failure
 * or timeout counts as down. Loopback-only, short timeout so a down harness
 * doesn't stall the status route.
 *
 * The probe is retried a couple of times before giving up: on a loaded Jetson
 * a single 2.5 s timeout produces false negatives — most visibly right after a
 * harness switch, where the just-finished identity sync momentarily starves the
 * event loop and the still-running gateway fails to answer in time, which would
 * otherwise report a healthy harness as "not available" and block switching
 * back to it. A genuinely down harness still fails every attempt.
 */
const HEALTH_PROBE_ATTEMPTS = 3;
const HEALTH_PROBE_TIMEOUT_MS = 2500;
const HEALTH_PROBE_RETRY_GAP_MS = 250;

export async function harnessHealthy(harness: Harness): Promise<boolean> {
  // Prefer a live server probe: any HTTP response means the process is up.
  for (let attempt = 0; attempt < HEALTH_PROBE_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${HARNESSES[harness].baseUrl}/`, {
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });
      // Drain the body we don't read so undici frees the pooled socket now.
      res.body?.cancel();
      return true;
    } catch {
      // Transient timeout/refusal under load — retry a couple of times before
      // falling through to the per-harness fallback / "down" verdict.
      if (attempt < HEALTH_PROBE_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, HEALTH_PROBE_RETRY_GAP_MS));
      }
    }
  }
  // Hermes chat uses the `hermes -z` CLI, not the serve endpoint, so it's
  // usable whenever the binary is installed — the serve probe above is just a
  // bonus signal, not a requirement.
  if (harness === "hermes") {
    // Chat uses the `hermes` CLI, so Hermes is usable when the binary is present
    // AND executable (existsSync alone would accept a non-executable file).
    try {
      fs.accessSync(HERMES_BIN, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
