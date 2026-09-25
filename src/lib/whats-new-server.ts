/**
 * The "What's new in 4.1" card (TASK-1059, TASK-1195) — the server half: the running
 * version, the dismissal on record, and what the plan on record already covers.
 *
 * SERVER ONLY: it reads package.json, `data/config.json` and the edition lock.
 * The constants and the wire shape are in `@/lib/whats-new`, which the card
 * imports.
 */

import { readFile } from "fs/promises";
import path from "@/lib/runtime-path";
import { CONFIG_ROOT, get, set } from "@/lib/config-store";
import { readEditionSource, type EditionSource } from "@/lib/edition-source";
import { readSwapPlan, swapAllowed, swapTargetFor } from "@/lib/harness-swap";
import { planGateFor } from "@/lib/paid-plan-gate";
import {
  isWhatsNewVersion,
  WHATS_NEW_RELEASE,
  type WhatsNewPlanCta,
  type WhatsNewState,
} from "@/lib/whats-new";

/**
 * The config-store key holding the release whose card the owner dismissed
 * (`"4.1"`). In the box's store rather than the browser's, so the card does not
 * come back on another browser or device. A box that dismissed the 4.0 card
 * still holds `"4.0"` here, which does not match, so it is shown the 4.1 card.
 */
export const WHATS_NEW_DISMISSED_KEY = "whats_new_dismissed";

/**
 * The running ClawBox version: the checkout's package.json, which the updater's
 * git sync rewrites, so it names the release on disk. This is the same file
 * the updater reads for the "Update available" card. Falls back to the version
 * baked in at build time, then to null.
 */
export async function readRunningVersion(): Promise<string | null> {
  try {
    const raw = await readFile(path.join(CONFIG_ROOT, "package.json"), "utf-8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof version === "string" && version.trim()) return version.trim();
  } catch {
    // Unreadable or not JSON: fall through to the build-time value.
  }
  return process.env.NEXT_PUBLIC_APP_VERSION?.trim() || null;
}

/**
 * HOOK: a free-month code the portal has issued for this box.
 *
 * The brief asked for a free month to be offered on the card when the portal
 * issues one. The portal does not publish one today. Neither the device-info
 * lookup (`DeviceInfoResponse` in `clawbox-ai-portal-tier.ts`: `tier`,
 * `deviceTier`, `allowedModels`) nor the heartbeat (`boxTunnel` in
 * `portal-heartbeat.ts`) carries such a field. So this answers null, the route
 * passes that through as `freeMonthCode`, and the card draws nothing for it.
 * When the portal ships the field, read it here and give it a line in
 * `WhatsNewCard`.
 */
export async function readFreeMonthCode(): Promise<string | null> {
  return null;
}

/**
 * What the plan section should offer, from the plan on record.
 *
 * These are the same predicates the features' own gates use, so the card never
 * upsells something the box could already switch on. The Coding Agent and
 * Memory Shard use the paid-plan gate (Pro or Max). The edition switch uses
 * the Harness card's own `swapAllowed` (Max).
 */
async function readPlanCta(source: EditionSource): Promise<WhatsNewPlanCta> {
  const plan = await readSwapPlan();
  const target = swapTargetFor(source);
  return {
    paidFeatures: !planGateFor(plan.tier).satisfied,
    editionSwitch: target !== null && !swapAllowed(plan) ? target : null,
  };
}

/** `GET /setup-api/whats-new`. */
export async function readWhatsNewState(): Promise<WhatsNewState> {
  // Read once, so the wording and the switch on offer describe the same lock.
  const source = readEditionSource();
  const [version, dismissed, cta, freeMonthCode] = await Promise.all([
    readRunningVersion(),
    get(WHATS_NEW_DISMISSED_KEY),
    readPlanCta(source),
    readFreeMonthCode(),
  ]);
  return {
    show: isWhatsNewVersion(version) && dismissed !== WHATS_NEW_RELEASE,
    release: WHATS_NEW_RELEASE,
    version,
    edition: source.edition,
    cta,
    freeMonthCode,
  };
}

/** Record the owner's dismissal of this release's card. */
export async function dismissWhatsNew(): Promise<void> {
  await set(WHATS_NEW_DISMISSED_KEY, WHATS_NEW_RELEASE);
}
